// Run by `pnpm test:tools`. Function cases inject fakes (no shell, pnpm or
// stack); CLI cases spawn the script in a throwaway repo under os.tmpdir() with
// plain shell test commands, so nothing touches this repo.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { DEMO, demoSetup } from './__tests__/demo.fixture.mjs';
import { exec, realIo } from '../../mutations/exec.mjs';
import {
  exitCodeFor,
  interruptHandler,
  needsCoreBuild,
  runMutations,
} from '../../mutations/run.mjs';
import { validateSpec } from '../../mutations/validate.mjs';
import {
  dirs,
  committedEntries,
  SRC,
  ORIGINAL,
  FIND,
  repo,
  patch,
  scratch,
  sql,
  world,
  bites,
  green,
  whileMutated,
  V_NOMATCH,
  V_NOFILE,
  V_OK,
} from './__tests__/mutate-check.helpers.mjs';

test('patch mutation whose fake test fails -> killed, file bytes identical afterwards', async () => {
  const w = world(bites());
  const r = await runMutations({ mutations: [patch('M1')] }, w.io);
  assert.equal(r.results[0].status, 'killed');
  assert.equal(r.ok, true);
  assert.equal(w.file, ORIGINAL);
  // The mutant really was on disk while the test ran.
  assert.ok(!w.seenDuringTest[1].includes(FIND));
  assert.ok(w.seenDuringTest[1].includes('after $& $1'));
});

test('patch mutation whose fake test passes -> survived, ok false, exit 1', async () => {
  const w = world(green);
  const r = await runMutations({ mutations: [patch('M1')] }, w.io);
  assert.equal(r.results[0].status, 'survived');
  assert.equal(r.ok, false);
  assert.equal(w.file, ORIGINAL);

  // CLI: same case end to end, exit code 1 and an ok:false receipt.
  const dir = repo();
  writeFileSync(join(dir, 'm.json'), scratch([patch('M1', { test: 'true' })]));
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stdout, /mutate:check T: 0\/1 killed, 1 survived, 0 error/);
  const receipt = JSON.parse(
    readFileSync(join(dir, '.turbo/mutation-check.json'), 'utf8'),
  );
  assert.equal(receipt.ok, false);
});

test('find occurring twice -> validation error, exit 2, nothing applied', () => {
  const twice = `${ORIGINAL}${FIND}\n`;
  const errs = validateSpec({ mutations: [patch('M1')] }, () => twice);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /occurs 2 times/);

  const dir = repo(twice);
  writeFileSync(
    join(dir, 'm.json'),
    scratch([patch('M1', { test: 'touch ran' })]),
  );
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(p.status, 2, p.stdout + p.stderr);
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), twice);
  assert.throws(() => readFileSync(join(dir, 'ran')), /ENOENT/);
});

test('find occurring zero times -> validation error', () => {
  const errs = validateSpec(
    { mutations: [patch('M1', { find: 'gone' })] },
    () => ORIGINAL,
  );
  assert.equal(errs.length, 1);
  assert.match(errs[0], /occurs 0 times/);
});

test('fake test throwing mid-run -> file still restored', async () => {
  let calls = 0;
  const w = world(() => {
    if (calls++ === 0) return { code: 0, out: 'ok' };
    throw new Error('boom');
  });
  const r = await runMutations({ mutations: [patch('M1')] }, w.io);
  assert.equal(w.file, ORIGINAL);
  assert.equal(r.results[0].status, 'error');
  assert.equal(r.ok, false);
});

test('MC-1 two sql mutations: no reset between them, one lean reset at the end, no re-run', async () => {
  const w = world(whileMutated);
  const r = await runMutations({ mutations: [sql('M1'), sql('M2')] }, w.io);
  assert.deepEqual(
    w.log.filter((l) => l.startsWith("sql:select 'M") || l === 'reset'),
    ["sql:select 'M1';", "sql:select 'M2';", 'reset'],
  );
  const lastRun = w.log.map((l) => l.startsWith('run:')).lastIndexOf(true);
  assert.equal(w.log.indexOf('reset') > lastRun, true);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['killed', 'killed'],
  );
  assert.equal(r.rerun, 0);
  assert.equal(r.fatal, undefined);
  assert.equal(r.ok, true);
});

