// NS-S1..NS-S4: the seam surface (config object, payload hook, suite
// runner, record shape). Black box over runNightly(io, { config }) with fake
// runners and payloads; the world's fake io plays git, pnpm and the stack.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  KEYS,
  NIGHTLY,
  NOW,
  SHA12,
  history,
  world,
} from './__tests__/world.mjs';
import { defineNightly } from '../../nightly/define.mjs';
import { runNightly } from '../../nightly/run.mjs';
import { dayOf } from '../../nightly/schedule.mjs';

const GREEN = {
  stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 1 },
  failedSpecs: [],
  flakySpecs: [],
  redTests: [],
};
const RED = {
  stats: { expected: 7, unexpected: 1, flaky: 0, skipped: 0 },
  failedSpecs: ['b.spec.ts'],
  flakySpecs: [],
  redTests: [],
};
const WORKTREE = {
  dir: 'demo-nightly',
  install: ['pnpm', 'install', '--frozen-lockfile'],
  prepare: [],
  env: [],
};

function runner(name, seen, summary = GREEN, withStatusLine = true) {
  return {
    name,
    run: async (ctx) => {
      seen.push({ name, ...ctx });
      return { timedOut: false, summary, report: { runner: name } };
    },
    ...(withStatusLine
      ? { statusLine: (rec) => `${name}-status ${rec.status}` }
      : {}),
  };
}
const payload = (over = {}) => ({
  name: 'fake',
  preflight: () => ({ ok: true }),
  ...over,
});
const config = (suites, payloads = []) =>
  defineNightly({
    worktree: WORKTREE,
    rotate: { command: ['node', 'tools/mutate-check.mjs'] },
    suites,
    payloads,
  });
const suite = (r, over = {}) => ({
  name: r.name,
  runner: r,
  limitS: 60,
  ...over,
});

test('NS-S1 a two-suite fake night writes v1 fields for the first suite and suites.<second>', async () => {
  const seen = [];
  const w = world();
  const cfg = config(
    [
      suite(runner('e2e', seen), { args: ['--retries=2'], limitS: 111 }),
      suite(runner('b', seen, RED), { limitS: 222 }),
    ],
    [payload({ before: () => ({ ok: true }), after: () => 'pass' })],
  );
  await runNightly(w.io, { config: cfg, mutationBudgetMs: 0 });

  assert.deepEqual(
    seen.map((s) => s.name),
    ['e2e', 'b'],
  );
  const day = dayOf(NOW);
  const [first, second] = seen;
  assert.equal(first.wt, w.wt);
  assert.deepEqual(first.args, ['--retries=2']);
  assert.equal(first.limitS, 111);
  assert.equal(first.out, join(w.tmpd, `demo-nightly-${SHA12}.pw.json`));
  assert.equal(first.dir, join(NIGHTLY, 'e2e', `${SHA12}-${day}`));
  assert.match(first.env.TICKET_GATE_STACK_LOCK_OWNER, /^nightly:\d+:\d+$/);
  assert.equal(second.limitS, 222);
  assert.equal(second.dir, join(NIGHTLY, 'b', `${SHA12}-${day}`));
  assert.equal(
    second.env.TICKET_GATE_STACK_LOCK_OWNER,
    first.env.TICKET_GATE_STACK_LOCK_OWNER,
    'one lock holder for the night',
  );

  const line = history().at(-1);
  assert.deepEqual(Object.keys(line).sort(), [...KEYS, 'suites'].sort());
  assert.equal(line.status, 'green', 'top level is the first suite');
  assert.deepEqual(line.stats, GREEN.stats);
  assert.equal(line.reachedPlaywright, true);
  assert.equal(line.finalReset, 'pass');
  assert.equal(line.report, `${SHA12}-${day}.json`);
  assert.deepEqual(Object.keys(line.suites), ['b']);
  const b = line.suites.b;
  assert.deepEqual(Object.keys(b).sort(), [
    'flakySpecs',
    'ms',
    'reachedPlaywright',
    'reason',
    'redSpecs',
    'report',
    'stats',
    'status',
  ]);
  assert.equal(b.status, 'red');
  assert.equal(b.reason, 'failed');
  assert.equal(b.reachedPlaywright, true);
  assert.deepEqual(b.stats, RED.stats);
  assert.deepEqual(b.redSpecs, ['b.spec.ts']);
  assert.deepEqual(b.flakySpecs, []);
  assert.equal(typeof b.ms, 'number');
  assert.equal(b.report, `b/${SHA12}-${day}/report.json`);
  assert.equal(existsSync(join(NIGHTLY, line.report)), true);
  assert.deepEqual(JSON.parse(readFileSync(join(NIGHTLY, b.report), 'utf8')), {
    runner: 'b',
  });

  // a one-suite night keeps exactly the v1 keys (D4)
  const solo = world();
  await runNightly(solo.io, {
    config: config([suite(runner('e2e', []))]),
    mutationBudgetMs: 0,
  });
  const v1 = history().at(-1);
  assert.deepEqual(Object.keys(v1).sort(), [...KEYS].sort());
  assert.equal('suites' in v1, false);
});

