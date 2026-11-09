// PC, RM-3: the real child process of the nightly profile suite, in a scratch project with a stub
// Playwright and a real server, through the engine's real process runner.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { tryTake } from '../../../engine/lock.mjs';
import { realIo } from '../../../engine/nightly/io.mjs';
import { reactProfile } from '../../profiler/nightly.mjs';
import { REPO, makeProject, traces } from './__tests__/profile-project.mjs';

const kids = [];
const servers = [];
// The scratch project is removed before this hook runs, so a server is remembered by pid as soon as it has run.
after(() => {
  for (const k of kids) k.kill('SIGKILL');
  for (const pid of servers)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
});
const rememberServer = (dir) => {
  try {
    servers.push(Number(readFileSync(join(dir, 'server.pid'), 'utf8')));
  } catch {
    // the server never started
  }
};

const OPTS = { config: 'profile.config.mjs', runs: 1, scenarios: 'all', keepTraces: 3 };
const SERVER = `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
writeFileSync('server.pid', String(process.pid));
createServer((_q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`;

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const portUp = (port) =>
  new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => (s.destroy(), resolve(false)));
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const until = async (cond, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end && !(await cond()); )
    await new Promise((r) => setTimeout(r, 100));
};

/** A scratch project whose build touches `built` and whose preview server is a real node process. */
async function project(over = {}) {
  const port = await freePort();
  const p = makeProject({
    appUp: false,
    build: { command: 'touch built', start: 'node server.mjs', port, env: { PORT: String(port) } },
    ...over,
  });
  p.write('server.mjs', SERVER);
  return { ...p, port };
}

const runIn = async ({ dir, limitS = 60, env = {}, options = OPTS }) => {
  const out = join(mkdtempSync(join(tmpdir(), 'profile-night-')), 'profile', 'aaaaaaaaaaaa-2026-01-15');
  try {
    const res = await reactProfile(options).run({ wt: dir, io: realIo(), args: [], limitS, env, dir: out });
    return { res, out };
  } finally {
    rememberServer(dir);
  }
};

test('PC-1 a real child writes results, traces and numbers', async () => {
  const { dir } = await project();
  const { res, out } = await runIn({ dir });
  assert.equal(res.timedOut, false);
  assert.equal(res.summary.stats.unexpected, 0, JSON.stringify(res.report));
  assert.ok(existsSync(join(dir, 'built')), 'the build ran in the worktree');
  const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
  assert.ok(results.summary.home, 'results.json holds the profiler summary');
  assert.ok(existsSync(join(out, 'traces')), 'the traces are in the run directory');
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'numbers.json'), 'utf8')).medians, { home: 3 });
  assert.deepEqual(res.extra.medians, { home: 3 });
});

test('PC-2 the child takes no lock while another owner holds it', async () => {
  const { dir } = await project({ lock: 'profile:web' });
  const path = join(mkdtempSync(join(tmpdir(), 'profile-lock-')), 'stack.lock');
  const holder = spawn('sleep', ['60'], { stdio: 'ignore' });
  kids.push(holder);
  tryTake(path, { owner: 'verify:ticket', cwd: '/work/holder', pid: holder.pid, env: {} });
  const { res } = await runIn({ dir, env: { TICKET_GATE_STACK_LOCK_PATH: path } });
  assert.equal(res.summary.stats.unexpected, 0, JSON.stringify(res.extra));
  assert.deepEqual(Object.keys(res.extra.medians), ['home']);
});

test('PC-3 cut short at the limit stops the server and frees the port', { timeout: 60_000 }, async () => {
  const { dir, port, write } = await project();
  write(
    'profile.config.mjs',
    readFileSync(join(dir, 'profile.config.mjs'), 'utf8').replace(
      'scenarios: { home: async () => async () => {} }',
      'scenarios: { home: async () => () => new Promise((r) => setTimeout(r, 600_000)) }',
    ),
  );
  const { res } = await runIn({ dir, limitS: 3 });
  assert.equal(res.timedOut, true);
  assert.equal(res.extra.noNumbers, 'cut-short');
  const pid = Number(readFileSync(join(dir, 'server.pid'), 'utf8'));
  await until(async () => !(await portUp(port)) && !alive(pid));
  assert.equal(await portUp(port), false, 'the port answers no more');
  assert.equal(alive(pid), false, 'the server process is gone');
});

test('PC-5 a server that ignores SIGTERM is gone after a cut-short', { timeout: 60_000 }, async () => {
  const { dir, port, write } = await project();
  write('server.mjs', `process.on('SIGTERM', () => {});\n${SERVER}`);
  write(
    'profile.config.mjs',
    readFileSync(join(dir, 'profile.config.mjs'), 'utf8').replace(
      'scenarios: { home: async () => async () => {} }',
      'scenarios: { home: async () => () => new Promise((r) => setTimeout(r, 600_000)) }',
    ),
  );
  const { res } = await runIn({ dir, limitS: 3 });
  assert.equal(res.timedOut, true);
  const pid = Number(readFileSync(join(dir, 'server.pid'), 'utf8'));
  await until(async () => !(await portUp(port)) && !alive(pid), 20_000);
  assert.equal(alive(pid), false, 'the server process is gone');
  assert.equal(await portUp(port), false, 'the port answers no more');
});

test('PC-4 a handle the config leaves open does not hold the suite', { timeout: 60_000 }, async () => {
  const { dir, write } = await project();
  write(
    'profile.config.mjs',
    `setInterval(() => {}, 1000);\n${readFileSync(join(dir, 'profile.config.mjs'), 'utf8')}`,
  );
  const { res } = await runIn({ dir, limitS: 20 });
  assert.equal(res.timedOut, false);
  assert.equal(res.summary.stats.unexpected, 0, JSON.stringify(res.extra));
});

/** The example block under the README's "Profiling every night". */
function readmeBlock() {
  const text = readFileSync(join(REPO, 'packages/react/README.md'), 'utf8');
  const section = text.slice(text.indexOf('## Profiling every night'));
  const m = /```js\n([\s\S]*?)```/.exec(section);
  assert.ok(m, 'the README holds the nightly example');
  return m[1];
}

test('RM-3 the README example runs and goes red on a mangled trace', { timeout: 60_000 }, async () => {
  const { dir, write } = await project({ trace: traces.mangled, links: true });
  write('nightly.suite.mjs', readmeBlock());
  const { suite } = await import(join(dir, 'nightly.suite.mjs'));
  assert.equal(suite.name, 'profile');
  assert.deepEqual(suite.keep, suite.runner.keep);
  const out = join(mkdtempSync(join(tmpdir(), 'profile-night-')), 'profile', 'aaaaaaaaaaaa-2026-01-15');
  let res;
  try {
    res = await suite.runner.run({ wt: dir, io: realIo(), args: [], limitS: 60, env: {}, dir: out });
  } finally {
    rememberServer(dir);
  }
  assert.equal(res.summary.stats.unexpected, 1);
  assert.match(res.extra.noNumbers, /component names are mangled/);
  const line = suite.runner.statusLine({ status: 'red', reason: 'failed', extra: res.extra });
  assert.match(line, /^nightly profile: red \(no numbers: .*component names are mangled/);
});