test('red baseline -> error, never killed', async () => {
  const w = world(() => ({ code: 1, out: 'already red' }));
  const r = await runMutations({ mutations: [patch('M1'), patch('M2')] }, w.io);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['error', 'error'],
  );
  assert.match(r.results[0].detail, /red before mutation/);
  assert.equal(r.ok, false);
  // Baseline ran once for the shared command; nothing was mutated.
  assert.equal(w.log.filter((l) => l.startsWith('run:')).length, 1);
  assert.equal(w.file, ORIGINAL);
});

test('--only=M1 -> partial true, ok false', async () => {
  const w = world(bites());
  const spec = {
    mutations: [patch('M1', { test: 'a' }), patch('M2', { test: 'b' })],
  };
  const r = await runMutations(spec, { ...w.io, only: ['M1'] });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'killed');
  assert.equal(r.partial, true);
  assert.equal(r.ok, false);
});

test('receipt treeHash equals treeHash() of the restored tree', () => {
  const dir = repo();
  writeFileSync(
    join(dir, 'm.json'),
    scratch([patch('M1', { test: `grep -qF "${FIND}" ${SRC}` })]),
  );
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const receipt = JSON.parse(
    readFileSync(join(dir, '.turbo/mutation-check.json'), 'utf8'),
  );
  const now = execFileSync(
    'node',
    [
      '-e',
      "import('./tools/tree-hash.mjs').then((m) => process.stdout.write(m.treeHash()))",
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(receipt.treeHash, now);
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), ORIGINAL);
});

test('receipt records the scratch source and the entries digest, no file or specSha256', () => {
  const dir = repo();
  writeFileSync(
    join(dir, 'm.json'),
    scratch([patch('M1', { test: `grep -qF "${FIND}" ${SRC}` })]),
  );
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const receipt = JSON.parse(
    readFileSync(join(dir, '.turbo/mutation-check.json'), 'utf8'),
  );
  assert.equal(receipt.source, 'file:m.json');
  assert.match(receipt.entriesDigest, /^[0-9a-f]{64}$/);
  assert.equal('file' in receipt, false);
  assert.equal('specSha256' in receipt, false);
});

test('SIGINT during a patched test restores the file', async () => {
  const dir = repo();
  writeFileSync(
    join(dir, 'm.json'),
    // Baseline is instant (no marker yet); the mutated run touches a marker
    // and sleeps so the signal lands mid-test.
    scratch([
      patch('M1', {
        test: `if ! grep -qF "${FIND}" ${SRC}; then touch started; sleep 30; fi`,
      }),
    ]),
  );
  const child = spawn(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json'],
    {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
    },
  );
  const exit = new Promise((res) =>
    child.on('exit', (code, sig) => res({ code, sig })),
  );
  const deadline = Date.now() + 15000;
  while (!existsSync(join(dir, 'started')) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(join(dir, 'started')), 'mutated test never started');
  process.kill(-child.pid, 'SIGINT');
  const { code, sig } = await exit;
  assert.equal(sig, null);
  assert.equal(code, 130);
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), ORIGINAL);
});

// The signal goes to the tool's pid only (no group): the child sits in its own
// group and must be stopped by the tool, not by the terminal.
async function pidAloneSignal(
  sig,
  expectedCode,
  body = 'touch started; sleep 30',
) {
  const dir = repo();
  writeFileSync(
    join(dir, 'm.json'),
    scratch([
      patch('M1', {
        test: `if ! grep -qF "${FIND}" ${SRC}; then ${body}; fi`,
      }),
    ]),
  );
  const child = spawn(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json'],
    { cwd: dir, detached: true, stdio: 'ignore' },
  );
  const exit = new Promise((res) =>
    child.on('exit', (code, s) => res({ code, sig: s })),
  );
  const deadline = Date.now() + 15000;
  while (!existsSync(join(dir, 'started')) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(join(dir, 'started')), 'mutated test never started');
  const t0 = Date.now();
  process.kill(child.pid, sig);
  let timer;
  const r = await Promise.race([
    exit,
    new Promise((res) => {
      timer = setTimeout(() => res('timeout'), 10000);
    }),
  ]);
  clearTimeout(timer);
  if (r === 'timeout') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    assert.fail(`the tool ignored ${sig} sent to its pid alone`);
  }
  assert.equal(r.sig, null);
  assert.equal(r.code, expectedCode);
  assert.ok(Date.now() - t0 < 10000);
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), ORIGINAL);
  assert.ok(!existsSync(join(dir, '.turbo', 'mutation-check.json')));
}

