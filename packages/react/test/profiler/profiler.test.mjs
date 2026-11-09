// Pure-function tests for the React profiler. Synthetic traces only: no browser, no stack,
// no server. They import the names bound to the values these cases pin.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  PREFLIGHT,
  PROBLEM,
  SETUP_MISSING,
  analyse,
  budgetFailures,
  compare,
  median,
  parseArgs,
  parseBudgets,
  preflight,
  reduceRun,
  setupDiff,
  traceProblem,
  applyBudget,
} from './__tests__/profiler-bound.mjs';

const us = (ms) => ms * 1000;
const sched = (track, message, startMs, endMs) => ({
  name: 'TimeStamp',
  args: {
    data: {
      trackGroup: 'Scheduler ⚛',
      track,
      message,
      start: us(startMs),
      end: us(endMs),
    },
  },
});
const comp = (message, color = 'primary-light') => ({
  name: 'TimeStamp',
  args: {
    data: { track: 'Components ⚛', message, color, start: 0, end: 1 },
  },
});

// Blocking lane: R1 4, C1 1, R2 2, R3 3, C2 1.
const twoCommits = () => [
  sched('Blocking', 'Render', 0, 4),
  sched('Blocking', 'Commit', 4, 5),
  sched('Blocking', 'Render', 5, 7),
  sched('Blocking', 'Render', 7, 10),
  sched('Blocking', 'Commit', 10, 11),
];

test('PW-1 analyse: two commits on one lane', () => {
  const r = analyse(twoCommits());
  assert.equal(r.commits, 2);
  assert.equal(r.totalRenderMs, 11);
  assert.equal(r.slowestCommitMs, 6);
});

test('PW-2 analyse: component counts skip effects and other names', () => {
  const r = analyse([
    comp('GridChip'),
    comp('Memo(GridChip)'),
    comp('GridChip', 'secondary-light'),
    comp('GridChipList'),
  ]);
  assert.equal(r.GridChip, 2);
  assert.equal(r.componentRendersAll, 3);
});

test('PW-3 analyse: lane registration entries are ignored', () => {
  const noisy = [
    sched('Blocking Track', 'Blocking Track', 3, 3),
    sched('Transition Track', 'Transition Track', 6, 6),
    ...twoCommits(),
  ];
  assert.deepEqual(analyse(noisy), analyse(twoCommits()));
});

test('PW-4 guard: mangled names and no commit', () => {
  const mangled = [
    sched('Blocking', 'Commit', 0, 1),
    comp('a'),
    comp('b'),
    comp('c'),
  ];
  assert.equal(traceProblem(analyse(mangled)), PROBLEM.mangled);
  assert.match(PROBLEM.mangled, /--no-mangling/);
  const noCommit = [comp('a'), comp('b')];
  assert.equal(traceProblem(analyse(noCommit)), PROBLEM.noCommit);
  assert.match(PROBLEM.noCommit, /--profile/);
});

test('PW-5 guard: commits without a Components track, and a clean trace', () => {
  assert.equal(traceProblem(analyse(twoCommits())), PROBLEM.noHook);
  assert.equal(
    traceProblem(analyse([...twoCommits(), comp('DayColumn')])),
    null,
  );
});

test('PW-6 reduceRun throws the guard message and passes a clean trace', () => {
  const mangled = [sched('Blocking', 'Commit', 0, 1), comp('a')];
  assert.throws(() => reduceRun(mangled), { message: PROBLEM.mangled });
  const clean = [...twoCommits(), comp('DayColumn')];
  assert.deepEqual(reduceRun(clean), analyse(clean));
});

test('PW-7 median: odd and even lengths', () => {
  assert.equal(median([10, 9, 100]), 10);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([1.04, 1.1]), 1.1);
});

test('PW-8 compare: delta and percent, zero and missing baseline', () => {
  const baseline = { summary: { W1: { a: 10, b: 0, c: 0 } } };
  const rows = compare({ W1: { a: 12, b: 3, c: 0, d: 5 } }, baseline);
  const by = Object.fromEntries(rows.map((r) => [r.metric, r]));
  assert.equal(by.a.delta, 2);
  assert.equal(by.a.pct, 20);
  assert.equal(by.b.pct, null);
  assert.equal(by.c.pct, 0);
  assert.deepEqual(
    { base: by.d.base, delta: by.d.delta, pct: by.d.pct },
    { base: null, delta: null, pct: null },
  );
  assert.equal(compare({ W2: { a: 1 } }, baseline)[0].base, null);
});

