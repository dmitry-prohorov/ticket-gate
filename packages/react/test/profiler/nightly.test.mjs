// PN, PS, PP, PK, PV: the nightly profile suite, played through the real runNightly and the
// real reactProfile with only the profiler's child faked.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readNightly } from '../../../engine/nightly/record.mjs';
import { dayOf } from '../../../engine/nightly/schedule.mjs';
import { statusLines } from '../../../engine/nightly/status.mjs';
import { world } from '../../../engine/test/nightly/__tests__/world.mjs';
import { chooseE2eMode, recordOf } from '../../../engine/selection/units.mjs';
import { numbersOf, reactProfile } from '../../profiler/nightly.mjs';
import {
  H,
  KEYS,
  NIGHTLY,
  NIGHTLY_CHILD,
  NOW,
  OPTS,
  SHA12,
  configOf,
  goodChild,
  night,
  noGit,
  rawChild,
  runDir,
  seedLine,
  seedView,
  steady,
  summaryOf,
} from './__tests__/nightly-world.mjs';

const linesOf = (cfg) =>
  statusLines({ ...readNightly(NIGHTLY), queued: 0 }, NOW, noGit, undefined, cfg);
const BLOCK = { home: { max: 3, blocking: true } };
const ADVISORY = { home: { max: 3 } };
const dayAgo = (n) => dayOf(NOW - n * 24 * H);

test('PN-1 a fake night runs e2e, profile, rotation in order and records both', async () => {
  const { w, rec, view, events, childCalls } = await night();
  assert.deepEqual(events, ['e2e', 'child', 'rotate']);
  const call = childCalls[0];
  assert.equal(call.cmd, process.execPath);
  assert.equal(call.cwd, w.wt);
  assert.equal(call.env.TICKET_GATE_ROOT, w.wt);
  assert.equal(call.limitS, 60);
  assert.equal(call.killSignal, 'SIGINT');
  assert.deepEqual(call.args.slice(0, 2), [NIGHTLY_CHILD, OPTS.config]);
  assert.deepEqual(call.args.slice(3), ['--build', '--runs=1']);
  assert.equal(call.args[2], runDir());
  for (const k of KEYS) assert.ok(k in rec, `the record keeps ${k}`);
  assert.equal(view.status, 'green');
  assert.equal(view.stats.scenarios, 1);
  assert.equal(view.stats.runs, 1);
  assert.equal(view.report, `profile/${SHA12}-${dayOf(NOW)}/report.json`);
  assert.deepEqual(view.extra.medians, { home: 5 });
  assert.ok(existsSync(join(runDir(), 'report.json')));
  assert.ok(existsSync(join(runDir(), 'results.json')));
});

test('PN-1b a scenario list reaches the child as --scenarios', async () => {
  const { childCalls } = await night({ options: { ...OPTS, scenarios: ['home', 'list'] } });
  assert.ok(childCalls[0].args.includes('--scenarios=home,list'));
});

test('PN-2 status prints the e2e headline and the profile line', async () => {
  const withSuite = await night();
  const lines = linesOf(withSuite.cfg);
  assert.equal(lines[1], 'nightly profile: green');
  for (const l of lines) assert.equal(l.includes('\n'), false);
  const { latest, history } = readNightly(NIGHTLY);
  const bare = (l) => ({ ...l, suites: undefined });
  const plain = statusLines(
    { latest: bare(latest), history: history.map(bare), queued: 0 },
    NOW,
    noGit,
    undefined,
    withSuite.cfg,
  );
  assert.equal(plain[0], lines[0], 'the headline does not change with the suite');
  assert.equal(
    plain.some((l) => l.startsWith('nightly profile')),
    false,
  );
});

test('PN-3 a red profile does not change the e2e mode a units step chooses', async () => {
  const modeOf = async (budgets) => {
    const { rec } = await night({ child: goodChild(summaryOf(5), budgets) });
    assert.equal(rec.status, 'green');
    return chooseE2eMode({
      selection: { mode: 'affected', why: 'x' },
      nightly: recordOf(readNightly(NIGHTLY).latest, 'e2e'),
      flag: 'auto',
      nowMs: NOW + H,
    });
  };
  const green = await modeOf({});
  const red = await modeOf(BLOCK);
  assert.deepEqual(red, green);
  assert.equal(red.mode, 'affected');
});

test('PS-1 every scenario in budget is green, a median equal to its budget included', async () => {
  const { view } = await night({ child: goodChild(summaryOf(5), { home: { max: 5, blocking: true } }) });
  assert.equal(view.status, 'green');
  assert.deepEqual(view.extra.over, []);
  assert.equal(view.stats.unexpected, 0);
});

test('PS-2 an advisory over budget is amber on two nights running', async () => {
  const child = goodChild(summaryOf(5), ADVISORY);
  const first = await night({ child, now: NOW - 24 * H });
  assert.equal(first.view.status, 'amber');
  const second = await night({ child, seed: [first.rec] });
  assert.equal(second.view.status, 'amber');
  assert.equal(second.view.reason, null);
  assert.equal(second.view.stats.flaky, 1);
  assert.equal(second.view.stats.unexpected, 0);
});