test('SIGTERM to the tool pid alone restores and exits 143', async () => {
  await pidAloneSignal('SIGTERM', 143);
});

test('SIGINT to the tool pid alone restores and exits 130', async () => {
  await pidAloneSignal('SIGINT', 130);
});

// A group member that lost the forwarded signal (forked, not yet exec'd) outlives
// its leader and holds the pipes open; exec must settle on the leader's exit once
// the run is interrupted, and sweep the survivor.
test('exec settles when an interrupted leader exits leaving a pipe holder', async () => {
  const state = {};
  const seen = [];
  realIo(undefined, state, async (sig) => seen.push(sig));
  const marker = join(mkdtempSync(join(tmpdir(), 'exec-sweep-')), 'pid');
  dirs.push(join(marker, '..'));
  setTimeout(() => (state.interrupted = 'SIGINT'), 200);
  const t0 = Date.now();
  const r = await exec('bash', [
    '-c',
    `sleep 30 & echo $! > ${marker}; sleep 0.5`,
  ]);
  assert.ok(Date.now() - t0 < 5000, 'exec waited for the pipe holder');
  assert.equal(r.code, 0);
  assert.deepEqual(seen, ['SIGINT']);
  const pid = Number(readFileSync(marker, 'utf8'));
  await new Promise((res) => setTimeout(res, 200));
  assert.throws(() => process.kill(pid, 0), 'the pipe holder survived');
});

// A child that swallows the forwarded signal is KILLed after the grace; the run
// still restores and exits 130.
test('a test command that ignores SIGINT is KILLed after the grace, exit 130', async () => {
  await pidAloneSignal('SIGINT', 130, 'trap "" INT; touch started; sleep 30');
});

test('MC-18 interruptHandler maps SIGTERM to 143', async () => {
  const calls = [];
  const io = {
    resetDb: () => (calls.push('reset'), { code: 0, out: '' }),
  };
  await interruptHandler(
    { sqlApplied: true },
    io,
    (c) => calls.push(`exit:${c}`),
    'SIGTERM',
  );
  assert.deepEqual(calls, ['reset', 'exit:143']);

  const c2 = [];
  await interruptHandler(
    { sqlApplied: true },
    { resetDb: () => (c2.push('reset'), { code: 0, out: '' }) },
    (c) => c2.push(`exit:${c}`),
    'SIGINT',
  );
  assert.deepEqual(c2, ['reset', 'exit:130']);

  const c3 = [];
  await interruptHandler(
    { restore: () => c3.push('restored'), sqlApplied: false },
    { resetDb: () => (c3.push('reset'), { code: 0, out: '' }) },
    (c) => c3.push(`exit:${c}`),
    'SIGTERM',
  );
  assert.deepEqual(c3, ['restored', 'exit:143']);
});

test('a test command that edits another tracked file -> exit 1, no receipt', () => {
  const dir = repo();
  writeFileSync(
    join(dir, 'm.json'),
    scratch([
      patch('M1', {
        test: `grep -qF "${FIND}" ${SRC} && echo dirty >> base.txt`,
      }),
    ]),
  );
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'],
    { cwd: dir },
  );
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b'],
    { cwd: dir },
  );
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(p.stderr, /restore left the tree changed: .*base\.txt/);
  assert.throws(
    () => readFileSync(join(dir, '.turbo/mutation-check.json')),
    /ENOENT/,
  );
});

// Captured runner outputs (vitest 3.2.7, jest 29.7.0, node 24), trimmed to the
// summary. The glyphs are the runners' own.