test('PW-9 setupDiff: flags build, chromium and runs, not sha', () => {
  const meta = { sha: 'a', buildFlags: 'x', chromium: '1', runs: 3 };
  assert.deepEqual(setupDiff(meta, { ...meta, sha: 'b' }), []);
  assert.deepEqual(setupDiff(meta, { ...meta, chromium: '2', runs: 5 }), [
    'chromium: 2 -> 1',
    'runs: 5 -> 3',
  ]);
  assert.deepEqual(setupDiff(meta, { ...meta, buildFlags: 'y' }), [
    'buildFlags: y -> x',
  ]);
  assert.deepEqual(setupDiff(meta, undefined), [SETUP_MISSING]);
});

test('PW-10 preflight: each failure names its fix', async () => {
  const env = () => true;
  const probe = (down) => async (url) =>
    !down.some((port) => url.includes(port));
  assert.deepEqual(await preflight({ build: false }, probe([]), env), []);
  assert.deepEqual(await preflight({ build: false }, probe([':3000']), env), [
    PREFLIGHT.noApp,
  ]);
  assert.deepEqual(await preflight({ build: true }, probe([]), env), [
    PREFLIGHT.portInUse,
  ]);
  const both = await preflight(
    { build: false },
    probe([':54321', ':54324']),
    env,
  );
  assert.deepEqual(both, [PREFLIGHT.noSupabase, PREFLIGHT.noMailpit]);
  for (const p of both) assert.match(p, /pnpm supabase start/);
  // A new worktree has no apps/web/.env.local: named, with the fix.
  const noEnv = await preflight({ build: false }, probe([]), () => false);
  assert.deepEqual(noEnv, [PREFLIGHT.noWebEnv]);
  assert.match(noEnv[0], /\.env\.local/);
});

test('PW-11 parseArgs: defaults, flags, strict errors', () => {
  const d = parseArgs([]);
  assert.deepEqual(d.scenarios, ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7']);
  assert.equal(d.runs, 3);
  assert.equal(d.build, false);
  assert.equal(d.compare, null);
  assert.ok(d.out.startsWith(tmpdir()));
  assert.deepEqual(
    parseArgs(['--build', '--compare=x.json', '--runs=5', '--scenarios=W2']),
    { ...d, build: true, compare: 'x.json', runs: 5, scenarios: ['W2'] },
  );
  for (const bad of ['--runs=0', '--runs=abc', '--run=5', '--scenarios=W9'])
    assert.throws(() => parseArgs([bad]), Error, bad);
});

test('PW-B1 parseArgs: --max-renders is off by default and parses valid pairs', () => {
  assert.equal(parseArgs([]).maxRenders, null);
  assert.deepEqual(parseArgs(['--max-renders=W4:150,W5:0']).maxRenders, {
    W4: 150,
    W5: 0,
  });
});

test('PW-B2 parseArgs: --max-renders rejects an unknown scenario, a non-integer and a scenario not run', () => {
  assert.throws(() => parseBudgets('W9:3'), /unknown scenario W9/);
  assert.throws(() => parseBudgets('W4:1.5'), /not <scenario>:<integer>/);
  assert.throws(() => parseBudgets('W4:-1'), /not <scenario>:<integer>/);
  assert.throws(() => parseBudgets('W4'), /not <scenario>:<integer>/);
  assert.throws(() => parseBudgets('W4:abc'), /not <scenario>:<integer>/);
  assert.throws(
    () => parseArgs(['--scenarios=W1', '--max-renders=W4:150']),
    /does not run/,
  );
  assert.throws(() => parseArgs(['--max-commits=W4:12']), /usage/);
});

test('PW-B4 applyBudget: over budget is code 1 with lines, within is 0, no flag is 0', () => {
  const summary = {
    W4: { RoutineChip: 140, RoutineFrame: 20 },
    W5: { RoutineChip: 3, RoutineFrame: 0 },
  };
  assert.deepEqual(applyBudget(summary, { W4: 150, W5: 160 }), {
    lines: [
      'render budget exceeded: W4: median RoutineChip + RoutineFrame renders 160 > budget 150',
    ],
    code: 1,
  });
  assert.deepEqual(applyBudget(summary, { W4: 160, W5: 3 }), {
    lines: [],
    code: 0,
  });
  assert.deepEqual(applyBudget(summary, null), { lines: [], code: 0 });
});
