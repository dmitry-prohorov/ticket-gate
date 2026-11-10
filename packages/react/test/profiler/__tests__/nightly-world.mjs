// A fake night for the nightly profile runner: the real runNightly and the real reactProfile,
// with only the profiler's child process played by the world's io.run (the engine's fake world).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineNightly } from '../../../../engine/nightly/define.mjs';
import { runNightly } from '../../../../engine/nightly/run.mjs';
import { dayOf } from '../../../../engine/nightly/schedule.mjs';
import {
  H,
  KEYS,
  NIGHTLY,
  NOW,
  SHA12,
  history,
  iso,
  world,
} from '../../../../engine/test/nightly/__tests__/world.mjs';
import { NIGHTLY_CHILD, numbersOf, reactProfile } from '../../../profiler/nightly.mjs';

export { H, KEYS, NIGHTLY, NOW, SHA12, history, iso, NIGHTLY_CHILD };

export const OPTS = { config: 'profile.config.mjs', runs: 1, scenarios: 'all', keepTraces: 3 };
export const COMPONENTS = ['Card', 'List'];
export const noGit = () => '';
export const GREEN = {
  stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 1 },
  failedSpecs: [],
  flakySpecs: [],
  redTests: [],
};

/** The profile config the child would load: the budgets the real numbersOf reads. */
export const configOf = (budgets) => ({ budgets, componentsFor: () => COMPONENTS });
/** A profiler summary whose `home` scenario renders `n` components in all. */
export const summaryOf = (n, scenario = 'home') => ({ [scenario]: { Card: n - 1, List: 1 } });

const writeIn = (dir, name, text) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
};

/** A child that behaves like a good run: results, traces and the real numbers for `summary`. */
export const goodChild =
  (summary, budgets = {}, out = 'done\n') =>
  ({ dir }) => {
    writeIn(dir, 'results.json', JSON.stringify({ summary }));
    writeIn(join(dir, 'traces'), 't.json', '{}');
    writeIn(dir, 'numbers.json', JSON.stringify(numbersOf(summary, configOf(budgets))));
    return { code: 0, timedOut: false, out };
  };
/** A child that leaves `numbers` text behind and exits with `code`. */
export const rawChild =
  (numbers, { code = 0, out = 'x\n' } = {}) =>
  ({ dir }) => {
    if (numbers !== null) writeIn(dir, 'numbers.json', numbers);
    return { code, timedOut: false, out };
  };

export const runDir = (day = dayOf(NOW), sha12 = SHA12) => join(NIGHTLY, 'profile', `${sha12}-${day}`);

const registry = new Map([
  [
    'A/M1',
    {
      path: 'mutation-registry/x.json',
      line: 1,
      entry: { kind: 'patch', file: 'a.mjs', testFile: 'a.test.mjs' },
    },
  ],
]);

/** A history line of an earlier night; `view` is its suites.profile record, or null for none. */
export function seedLine(daysAgo, view, over = {}) {
  const sha = String(daysAgo).padStart(40, 'c');
  return {
    v: 1,
    sha,
    ranAt: iso(NOW - daysAgo * 24 * H),
    endedAt: iso(NOW - daysAgo * 24 * H + 1000),
    ms: 1000,
    trigger: 'scheduled',
    status: 'green',
    reason: null,
    reachedPlaywright: true,
    stats: GREEN.stats,
    redSpecs: [],
    flakySpecs: [],
    report: `e2e-${daysAgo}.json`,
    finalReset: 'pass',
    ...(view === null ? {} : { suites: { profile: view } }),
    ...over,
  };
}

/** What a night of the profile suite records, as a seeded view. */
export const seedView = (extra, over = {}) => ({
  status: 'green',
  reason: null,
  reachedPlaywright: true,
  stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0, scenarios: 1, runs: 1 },
  redSpecs: [],
  flakySpecs: [],
  report: 'profile/none/report.json',
  ms: 1,
  extra,
  ...over,
});
export const steady = (n) => seedView({ medians: { home: n }, over: [], advisory: ['home'] });

export const writeHistory = (lines) =>
  writeFileSync(join(NIGHTLY, 'history.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
export const readHistory = () => readFileSync(join(NIGHTLY, 'history.jsonl'), 'utf8');

/**
 * Plays one night: the first suite is a green fake, then the profile suite through the real
 * reactProfile, then the rotation. `child(call)` plays the profiler's child; `seed` is written to
 * the history first. Returns the record, the world and what happened, in order.
 */
export async function night({
  child = goodChild(summaryOf(5)),
  git = noGit,
  seed = [],
  now = NOW,
  limitS = 60,
  options = OPTS,
  prepare = () => {},
} = {}) {
  const events = [];
  const childCalls = [];
  const w = world({
    now,
    entries: registry,
    mutate: (w2, ids) => {
      events.push('rotate');
      return { results: ids.map((id) => ({ id, status: 'killed' })) };
    },
  });
  const run = w.io.run;
  w.io.run = async (cmd, args, o = {}) => {
    if (args[0] !== NIGHTLY_CHILD) return run(cmd, args, o);
    events.push('child');
    childCalls.push({ cmd, args, ...o });
    return child({ dir: args[2], args, o });
  };
  if (seed.length > 0) writeHistory(seed);
  prepare(w);
  const runner = reactProfile(options, { git });
  const cfg = defineNightly({
    worktree: { dir: 'demo-nightly', install: ['npm', 'ci'], prepare: [], env: [] },
    rotate: { command: ['node', 'tools/mutate-check.mjs'] },
    suites: [
      {
        name: 'e2e',
        limitS: 60,
        runner: {
          name: 'e2e',
          run: async () => {
            events.push('e2e');
            return { timedOut: false, summary: GREEN, report: {} };
          },
        },
      },
      { name: 'profile', runner, limitS, keep: runner.keep },
    ],
  });
  await runNightly(w.io, { config: cfg });
  const rec = history().at(-1);
  return { w, cfg, rec, view: rec.suites?.profile, events, childCalls, runner };
}