test('MC-15 a zero-test baseline is error and nothing is applied', async () => {
  const w = world(() => ({ code: 0, out: V_NOFILE }));
  const spec = { mutations: [patch('M1'), sql('M2')] };
  const r = await runMutations(spec, w.io);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['error', 'error'],
  );
  for (const x of r.results)
    assert.match(x.detail, /ran zero tests before the mutation \(vitest: /);
  assert.equal(w.file, ORIGINAL);
  assert.ok(!w.log.some((l) => l.startsWith('sql:')), w.log.join('\n'));
  assert.equal(r.ok, false);
  assert.equal(exitCodeFor(r), 1);
});

test('MC-16 a zero-test mutated run is error, not survived or killed', async () => {
  const zeros = [
    { code: 0, out: V_NOMATCH },
    { code: 1, out: V_NOFILE },
  ];
  for (const zero of zeros) {
    const seen = new Set();
    const t = (cmd) => {
      if (seen.has(cmd)) return zero;
      seen.add(cmd);
      return { code: 0, out: V_OK };
    };
    // patch
    const p = world(t);
    const rp = await runMutations({ mutations: [patch('M1')] }, p.io);
    assert.equal(rp.results[0].status, 'error');
    assert.match(rp.results[0].detail, /ran zero tests under the mutation/);
    assert.equal(p.file, ORIGINAL);
    // sql: the restore and the proof still run
    seen.clear();
    const q = world(t);
    const rq = await runMutations({ mutations: [sql('M1')] }, q.io);
    assert.equal(rq.results[0].status, 'error');
    assert.match(rq.results[0].detail, /ran zero tests under the mutation/);
    assert.ok(
      q.log.some((l) => l.startsWith('sql:do $mutate_check_restore$')),
      q.log.join('\n'),
    );
    assert.ok(q.log.filter((l) => l === 'digest').length >= 2);
  }
});

test('MC-17 a leading caret on -t or -g is a validation error', () => {
  const one = (test) =>
    validateSpec({ mutations: [sql('M1', test)] }, () => ORIGINAL);
  for (const t of [
    "pnpm -F @demo/core exec vitest run x -t '^5-17 '",
    'jest x -t "^x"',
    'jest x --testNamePattern=^x',
    "playwright test -g '^x'",
    'playwright test --grep ^x',
  ]) {
    const e = one(t);
    assert.equal(e.length, 1, t);
    assert.match(e[0], /full name/);
  }
  for (const t of [
    "vitest run x -t '5-17 '",
    "node --test --test-name-pattern='^RC-1 ' tools/x.test.mjs",
    'echo a-t^b',
  ])
    assert.deepEqual(one(t), [], t);
  for (const [key, e, f] of committedEntries()) {
    const errors = validateSpec(
      { mutations: [{ id: key, ...e }] },
      () => '',
    ).filter((x) => /starts with \^/.test(x));
    assert.deepEqual(errors, [], `${key} in ${f}`);
  }
  const d = repo();
  writeFileSync(
    join(d, 'm.json'),
    scratch([patch('M1', { test: "touch ran # -t '^x'" })]),
  );
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json'],
    {
      cwd: d,
      encoding: 'utf8',
    },
  );
  assert.equal(p.status, 2, p.stdout + p.stderr);
  assert.match(p.stderr, /full name/);
  assert.ok(!existsSync(join(d, 'ran')));
});

// MC-19..21: a patch on packages/core/src read through dist needs a core build.
const CORE_FILE = 'packages/core/src/x.ts';
const WEB_TEST = 'pnpm -F web exec vitest run';
const CORE_TEST = `pnpm -F ${DEMO.core} exec vitest run x`;
const coreWorld = (buildCore) => {
  const w = world(bites());
  w.io.buildCore = () => {
    w.log.push('build');
    return buildCore(w);
  };
  return w;
};

test('MC-19 a core-src patch with a web test rebuilds core after apply, after restore and once before baselines', async () => {
  const w = coreWorld(() => ({ code: 0, out: '' }));
  const spec = {
    mutations: [patch('M1', { file: CORE_FILE, test: WEB_TEST })],
  };
  const r = await runMutations(spec, w.io, demoSetup());
  assert.equal(r.results[0].status, 'killed');
  assert.deepEqual(w.log, [
    'build',
    `run:${WEB_TEST}`,
    'build',
    `run:${WEB_TEST}`,
    'build',
  ]);
  assert.equal(w.file, ORIGINAL);
  assert.equal(needsCoreBuild(spec.mutations[0], demoSetup()), true);
});

