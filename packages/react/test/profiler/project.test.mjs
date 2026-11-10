// The profiler end to end in a scratch project: a stub Playwright writes the trace, so the real
// run loop, guards, lock and server handling run with no browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { tryTake } from '../../../engine/lock.mjs';
import { BIN, REPO, makeProject, runProfile, traces } from './__tests__/profile-project.mjs';

const kids = [];
after(() => kids.forEach((k) => k.kill('SIGKILL')));

const resultsOf = (dir) => {
  const out = join(dir, 'profile-out');
  const f = readdirSync(out).find((n) => /^results-\d+\.json$/.test(n));
  return JSON.parse(readFileSync(join(out, f), 'utf8'));
};

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

/** A live holder of the stack lock at a scratch path; returns the env that points a child at it. */
function heldLock() {
  const path = join(mkdtempSync(join(tmpdir(), 'profile-lock-')), 'stack.lock');
  const holder = spawn('sleep', ['60'], { stdio: 'ignore' });
  kids.push(holder);
  tryTake(path, { owner: 'verify:ticket', cwd: '/work/holder', pid: holder.pid, env: {} });
  return { env: { TICKET_GATE_STACK_LOCK_PATH: path }, pid: holder.pid };
}

test('PF-1 a synthetic trace reduces to the expected counts', () => {
  const { dir } = makeProject();
  const r = runProfile(dir, ['--runs=1']);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(resultsOf(dir).summary.home, {
    commits: 2,
    totalRenderMs: 11,
    renderMs: 9,
    commitMs: 2,
    slowestCommitMs: 6,
    Card: 2,
    List: 1,
    componentRendersAll: 4,
  });
});

test('PF-2 the noCommit guard fires on a trace with no Commit', () => {
  const { dir } = makeProject({ trace: traces.noCommit });
  const r = runProfile(dir, ['--runs=1']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /no React Commit in the trace/);
  assert.match(r.stderr, /demo build/);
});

test('PF-3 the mangled guard fires on a trace with only mangled names', () => {
  const { dir } = makeProject({ trace: traces.mangled });
  const r = runProfile(dir, ['--runs=1']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /component names are mangled/);
  assert.match(r.stderr, /esbuild\.keepNames/);
});

test('PF-4 lock false runs while another owner holds the lock', () => {
  const { dir } = makeProject({ lock: false });
  const held = heldLock();
  const r = runProfile(dir, ['--runs=1'], held.env);
  assert.equal(r.status, 0, r.out);
});

test('PF-5 a lock owner exits 1 naming the holder (public VL-6)', () => {
  const { dir } = makeProject({ lock: 'profile:web' });
  const held = heldLock();
  const r = runProfile(dir, ['--runs=1'], held.env);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /profile:web: stack lock held/);
  assert.match(r.out, /verify:ticket/);
  assert.match(r.out, new RegExp(`pid ${held.pid}\\b`));
});

test('PF-6 --build serves through serve and frees the port', async () => {
  const port = await freePort();
  const { dir, write } = makeProject({
    appUp: false,
    build: {
      command: 'touch built',
      start: 'node server.mjs',
      port,
      env: { PORT: String(port) },
      unmangle: 'x',
      noBuildLabel: 'x',
    },
  });
  write(
    'server.mjs',
    `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
writeFileSync('server.pid', String(process.pid));
createServer((_q, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`,
  );
  const r = runProfile(dir, ['--build', '--runs=1']);
  try {
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(join(dir, 'built')), 'the build ran');
    assert.equal(resultsOf(dir).meta.buildFlags, 'touch built');
    const up = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(1000),
    }).then(
      () => true,
      () => false,
    );
    assert.equal(up, false, 'the served app does not outlive the run');
  } finally {
    try {
      process.kill(Number(readFileSync(join(dir, 'server.pid'), 'utf8')), 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

/** The two example blocks under the README's "Profiling a React app", in order. */
function readmeBlocks() {
  const text = readFileSync(join(REPO, 'packages/react/README.md'), 'utf8');
  const section = text.slice(text.indexOf('## Profiling a React app'));
  return [...section.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** The README blocks written into a scratch project, the example port swapped for `port`. */
function readmeProject(port, scripts = {}) {
  const [profileConfig, gateConfig] = readmeBlocks();
  assert.ok(profileConfig && gateConfig, 'the README holds both example blocks');
  const { dir, write } = makeProject({ trace: traces.noCommit, links: true });
  // viteProfiling fixes the preview port at 4173; the scratch run moves it to a free one.
  const viteCall = /viteProfiling\(\{[^}]*\}\)/.exec(profileConfig)?.[0];
  assert.ok(viteCall, 'the README example calls viteProfiling');
  write(
    'profile.config.mjs',
    profileConfig
      .replace(viteCall, `{ ...${viteCall}, port: ${port} }`)
      .replaceAll('4173', String(port)),
  );
  write('gate.config.mjs', gateConfig);
  write(
    'package.json',
    JSON.stringify({ name: 'scratch', private: true, type: 'module', scripts }),
  );
  return { dir, write };
}

test('RM-1 the README example runs and fails on a noCommit trace', async () => {
  const port = await freePort();
  const { dir } = readmeProject(port);
  // A child process answers: runProfile blocks this one's event loop.
  const app = spawn(
    process.execPath,
    [
      '-e',
      `require('node:http').createServer((_q, r) => r.end('ok')).listen(${port}, '127.0.0.1')`,
    ],
    { stdio: 'ignore' },
  );
  kids.push(app);
  while (!(await portUp(port))) await new Promise((r) => setTimeout(r, 50));
  const r = runProfile(dir, ['profile', '--runs=1'], {}, [BIN]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /no React Commit/);
});

test('RM-2 the README example with --build reaches the build', async () => {
  const port = await freePort();
  const { dir, write } = readmeProject(port, {
    build: 'node build.mjs',
    preview: 'node server.mjs',
  });
  write('build.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync('built', 'x');\n");
  write(
    'server.mjs',
    `import { createServer } from 'node:http';
createServer((_q, r) => r.end('ok')).listen(${port}, '127.0.0.1');
`,
  );
  const r = runProfile(dir, ['profile', '--build', '--runs=1'], {}, [BIN]);
  assert.doesNotMatch(r.stderr, /in use/, r.out);
  assert.ok(existsSync(join(dir, 'built')), `the build ran: ${r.out}`);
});
