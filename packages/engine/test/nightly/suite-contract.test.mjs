// SC-1..SC-4: the suite contract.
// runner extra and statusLine, per-suite flaky promotion and move-to-CI,
// config order with per-suite limitS and the rotation after all suites,
// per-suite keep.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  H,
  NIGHTLY,
  NOW,
  SHA12,
  iso,
  history,
  world,
} from './__tests__/world.mjs';
import { fakeGit, flakyLine, line } from './__tests__/status-helpers.mjs';
import { defineNightly } from '../../nightly/define.mjs';
import { classifyRun, readNightly, retain } from '../../nightly/record.mjs';
import { runNightly } from '../../nightly/run.mjs';
import { main, moveToCi, statusLines } from '../../nightly/status.mjs';

const GREEN = {
  stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 1 },
  failedSpecs: [],
  flakySpecs: [],
  redTests: [],
};
const WORKTREE = {
  dir: 'demo-nightly',
  install: ['pnpm', 'install', '--frozen-lockfile'],
  prepare: [],
  env: [],
};
const ROTATE = { command: ['node', 'tools/mutate-check.mjs'] };
const reg = (...specs) =>
  new Map(
    specs.map((key) => [
      key,
      {
        path: 'tools/mutation-registry/tools/x.json',
        line: 1,
        entry: {
          kind: 'patch',
          file: `tools/${key.replace('/', '-')}.mjs`,
          testFile: `tools/${key.replace('/', '-')}.test.mjs`,
        },
      },
    ]),
  );
const suiteOf = (name, run, limitS = 60) => ({
  name,
  limitS,
  runner: {
    name,
    run,
    statusLine: (rec) => `${name}-status ${rec.status} n=${rec.extra?.n}`,
  },
});
const cfgOf = (suites) =>
  defineNightly({ worktree: WORKTREE, rotate: ROTATE, suites });
const ok = (extra) => async () => ({
  timedOut: false,
  summary: GREEN,
  report: {},
  ...(extra === undefined ? {} : { extra }),
});