test('MC-20 a core-src patch with a core test never builds core', async () => {
  for (const test of [
    CORE_TEST,
    `pnpm --filter ${DEMO.core} test`,
    `pnpm --filter=${DEMO.core} test`,
    'cd packages/core && pnpm vitest run x',
  ]) {
    const w = coreWorld(() => ({ code: 1, out: 'unexpected build' }));
    const r = await runMutations(
      { mutations: [patch('M1', { file: CORE_FILE, test })] },
      w.io,
      demoSetup(),
    );
    assert.equal(r.results[0].status, 'killed', test);
    assert.ok(!w.log.includes('build'), test);
  }
  const w = coreWorld(() => ({ code: 1, out: 'unexpected build' }));
  await runMutations(
    { mutations: [patch('M1', { test: WEB_TEST })] },
    w.io,
    demoSetup(),
  );
  assert.ok(!w.log.includes('build'), 'file outside packages/core/src');
  assert.equal(needsCoreBuild(sql('M2'), demoSetup()), false);
});

test('MC-21 a build failure after restore is fatal; after apply it is an error', async () => {
  let n = 0;
  const w = coreWorld(() =>
    ++n === 3 ? { code: 1, out: 'tsc died' } : { code: 0, out: '' },
  );
  const spec = {
    mutations: [
      patch('M1', { file: CORE_FILE, test: WEB_TEST }),
      patch('M2', { file: CORE_FILE, test: WEB_TEST }),
    ],
  };
  const r = await runMutations(spec, w.io, demoSetup());
  assert.match(r.fatal, /failed after restoring .*dist no longer matches src/);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'error');
  assert.equal(r.ok, false);
  assert.equal(w.file, ORIGINAL);

  let k = 0;
  const a = coreWorld(() =>
    ++k === 2 ? { code: 1, out: 'tsc died' } : { code: 0, out: '' },
  );
  const r2 = await runMutations(
    { mutations: [patch('M1', { file: CORE_FILE, test: WEB_TEST })] },
    a.io,
    demoSetup(),
  );
  assert.equal(r2.results[0].status, 'error');
  assert.match(r2.results[0].detail, /build failed after apply/);
  assert.equal(a.log.filter((l) => l.startsWith('run:')).length, 1);
  assert.equal(a.file, ORIGINAL);
  assert.equal(exitCodeFor(r2), 1);

  const f = coreWorld(() => ({ code: 1, out: 'tsc died' }));
  const r3 = await runMutations(
    { mutations: [patch('M1', { file: CORE_FILE, test: WEB_TEST })] },
    f.io,
    demoSetup(),
  );
  assert.match(r3.fatal, /failed before the baselines/);
  assert.equal(r3.results.length, 0);
  assert.deepEqual(f.log, ['build']);
  assert.equal(f.file, ORIGINAL);
  assert.equal(r3.ok, false);
});

test('MC-22 a signal after a core-src patch was built rebuilds dist before exit', async () => {
  const calls = [];
  const io = {
    resetDb: async () => (calls.push('reset'), { code: 0, out: '' }),
    buildCore: async () => (calls.push('build'), { code: 0, out: '' }),
  };
  await interruptHandler(
    { restore: () => calls.push('restored'), coreDirty: true },
    io,
    (c) => calls.push(`exit:${c}`),
    'SIGTERM',
  );
  assert.deepEqual(calls, ['restored', 'build', 'exit:143']);

  const c2 = [];
  const io2 = {
    buildCore: async () => (c2.push('build'), { code: 0, out: '' }),
  };
  await interruptHandler({ coreDirty: false }, io2, (c) =>
    c2.push(`exit:${c}`),
  );
  assert.deepEqual(c2, ['exit:130']);
});

test('MC-22b a signal during the pre-baseline core build rebuilds dist', async () => {
  const state = {};
  const seen = [];
  const w = coreWorld((w) => {
    if (w.log.length === 1) {
      seen.push(state.coreDirty);
      return interruptHandler(
        state,
        w.io,
        (c) => w.log.push(`exit:${c}`),
        'SIGTERM',
      ).then(() => ({ code: 0, out: '' }));
    }
    return { code: 0, out: '' };
  });
  w.io.state = state;
  await runMutations(
    { mutations: [patch('M1', { file: CORE_FILE, test: WEB_TEST })] },
    w.io,
  );
  assert.deepEqual(seen, [true]);
  assert.deepEqual(w.log.slice(0, 3), ['build', 'build', 'exit:143']);
});

