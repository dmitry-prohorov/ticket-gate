// serve(): refuse a busy port, build, start, wait until the port answers. Real `node` servers on
// ephemeral ports in a scratch directory; no network beyond loopback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LIMITS } from '../mutations/verdict.mjs';
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
    // The handed stop itself frees the port; the returned one is only idempotent cleanup, so a
    // failing handed stop cannot leak the detached server.
    await handed();
    assert.equal(await portInUse(port), false, 'the handed stop frees the port');
  } finally {
    await stop();
  }
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('SV-6 a build past its limit rejects at the limit', async () => {
  const port = await freePort();
  const pidFile = join(dir, 'sv6.pid');
  const hang = join(dir, 'sv6-hang.cjs');
  writeFileSync(
    hang,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const was = LIMITS.webBuild;
  LIMITS.webBuild = 1;
  const t0 = Date.now();
  try {
    // A compound command: bash cannot exec the worker, so killing bash alone would not stop it.
    await assert.rejects(
      serve({ build: `(node ${q(hang)}); true`, start: 'true', port }),
      /timed out after 1 s/,
    );
    assert.ok(Date.now() - t0 < 3000, `rejected at the limit, took ${Date.now() - t0} ms`);
  } finally {
    LIMITS.webBuild = was;
  }
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  const gone = !alive(pid);
  // A survivor would keep this process alive for good: reap it before asserting.
  if (!gone) process.kill(pid, 'SIGKILL');
  assert.equal(gone, true, 'the build worker is gone');
});

test('SV-7 a build that ignores SIGINT is gone after one', async () => {
  const port = await freePort();
  const pidFile = join(dir, 'sv7.pid');
  const worker = join(dir, 'sv7-worker.cjs');
  writeFileSync(
    worker,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGINT', () => {});
setInterval(() => {}, 1000);
`,
  );
  const runner = join(dir, 'sv7-run.mjs');
  const serveUrl = new URL('../serve.mjs', import.meta.url).href;
  writeFileSync(
    runner,
    `import { serve } from ${JSON.stringify(serveUrl)};
await serve({ build: ${JSON.stringify(`(trap "" INT; node ${q(worker)}); true`)}, start: 'true', port: ${port} }).catch(() => {});
`,
  );
  const child = spawn(process.execPath, [runner], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let pid = 0;
  try {
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(pidFile), 'the build started');
    pid = Number(readFileSync(pidFile, 'utf8'));
    child.kill('SIGINT');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('hung'), 9000))]);
    assert.equal(code, 130, 'the run exits with 130 within the bound');
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid), false, 'the build that ignored SIGINT is gone');
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