const scratch = [];
after(() =>
  scratch.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

test("SC-1 a second suite's extra is stored and its statusLine follows the headline", async () => {
  const w = world();
  const cfg = cfgOf([
    suiteOf('e2e', ok()),
    suiteOf('b', async () => ({
      timedOut: false,
      summary: {
        ...GREEN,
        stats: { expected: 2, unexpected: 1, flaky: 0, skipped: 0 },
        failedSpecs: ['b.spec.ts'],
      },
      report: {},
      extra: { n: 1 },
    })),
  ]);
  await runNightly(w.io, { config: cfg, mutationBudgetMs: 0 });
  const rec = history().at(-1);
  assert.deepEqual(rec.suites.b.extra, { n: 1 });
  assert.equal(rec.suites.b.status, 'red');
  assert.equal('extra' in rec, false, 'extra is per suite, not top level');

  const state = { ...readNightly(NIGHTLY), queued: 0 };
  const lines = statusLines(state, NOW, fakeGit([]), undefined, cfg);
  assert.match(lines[0], /^green /, 'the headline is the first suite');
  assert.equal(lines[0].includes('b-status'), false);
  assert.equal(lines[1], 'b-status red n=1');

  // a night whose record has no suites.b prints no line for it
  const solo = {
    latest: { ...rec, suites: undefined },
    history: [],
    queued: 0,
  };
  const plain = statusLines(solo, NOW, fakeGit([]), undefined, cfg);
  assert.equal(
    plain.some((l) => l.includes('b-status')),
    false,
  );

  // exit code is the first suite's: green with b red is 0
  const logged = [];
  const orig = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  let code;
  try {
    code = await main([], cfg);
  } finally {
    console.log = orig;
  }
  assert.equal(code, 0, logged.join('\n'));
  assert.ok(logged.some((l) => l === 'b-status red n=1'));
});

test('SC-2 flaky promotion and move-to-CI count per suite name', () => {
  const SPEC = 'x.spec.ts';
  const flakySummary = {
    stats: { expected: 3, unexpected: 0, flaky: 1, skipped: 1 },
    failedSpecs: [],
    flakySpecs: [SPEC],
    redTests: [],
  };
  const inB = (over) => ({
    status: 'amber',
    reason: null,
    reachedPlaywright: true,
    stats: flakySummary.stats,
    redSpecs: [],
    flakySpecs: [SPEC],
    report: 'b/r/report.json',
    ms: 1,
    ...over,
  });
  // flaky in the first suite yesterday, in b now: not promoted
  const e2eFlaky = [flakyLine(SPEC, 24)];
  const now = classifyRun({
    summary: flakySummary,
    reason: null,
    history: e2eFlaky,
    drift: [],
    suite: 'b',
  });
  assert.equal(now.status, 'amber', 'another suite flake is not b history');
  // flaky in b twice: promoted
  const bFlaky = [line({ suites: { b: inB() }, ranAt: iso(NOW - 24 * H) })];
  const twice = classifyRun({
    summary: flakySummary,
    reason: null,
    history: bFlaky,
    drift: [],
    suite: 'b',
  });
  assert.equal(twice.status, 'red');
  assert.equal(twice.reason, 'flaky-2-of-7');
  assert.deepEqual(twice.redSpecs, [SPEC]);
  // the first suite ignores b history
  const first = classifyRun({
    summary: flakySummary,
    reason: null,
    history: bFlaky,
    drift: [],
  });
  assert.equal(first.status, 'amber');

  const day = (n) => iso(NOW - n * 24 * H);
  const cut = (n) =>
    line({
      ranAt: day(n),
      suites: { b: inB({ status: 'error', reason: 'cut-short' }) },
    });
  const two = [cut(2), cut(3)];
  assert.equal(
    moveToCi({ history: two, nowMs: NOW, queued: 0, suite: 'b' }).t1.busyNights,
    2,
  );
  assert.equal(
    moveToCi({ history: two, nowMs: NOW, queued: 0 }).t1.busyNights,
    0,
  );
  assert.equal(
    moveToCi({ history: two, nowMs: NOW, queued: 0, suite: 'b' }).t1.met,
    true,
  );
  // a top-level skipped-busy night counts for every suite; a first-suite
  // cut-short night counts for the first suite only
  const mixed = [
    ...two,
    line({
      ranAt: day(4),
      status: 'skipped-busy',
      reachedPlaywright: false,
      stats: null,
    }),
    line({ ranAt: day(5), status: 'error', reason: 'cut-short' }),
  ];
  assert.equal(
    moveToCi({ history: mixed, nowMs: NOW, queued: 0, suite: 'b' }).t1
      .busyNights,
    3,
  );
  assert.equal(
    moveToCi({ history: mixed, nowMs: NOW, queued: 0 }).t1.busyNights,
    2,
  );
});

test('SC-3 suites run in config order at their own limitS and the rotation runs once after the last', async () => {
  const events = [];
  const limits = [];
  const mk = (name, limitS, over = {}) =>
    suiteOf(
      name,
      async (ctx) => {
        events.push(name);
        limits.push(ctx.limitS);
        return { timedOut: false, summary: GREEN, report: {}, ...over };
      },
      limitS,
    );
  const w = world({
    entries: reg('A/M1'),
    mutate: (w2, ids) => {
      events.push('rotate');
      return { results: ids.map((id) => ({ id, status: 'killed' })) };
    },
  });
  const cfg = cfgOf([
    mk('a', 100),
    mk('b', 200, { timedOut: true, summary: null }),
    mk('c', 300),
  ]);
  await runNightly(w.io, { config: cfg });
  assert.deepEqual(events, ['a', 'b', 'c', 'rotate']);
  assert.deepEqual(limits, [100, 200, 300]);
  const rec = history().at(-1);
  assert.equal(rec.status, 'green');
  assert.equal(rec.suites.b.status, 'error');
  assert.equal(rec.suites.b.reason, 'cut-short');
  assert.equal(rec.suites.c.status, 'green');
  assert.equal(w.mutateCalls.length, 1, 'the rotation ran once');

  // a first suite that errors skips the rotation (today's rule)
  events.length = 0;
  const first = world({
    entries: reg('A/M1'),
    mutate: () => {
      events.push('rotate');
      return { results: [] };
    },
  });
  await runNightly(first.io, {
    config: cfgOf([mk('a', 100, { timedOut: true, summary: null })]),
  });
  assert.equal(events.includes('rotate'), false);
  assert.equal(history().at(-1).reason, 'cut-short');
});

test('SC-4 per-suite keep: traces 3 deletes only the oldest traces dir; the default keeps reports while history names them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightly-keep-'));
  scratch.push(dir);
  const put = (rel, text = '{}') => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  const night = (n) => `${SHA12}-2026-01-0${n}`;
  const lines = [1, 2, 3, 4, 5].map((n) =>
    line({
      ranAt: iso(Date.parse(`2026-01-0${n}T01:00:00Z`)),
      report: `aaaaaaaaaaaa-2026-01-0${n}.json`,
      suites: {
        b: {
          status: 'green',
          reason: null,
          reachedPlaywright: true,
          stats: GREEN.stats,
          redSpecs: [],
          flakySpecs: [],
          report: `b/${night(n)}/report.json`,
          ms: 1,
        },
      },
    }),
  );
  for (const [i] of lines.entries()) {
    const n = i + 1;
    put(`aaaaaaaaaaaa-2026-01-0${n}.json`);
    put(`b/${night(n)}/report.json`);
    if (n >= 2) put(`b/${night(n)}/traces/t.zip`, 'zip');
  }
  put('bbbbbbbbbbbb-2025-12-31.json'); // no history line names it
  const suites = defineNightly({
    worktree: WORKTREE,
    suites: [
      suiteOf('e2e', ok()),
      {
        ...suiteOf('b', ok()),
        keep: { reports: 'all', traces: 3 },
      },
    ],
  }).suites;
  retain(dir, lines, suites);

  assert.equal(
    existsSync(join(dir, 'b', night(2), 'traces')),
    false,
    'n2 traces go',
  );
  for (const n of [3, 4, 5])
    assert.equal(
      existsSync(join(dir, 'b', night(n), 'traces', 't.zip')),
      true,
      `n${n} traces stay`,
    );
  for (const n of [1, 2, 3, 4, 5])
    assert.equal(
      existsSync(join(dir, 'b', night(n), 'report.json')),
      true,
      `n${n} report stays`,
    );
  for (const n of [1, 2, 3, 4, 5])
    assert.equal(
      existsSync(join(dir, `aaaaaaaaaaaa-2026-01-0${n}.json`)),
      true,
      `root report n${n} is named by history`,
    );
  assert.equal(
    existsSync(join(dir, 'bbbbbbbbbbbb-2025-12-31.json')),
    false,
    'an orphan root report goes',
  );
});