test('PS-3 a blocking over budget is red with suspect merges', async () => {
  const green = seedLine(2, seedView({ medians: { home: 2 }, over: [], advisory: [] }));
  const calls = [];
  const git = (...args) => {
    calls.push(args.flat().join(' '));
    return args.includes('log') ? `${'1'.repeat(40)}\tmerge one\n${'2'.repeat(40)}\tmerge two` : '';
  };
  const { view, cfg } = await night({ child: goodChild(summaryOf(5), BLOCK), git, seed: [green] });
  assert.equal(view.status, 'red');
  assert.equal(view.reason, 'failed');
  assert.deepEqual(view.redSpecs, ['home']);
  assert.deepEqual(view.extra.suspects, {
    lastGreenSha: green.sha,
    merges: [
      { sha: '1'.repeat(40), subject: 'merge one' },
      { sha: '2'.repeat(40), subject: 'merge two' },
    ],
  });
  assert.ok(calls.some((c) => c.includes(`${green.sha}..${SHA12}`)), calls.join('\n'));
  assert.match(
    linesOf(cfg)[1], /^nightly profile: red \(home renders 5 > 3, blocking; suspect merges since cccccccccccc: /,
  );
});

test('PS-4 a child that fails is red with no numbers, even with numbers on disk', async () => {
  const bad = await night({ child: rawChild(null, { code: 1, out: 'boom\nno React Commit found\n' }) });
  assert.equal(bad.view.status, 'red');
  assert.deepEqual(bad.view.redSpecs, ['no numbers']);
  assert.equal(bad.view.extra.noNumbers, 'no React Commit found');
  assert.ok(existsSync(join(runDir(), 'report.json')));
  assert.match(linesOf(bad.cfg)[1], /^nightly profile: red \(no numbers: no React Commit found; /);
  const good = JSON.stringify({ medians: { home: 1 }, over: [], advisory: [] });
  const stale = await night({ child: rawChild(good, { code: 1, out: 'died\n' }) });
  assert.equal(stale.view.status, 'red');
  assert.equal(stale.view.extra.noNumbers, 'died');
});

test('PS-5 corrupt or empty numbers are red, and the runner never rejects', async () => {
  const texts = [
    '{not json',
    JSON.stringify({ medians: {}, over: [], advisory: [] }),
    JSON.stringify({ medians: { home: 1 } }),
    JSON.stringify({ medians: { home: 1 }, over: 'x' }),
    JSON.stringify({ medians: [1], over: [], advisory: [] }),
  ];
  for (const text of texts) {
    const { view } = await night({ child: rawChild(text) });
    assert.equal(view.status, 'red', text);
    assert.deepEqual(view.redSpecs, ['no numbers']);
  }
});

test('PS-9 the runner resolves red on a filesystem error', async () => {
  const w = world();
  const io = {
    ...w.io,
    mkdir: () => {
      throw new Error('disk full');
    },
  };
  const dir = join(NIGHTLY, 'profile', `${SHA12}-${dayOf(NOW)}`);
  const res = await reactProfile(OPTS, { git: noGit }).run({ wt: w.wt, io, args: [], limitS: 60, env: {}, dir });
  assert.equal(res.timedOut, false);
  assert.deepEqual(res.summary.failedSpecs, ['no numbers']);
  assert.equal(res.extra.noNumbers, 'disk full');
});

test("PS-6 a second run the same day cannot read the first run's numbers", async () => {
  const good = JSON.stringify({ medians: { home: 1 }, over: [], advisory: [] });
  const { view } = await night({
    child: rawChild(null),
    prepare: () => {
      mkdirSync(runDir(), { recursive: true });
      writeFileSync(join(runDir(), 'numbers.json'), good);
    },
  });
  assert.equal(view.status, 'red');
  assert.deepEqual(view.redSpecs, ['no numbers']);
});

test('PS-7 a cut-short night prints red and the rotation still runs', async () => {
  const { view, events, cfg } = await night({
    child: () => ({ code: 1, timedOut: true, out: '' }),
  });
  assert.equal(view.status, 'error');
  assert.equal(view.reason, 'cut-short');
  assert.equal(
    linesOf(cfg)[1],
    'nightly profile: red (cut-short; suspect merges since no green night: none)',
  );
  assert.deepEqual(events, ['e2e', 'child', 'rotate']);
});

test('PS-8 suspect merges fall back when git throws', async () => {
  const git = () => {
    throw new Error('no git here');
  };
  const { view, cfg } = await night({ child: rawChild(null, { code: 1, out: 'gone\n' }), git });
  assert.equal(view.status, 'red');
  assert.equal(view.extra.suspects, null);
  assert.match(linesOf(cfg)[1], /suspect merges unavailable\)$/);
});

const promoted = async ({ seed, summary = summaryOf(10), budgets = { home: { max: 100 } } }) =>
  night({ child: goodChild(summary, budgets), seed });

test('PP-1 seven in-budget nights within 10% print the promotion hint', async () => {
  const { view, cfg } = await promoted({ seed: Array.from({ length: 6 }, (_, i) => seedLine(i + 1, steady(10))) });
  assert.deepEqual(view.extra.promote, ['home']);
  assert.match(linesOf(cfg)[1], /home stable 7 of 7 nights: promote with blocking: true/);
});

test('PP-2 six nights do not', async () => {
  const { view } = await promoted({ seed: Array.from({ length: 5 }, (_, i) => seedLine(i + 1, steady(10))) });
  assert.deepEqual(view.extra.promote, []);
});

test('PP-3 an over-budget or number-less night breaks the streak', async () => {
  const at = (broken) => Array.from({ length: 6 }, (_, i) => seedLine(i + 1, i === 2 ? broken : steady(10)));
  const over = seedView({
    medians: { home: 10 },
    over: [{ scenario: 'home', renders: 10, budget: 3, blocking: false }],
    advisory: ['home'],
  });
  assert.deepEqual((await promoted({ seed: at(over) })).view.extra.promote, []);
  assert.deepEqual((await promoted({ seed: at(seedView({})) })).view.extra.promote, []);
});

test('PP-4 exactly 10% promotes, 11% does not', async () => {
  const seed = Array.from({ length: 6 }, (_, i) => seedLine(i + 1, steady(100)));
  assert.deepEqual((await promoted({ seed, summary: summaryOf(110), budgets: { home: { max: 1000 } } })).view.extra.promote, ['home']);
  assert.deepEqual((await promoted({ seed, summary: summaryOf(111), budgets: { home: { max: 1000 } } })).view.extra.promote, []);
});

test('PP-5 a blocking scenario gets no hint', async () => {
  const seed = Array.from({ length: 6 }, (_, i) => seedLine(i + 1, steady(10)));
  const { view } = await promoted({ seed, budgets: { home: { max: 100, blocking: true } } });
  assert.deepEqual(view.extra.promote, []);
});

test('PK-1 traces go after 3 nights, results stay, also for a cut-short night', async () => {
  const named = [1, 2, 3].map((n) => `${'a'.repeat(12)}-${dayAgo(n)}`);
  const orphan = `${'b'.repeat(12)}-2025-12-31`;
  // history is oldest first
  const seed = () =>
    named
      .map((name, i) =>
        seedLine(i + 1, seedView({ medians: { home: 5 }, over: [], advisory: [] }, { report: `profile/${name}/report.json` })),
      )
      .reverse();
  const put = () => {
    for (const name of [...named, orphan]) {
      const d = join(NIGHTLY, 'profile', name);
      mkdirSync(join(d, 'traces'), { recursive: true });
      writeFileSync(join(d, 'traces', 't.json'), '{}');
      writeFileSync(join(d, 'results.json'), '{}');
      writeFileSync(join(d, 'report.json'), '{}');
    }
  };
  const traces = (name) => existsSync(join(NIGHTLY, 'profile', name, 'traces'));
  const results = (name) => existsSync(join(NIGHTLY, 'profile', name, 'results.json'));
  const tonight = `${SHA12}-${dayOf(NOW)}`;

  await night({ seed: seed(), prepare: put });
  assert.equal(traces(named[0]), true);
  assert.equal(traces(named[1]), true);
  assert.equal(traces(named[2]), false, 'the fourth night loses its traces');
  assert.equal(traces(orphan), false);
  assert.equal(traces(tonight), true);
  for (const n of [...named, orphan, tonight]) assert.equal(results(n), true, `${n} keeps results.json`);

  const cut = await night({
    seed: seed(),
    prepare: put,
    child: ({ dir }) => {
      mkdirSync(join(dir, 'traces'), { recursive: true });
      writeFileSync(join(dir, 'traces', 't.json'), '{}');
      writeFileSync(join(dir, 'results.json'), '{}');
      return { code: 1, timedOut: true, out: '' };
    },
  });
  assert.equal(cut.view.reason, 'cut-short');
  assert.equal(traces(tonight), false, 'a night no history line names ranks after the named ones');
  assert.equal(results(tonight), true);
  assert.equal(traces(named[0]), true);
  for (const n of [...named, orphan]) assert.equal(results(n), true, `${n} keeps results.json`);
});

test('PV-1 reactProfile refuses bad options and a bad budget', () => {
  for (const bad of [{ config: '' }, { runs: 0 }, { scenarios: [] }, { keepTraces: 0 }])
    assert.throws(() => reactProfile({ ...OPTS, ...bad }), TypeError, JSON.stringify(bad));
  assert.doesNotThrow(() => reactProfile({ ...OPTS, scenarios: ['home'] }));
  assert.throws(() => numbersOf(summaryOf(5), configOf({ home: { max: 'x' } })), /needs a numeric max/);
  assert.deepEqual(reactProfile(OPTS).keep, { reports: 'all', traces: 3 });
});