test('MC-23 runPatch marks core dirty while a built core patch is live, and clears it on rebuild', async () => {
  const state = {};
  const dirty = [];
  const w = coreWorld(() => ({ code: 0, out: '' }));
  w.io.state = state;
  const run = w.io.run;
  w.io.run = (cmd) => (dirty.push(state.coreDirty), run(cmd));
  await runMutations(
    { mutations: [patch('M1', { file: CORE_FILE, test: WEB_TEST })] },
    w.io,
  );
  assert.deepEqual(dirty, [false, true]);
  assert.equal(state.coreDirty, false);

  const s2 = {};
  let n = 0;
  const f = coreWorld(() =>
    ++n === 3 ? { code: 1, out: 'tsc died' } : { code: 0, out: '' },
  );
  f.io.state = s2;
  await runMutations(
    { mutations: [patch('M1', { file: CORE_FILE, test: WEB_TEST })] },
    f.io,
  );
  assert.equal(s2.coreDirty, true);
});

test('MC-P1 a red preflight is fatal before any digest, snapshot or sql call', async () => {
  const w = world(bites());
  w.preflightFn = () => ({ code: 1, out: 'service db is Exited' });
  const report = await runMutations({ mutations: [sql('M1')] }, w.io);
  assert.match(report.fatal, /^stack preflight failed/);
  assert.ok(
    !w.log.some(
      (e) => e === 'digest' || e === 'snapshot' || e.startsWith('sql:'),
    ),
    w.log.join(','),
  );
});

test('MC-P2 preflight runs first for a sql spec and never for a patch-only spec', async () => {
  const a = world(bites());
  await runMutations({ mutations: [sql('M1')] }, a.io);
  const stackCalls = a.log.filter(
    (e) =>
      ['preflight', 'digest', 'snapshot', 'reset'].includes(e) ||
      e.startsWith('sql:'),
  );
  assert.equal(stackCalls[0], 'preflight');
  assert.equal(a.log.filter((e) => e === 'preflight').length, 1);
  const b = world(bites());
  await runMutations({ mutations: [patch('M1')] }, b.io);
  assert.ok(!b.log.includes('preflight'));
});

test('MC-T1 a mutated test that times out is an error, not a kill', async () => {
  const w = world(bites());
  w.io.run = (cmd) => {
    const r = bites_(cmd);
    return r;
  };
  const seen = new Set();
  function bites_(cmd) {
    if (!seen.has(cmd)) {
      seen.add(cmd);
      return { code: 0, out: 'ok' };
    }
    return { code: 124, timedOut: true, out: '' };
  }
  const report = await runMutations({ mutations: [patch('M1')] }, w.io);
  assert.equal(report.results[0].status, 'error');
  assert.match(report.results[0].detail, /^TIMEOUT after 900 s/);
});

test('MC-T3 a timed-out exec survives its own SIGKILL timer (no uncaught ESRCH)', async () => {
  const errors = [];
  const onErr = (e) => errors.push(e);
  process.on('uncaughtException', onErr);
  try {
    const r = await exec('bash', ['-c', 'sleep 30 & wait'], { limitS: 1 });
    assert.equal(r.timedOut, true);
    await new Promise((res) => setTimeout(res, 6500));
    assert.deepEqual(errors, []);
  } finally {
    process.off('uncaughtException', onErr);
  }
});

test('MC-T2 exec kills the whole process group at its limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-t2-'));
  dirs.push(dir);
  const pidFile = join(dir, 'pid');
  const r = await exec(
    'bash',
    ['-c', `sleep 30 & echo $! > ${pidFile}; wait`],
    {
      limitS: 1,
    },
  );
  assert.equal(r.timedOut, true);
  assert.equal(r.code, 124);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  const deadline = Date.now() + 7000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((res) => setTimeout(res, 200));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `grandchild ${pid} survived`);
});

// --- INFRA-26a: the registry (tools/mutation-registry/) -----------------------
