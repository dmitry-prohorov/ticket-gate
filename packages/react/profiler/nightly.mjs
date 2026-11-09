// The nightly suite runner: it profiles one build in a child process, so the suite's time
// limit can stop it, and turns the numbers the child leaves in the run directory into a result.
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { byRanAtDesc, readNightly, suiteView } from '#engine/nightly/record.mjs';
import { fixSeed, realGit, short } from '#engine/nightly/seed.mjs';
import { scenarioRenders } from './stats.mjs';

export const NIGHTLY_CHILD = fileURLToPath(new URL('./nightly-child.mjs', import.meta.url));
const STABLE_NIGHTS = 7;
const GRACE_S = 30;
const LOG_TAIL = 2000;
const SHOWN_MERGES = 3;
const NO_FLAKY = [];

/** Medians of each scenario's own component renders, and the scenarios over their budget. */
export function numbersOf(summary, { budgets = {}, componentsFor }) {
  const medians = {};
  const over = [];
  const advisory = [];
  for (const [scenario, row] of Object.entries(summary)) {
    const renders = scenarioRenders(row, scenario, componentsFor);
    medians[scenario] = renders;
    const b = budgets[scenario];
    if (b === undefined) continue;
    if (typeof b?.max !== 'number') throw new Error(`budget for ${scenario} needs a numeric max`);
    const blocking = b.blocking === true;
    if (!blocking) advisory.push(scenario);
    if (renders > b.max) over.push({ scenario, renders, budget: b.max, blocking });
  }
  return { medians, over, advisory };
}

/** Advisory scenarios in budget for the last 7 nights whose medians stayed within 10%. */
export function promotable(history, suite, tonight) {
  const nights = history
    .map((l) => ({ ranAt: l.ranAt, view: suiteView(l, suite) }))
    .filter((n) => n.view !== null)
    .sort(byRanAtDesc)
    .slice(0, STABLE_NIGHTS - 1);
  if (nights.length < STABLE_NIGHTS - 1) return [];
  const series = [tonight, ...nights.map((n) => n.view.extra)];
  return tonight.advisory.filter((sc) => {
    if (
      !series.every(
        (e) => typeof e?.medians?.[sc] === 'number' && !(e.over ?? []).some((o) => o.scenario === sc),
      )
    )
      return false;
    const values = series.map((e) => e.medians[sc]);
    return (Math.max(...values) - Math.min(...values)) * 10 <= Math.min(...values);
  });
}

function suspectsText({ lastGreenSha, merges }) {
  const since = lastGreenSha ? short(lastGreenSha) : 'no green night';
  const shown = merges.slice(0, SHOWN_MERGES).map((m) => `${short(m.sha)} ${m.subject}`);
  const more = merges.length > SHOWN_MERGES ? ` +${merges.length - SHOWN_MERGES} more` : '';
  return `suspect merges since ${since}: ${shown.join(', ') || 'none'}${more}`;
}

/** The one line `nightly status` prints for this suite. */
export function statusLine(view) {
  const e = view.extra ?? {};
  const parts = [];
  if (e.noNumbers !== undefined)
    parts.push(e.noNumbers === 'cut-short' ? 'cut-short' : `no numbers: ${e.noNumbers}`);
  else if (view.status === 'error') parts.push(view.reason ?? 'error');
  for (const o of e.over ?? [])
    parts.push(`${o.scenario} renders ${o.renders} > ${o.budget}, ${o.blocking ? 'blocking' : 'advisory'}`);
  for (const sc of e.promote ?? [])
    parts.push(`${sc} stable ${STABLE_NIGHTS} of ${STABLE_NIGHTS} nights: promote with blocking: true`);
  if (e.suspects === null) parts.push('suspect merges unavailable');
  else if (e.suspects !== undefined) parts.push(suspectsText(e.suspects));
  const word = view.status === 'error' ? 'red' : view.status;
  return `nightly profile: ${word}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`;
}