test('NS-S2 an org-down preflight records error org-down without touching the stack', async () => {
  const spy = [];
  const w = world();
  const cfg = config(
    [suite(runner('e2e', spy))],
    [
      payload({
        preflight: (main) => {
          spy.push(['preflight', main]);
          return { reason: 'org-down' };
        },
        before: () => spy.push(['before']) && { ok: true },
        after: () => spy.push(['after']) && 'pass',
      }),
    ],
  );
  await runNightly(w.io, { config: cfg });
  assert.deepEqual(spy, [['preflight', w.main]], 'only the preflight ran');
  assert.deepEqual(w.calls, [], 'no git, pnpm or stack command');
  const last = history().at(-1);
  assert.equal(last.status, 'error');
  assert.equal(last.reason, 'org-down');
  assert.equal(last.reachedPlaywright, false);
  assert.equal(last.stats, null);
  assert.equal(last.finalReset, null);
  assert.equal(existsSync(w.lock), false, 'the lock is released');
});

test('NS-S3 a payload with no after records finalReset null', async () => {
  const seen = [];
  const w = world();
  await runNightly(w.io, {
    config: config(
      [suite(runner('e2e', seen))],
      [payload({ before: () => ({ ok: true }) })],
    ),
    mutationBudgetMs: 0,
  });
  const last = history().at(-1);
  assert.equal(last.status, 'green');
  assert.equal(seen.length, 1, 'the suite ran');
  assert.equal(last.finalReset, null);

  // an after that fails is recorded as fail
  const failing = world();
  await runNightly(failing.io, {
    config: config(
      [suite(runner('e2e', []))],
      [payload({ after: () => 'fail' })],
    ),
    mutationBudgetMs: 0,
  });
  assert.equal(history().at(-1).finalReset, 'fail');

  // R2: a failed before names its reason; runAfter decides the final reset
  for (const [runAfter, finalReset] of [
    [false, null],
    [true, 'pass'],
  ]) {
    const afters = [];
    const ran = [];
    const w2 = world();
    await runNightly(w2.io, {
      config: config(
        [suite(runner('e2e', ran))],
        [
          payload({
            before: () => ({ reason: 'stack-down', runAfter }),
            after: () => afters.push(1) && 'pass',
          }),
        ],
      ),
      mutationBudgetMs: 0,
    });
    const rec = history().at(-1);
    assert.equal(rec.status, 'error');
    assert.equal(rec.reason, 'stack-down');
    assert.equal(ran.length, 0, 'no suite after a failed before');
    assert.equal(afters.length, runAfter ? 1 : 0);
    assert.equal(rec.finalReset, finalReset);
  }
});

test('NS-S4 defineNightly fills the defaults and rejects a bad suite list', () => {
  const ok = () => ({
    worktree: WORKTREE,
    suites: [suite(runner('e2e', []))],
  });
  const cfg = defineNightly(ok());
  assert.deepEqual(cfg.window, {
    start: '00:50',
    end: '06:00',
    catchUpBy: '00:30',
  });
  assert.deepEqual(cfg.commands, {
    run: 'ticket-gate nightly run',
    install: 'ticket-gate nightly install',
    status: 'ticket-gate nightly status',
  });
  assert.deepEqual(cfg.remote, { name: 'origin', branch: 'main' });
  assert.deepEqual(cfg.payloads, []);
  assert.deepEqual(cfg.keep, { reports: 'history' });
  assert.equal(cfg.selects.interim(['a'], ['b']), false);
  assert.equal(cfg.selects.load, null);
  assert.equal(Object.isFrozen(cfg), true);
  assert.deepEqual(defineNightly(cfg), cfg, 'idempotent');

  const bad = (label, mutate) => {
    const c = ok();
    mutate(c);
    assert.throws(() => defineNightly(c), /^Error: nightly config: /, label);
  };
  const second = () => suite(runner('b', [], GREEN, true));
  bad('no suites', (c) => (c.suites = []));
  bad('duplicate suite name', (c) => c.suites.push(suite(runner('e2e', []))));
  bad('a second suite without statusLine', (c) =>
    c.suites.push(suite(runner('b', [], GREEN, false))),
  );
  bad('suite without runner.run', (c) => (c.suites[0].runner = { name: 'x' }));
  bad('limitS 0', (c) => (c.suites[0].limitS = 0));
  bad('keep.reports unknown', (c) => (c.suites[0].keep = { reports: 'some' }));
  bad(
    'keep.traces 0',
    (c) => (c.suites[0].keep = { reports: 'all', traces: 0 }),
  );
  bad('payload without preflight', (c) => (c.payloads = [{ name: 'p' }]));
  bad('duplicate payload name', (c) => (c.payloads = [payload(), payload()]));
  bad('worktree without install', (c) => (c.worktree = { dir: 'x' }));
  const two = ok();
  two.suites.push(second());
  assert.doesNotThrow(
    () => defineNightly(two),
    'a second suite with a statusLine',
  );
});