test('SC-5 the first suite wall ignores a long later suite and falls back to the night ms without firstMs', () => {
  const night = (over) =>
    line({ ranAt: iso(NOW - 24 * H), ms: 5 * H, firstMs: H, ...over });
  const withField = moveToCi({ history: [night()], nowMs: NOW, queued: 0 });
  assert.equal(withField.t1.maxWallMs, H);
  assert.equal(withField.t1.met, false);
  const legacy = moveToCi({
    history: [night({ firstMs: undefined })],
    nowMs: NOW,
    queued: 0,
  });
  assert.equal(legacy.t1.maxWallMs, 5 * H, 'a record without firstMs uses ms');
  assert.equal(legacy.t1.met, true);
});

test('SC-5 a real run records the first suite own duration as firstMs and keeps ms as the whole night', async () => {
  const w = world();
  const slow = (ms) => async () => {
    w.clock += ms;
    return { timedOut: false, summary: GREEN, report: {} };
  };
  const cfg = cfgOf([
    suiteOf('e2e', slow(10 * 60_000)),
    suiteOf('b', slow(3 * H)),
  ]);
  await runNightly(w.io, { config: cfg, mutationBudgetMs: 0 });
  const rec = history().at(-1);
  assert.equal(rec.firstMs, 10 * 60_000);
  assert.equal(rec.suites.b.ms, 3 * H);
  assert.ok(rec.ms >= 3 * H + 10 * 60_000, 'ms is the whole night');

  const solo = world();
  await runNightly(solo.io, {
    config: cfgOf([suiteOf('e2e', ok())]),
    mutationBudgetMs: 0,
  });
  assert.equal('firstMs' in history().at(-1), false, 'one suite: no firstMs');
});

test('SC-5 statusLines prints one move-to-ci 1 line per later suite with that suite numbers, none for one suite', () => {
  const rec = line({
    ranAt: iso(NOW - 24 * H),
    ms: 6 * H,
    firstMs: H,
    suites: {
      b: {
        status: 'green',
        reason: null,
        reachedPlaywright: true,
        stats: GREEN.stats,
        redSpecs: [],
        flakySpecs: [],
        report: 'b/r.json',
        ms: 5 * H,
      },
    },
  });
  const state = { latest: rec, history: [rec], queued: 0 };
  const two = statusLines(
    state,
    NOW,
    fakeGit([]),
    undefined,
    cfgOf([suiteOf('e2e', ok()), suiteOf('b', ok())]),
  );
  const ones = two.filter((l) => l.startsWith('move-to-ci 1'));
  assert.equal(ones.length, 2, two.join('\n'));
  assert.match(ones[0], /^move-to-ci 1: max wall 1\.0 h, .*\(not met;/);
  assert.match(ones[1], /^move-to-ci 1 \(b\): max wall 5\.0 h, .*\(MET;/);
  assert.equal(two.filter((l) => l.startsWith('move-to-ci 2')).length, 1);

  const one = statusLines(
    { latest: line(), history: [line()], queued: 0 },
    NOW,
    fakeGit([]),
    undefined,
    cfgOf([suiteOf('e2e', ok())]),
  );
  assert.equal(one.filter((l) => /^move-to-ci 1/.test(l)).length, 1);
  assert.equal(one.some((l) => l.includes('move-to-ci 1 (')), false);
});