const summaryOf = ({ expected, unexpected, flaky, scenarios, runs, failed }) => ({
  stats: { expected, unexpected, flaky, skipped: 0, scenarios, runs },
  failedSpecs: failed,
  flakySpecs: NO_FLAKY,
  redTests: [],
});

function readNumbers(io, dir) {
  const file = join(dir, 'numbers.json');
  if (!io.exists(file)) return null;
  try {
    const n = JSON.parse(io.readFile(file));
    return Object.keys(n.medians ?? {}).length > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * A runner for `nightly.suites`. The suite entry passes `keep: runner.keep`.
 * `config` is the profile config module, relative to the worktree.
 */
export function reactProfile({ config, runs, scenarios, keepTraces }, { git = realGit } = {}) {
  if (typeof config !== 'string' || config === '')
    throw new TypeError('reactProfile: config must be a path relative to the worktree');
  if (!Number.isInteger(runs) || runs < 1)
    throw new TypeError('reactProfile: runs must be a positive integer');
  if (scenarios !== 'all' && !(Array.isArray(scenarios) && scenarios.length > 0))
    throw new TypeError("reactProfile: scenarios must be 'all' or a non-empty list");
  if (!Number.isInteger(keepTraces) || keepTraces < 1)
    throw new TypeError('reactProfile: keepTraces must be a positive integer');
  const flags = ['--build', `--runs=${runs}`, ...(scenarios === 'all' ? [] : [`--scenarios=${scenarios.join(',')}`])];
  return {
    name: 'profile',
    keep: { reports: 'all', traces: keepTraces },
    statusLine,
    async run({ wt, io, args = [], limitS, env = {}, dir }) {
      const { history } = readNightly(dirname(dirname(dir)));
      const suite = basename(dirname(dir));
      const suspectsOf = () => {
        try {
          const lines = history.flatMap((l) => {
            const v = suiteView(l, suite);
            return v === null ? [] : [{ sha: l.sha, ranAt: l.ranAt, status: v.status }];
          });
          const { lastGreenSha, merges } = fixSeed({
            latest: { sha: basename(dir).slice(0, 12) },
            history: lines,
            git,
          });
          return { lastGreenSha, merges: merges.map(({ sha, subject }) => ({ sha, subject })) };
        } catch {
          return null; // no suspects without git
        }
      };
      io.rm(dir);
      io.mkdir(dir);
      const r = await io.run(process.execPath, [NIGHTLY_CHILD, config, dir, ...flags, ...args], {
        cwd: wt,
        env: { ...env, TICKET_GATE_ROOT: wt },
        limitS,
        killSignal: 'SIGINT',
        graceS: GRACE_S,
      });
      if (r.timedOut)
        return {
          timedOut: true,
          summary: null,
          report: null,
          extra: { noNumbers: 'cut-short', suspects: suspectsOf() },
        };
      const numbers = r.code === 0 ? readNumbers(io, dir) : null;
      if (numbers === null)
        return {
          timedOut: false,
          summary: summaryOf({ expected: 0, unexpected: 1, flaky: 0, scenarios: 0, runs, failed: ['no numbers'] }),
          report: { results: null, log: r.out.slice(-LOG_TAIL) },
          extra: {
            medians: {},
            over: [],
            advisory: [],
            noNumbers: r.out.trim().split('\n').at(-1) || `exit ${r.code}`,
            suspects: suspectsOf(),
          },
        };
      const blocking = numbers.over.filter((o) => o.blocking);
      const advisoryOver = numbers.over.length - blocking.length;
      const red = blocking.length > 0;
      const count = Object.keys(numbers.medians).length;
      return {
        timedOut: false,
        summary: summaryOf({
          expected: count - numbers.over.length,
          unexpected: blocking.length,
          flaky: advisoryOver,
          scenarios: count,
          runs,
          failed: blocking.map((o) => o.scenario),
        }),
        report: { results: 'results.json', traces: 'traces' },
        extra: {
          ...numbers,
          promote: promotable(history, suite, numbers),
          ...(red ? { suspects: suspectsOf() } : {}),
        },
      };
    },
  };
}
