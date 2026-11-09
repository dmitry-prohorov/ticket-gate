// serve(): refuse a busy port, build, start, wait until the port answers. Real `node` servers on
// ephemeral ports in a scratch directory; no network beyond loopback.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { portInUse, serve } from '../serve.mjs';

const dir = mkdtempSync(join(tmpdir(), 'serve-test-'));
const q = (s) => `'${s}'`;

function freePort() {
  return new Promise((resolve) => {
    const s = netServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function serverScript(name, delayMs = 0) {
  const file = join(dir, name);
  writeFileSync(
    file,
    `const http = require('node:http');
setTimeout(() => http.createServer((_q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1'), ${delayMs});
setInterval(() => {}, 1000);
`,
  );
  return file;
}

test('SV-1 builds, serves and stops', async () => {
  const port = await freePort();
  const marker = join(dir, 'sv1-built');
  const env = { PORT: String(port) };
  const { stop } = await serve({
    build: `touch ${q(marker)}`,
    start: `node ${q(serverScript('sv1.cjs'))}`,
    port,
    env,
  });
  try {
    assert.ok(existsSync(marker), 'the build ran');
    assert.equal(await portInUse(port), true, 'the port answers after serve()');
  } finally {
    await stop();
  }
  assert.equal(await portInUse(port), false, 'the port is free after stop()');
});

test('SV-2 a busy port refuses before the build', async () => {
  const busy = createServer((_q, r) => r.end('x'));
  await new Promise((r) => busy.listen(0, '127.0.0.1', r));
  const { port } = busy.address();
  const marker = join(dir, 'sv2-built');
  try {
    await assert.rejects(
      serve({ build: `touch ${q(marker)}`, start: 'true', port }),
      /port \d+ is already in use/,
    );
    assert.equal(existsSync(marker), false, 'the build did not run');
  } finally {
    await new Promise((r) => busy.close(r));
  }
});

test('SV-3 a failed build rejects with its output and starts nothing', async () => {
  const port = await freePort();
  const started = join(dir, 'sv3-started');
  await assert.rejects(
    serve({
      build: 'echo boom-from-build >&2; exit 4',
      start: `touch ${q(started)}`,
      port,
    }),
    /boom-from-build/,
  );
  assert.equal(existsSync(started), false, 'the server was not started');
});

test('SV-4 a server that exits before answering rejects', async () => {
  const port = await freePort();
  await assert.rejects(
    serve({ build: 'true', start: 'exit 3', port }),
    /server did not start/,
  );
});

test('SV-5 onSpawn hands over stop before the port answers', async () => {
  const port = await freePort();
  const env = { PORT: String(port) };
  let handed;
  let answeredAtSpawn;
  const run = serve(
    { build: 'true', start: `node ${q(serverScript('sv5.cjs', 1500))}`, port, env },
    {
      onSpawn: (stop) => {
        handed = stop;
        portInUse(port).then((up) => (answeredAtSpawn = up));
      },
    },
  );
  const { stop } = await run;
  try {
    assert.equal(typeof handed, 'function', 'onSpawn ran before serve resolved');
    assert.equal(answeredAtSpawn, false, 'the port did not answer when onSpawn ran');
    assert.equal(await portInUse(port), true);
  } finally {
    await stop();
  }
  await handed();
  assert.equal(await portInUse(port), false, 'the handed stop frees the port');
});
