// Argument parsing, render budgets and result comparison for the React profiler.
// Every project value arrives in `cfg`.
import { round } from './trace.mjs';

export const usageOf = (cfg) =>
  `usage: ${cfg.command} [--build] [--scenarios=${Object.keys(cfg.scenarios).join(',')}] [--runs=N (integer >= 1)] [--out=<dir>] [--compare=<results.json>] [--max-renders=${cfg.usage.maxRenders}]`;

/** 'a:12,b:8' -> { a: 12, b: 8 }. Throws on a malformed pair, unknown scenario or non-integer. */
export function parseBudgets(text, cfg) {
  const usage = usageOf(cfg);
  const budgets = {};
  for (const pair of text.split(',')) {
    const [sc, n, ...rest] = pair.split(':');
    if (rest.length > 0 || n === undefined || !/^\d+$/.test(n))
      throw new Error(
        `--max-renders: "${pair}" is not <scenario>:<integer>. ${usage}`,
      );
    if (!(sc in cfg.scenarios)) throw new Error(`unknown scenario ${sc}`);
    budgets[sc] = Number(n);
  }
  return budgets;
}

/** What the run does with a budget: stderr lines and the exit code (1 over budget, else 0). */
export function applyBudget(summary, budgets, componentsFor) {
  if (budgets === null) return { lines: [], code: 0 };
  const lines = budgetFailures(summary, budgets, componentsFor).map(
    (line) => `render budget exceeded: ${line}`,
  );
  return { lines, code: lines.length > 0 ? 1 : 0 };
}

/** A scenario's median renders of its own components; null when it did not run. */
export function scenarioRenders(row, scenario, componentsFor) {
  if (row === undefined) return null;
  return componentsFor(scenario).reduce(
    (sum, name) => sum + (row[name] ?? 0),
    0,
  );
}

/** Lines naming each scenario whose component renders exceed its budget; [] when all are within. */
export function budgetFailures(summary, budgets, componentsFor) {
  return Object.entries(budgets)
    .map(([sc, max]) => [
      sc,
      max,
      scenarioRenders(summary[sc], sc, componentsFor),
    ])
    .filter(([, max, renders]) => renders === null || renders > max)
    .map(
      ([sc, max, renders]) =>
        `${sc}: median ${componentsFor(sc).join(' + ')} renders ${renders ?? 'missing'} > budget ${max}`,
    );
}

/** argv = process.argv.slice(2). Throws on anything it does not know. */
export function parseArgs(argv, cfg) {
  const usage = usageOf(cfg);
  const opts = {
    scenarios: Object.keys(cfg.scenarios),
    runs: 3,
    out: cfg.out,
    build: false,
    compare: null,
    maxRenders: null,
  };
  for (const a of argv) {
    if (a === '--build') opts.build = true;
    else if (a.startsWith('--scenarios='))
      opts.scenarios = a.slice('--scenarios='.length).split(',');
    else if (a.startsWith('--runs='))
      opts.runs = Number(a.slice('--runs='.length));
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else if (a.startsWith('--compare='))
      opts.compare = a.slice('--compare='.length);
    else if (a.startsWith('--max-renders='))
      opts.maxRenders = parseBudgets(a.slice('--max-renders='.length), cfg);
    else throw new Error(usage);
  }
  const { runs } = opts;
  if (!Number.isInteger(runs) || runs < 1) throw new Error(usage);
  for (const sc of opts.scenarios)
    if (!(sc in cfg.scenarios)) throw new Error(`unknown scenario ${sc}`);
  for (const sc of Object.keys(opts.maxRenders ?? {}))
    if (!opts.scenarios.includes(sc))
      throw new Error(
        `--max-renders names ${sc}, which --scenarios does not run`,
      );
  return opts;
}

function percent(now, base) {
  const pct =
    base === 0 ? (now === 0 ? 0 : null) : round(((now - base) / base) * 100);
  return pct;
}

/** One row per (scenario, metric) of `summary`; base/delta/pct are null when the baseline lacks it. */
export function compare(summary, baseline) {
  const rows = [];
  for (const [scenario, metrics] of Object.entries(summary))
    for (const [metric, now] of Object.entries(metrics)) {
      const base = baseline.summary?.[scenario]?.[metric] ?? null;
      if (base === null) {
        rows.push({ scenario, metric, now, base, delta: null, pct: null });
        continue;
      }
      rows.push({
        scenario,
        metric,
        now,
        base,
        delta: round(now - base),
        pct: percent(now, base),
      });
    }
  return rows;
}

export const SETUP_MISSING =
  'baseline has no setup record (written before setup records existed)';

/** Lines naming each differing setup field. The commit sha is never flagged. */
export function setupDiff(meta, baseMeta) {
  if (!baseMeta) return [SETUP_MISSING];
  return ['buildFlags', 'chromium', 'runs']
    .filter((field) => meta[field] !== baseMeta[field])
    .map((field) => `${field}: ${baseMeta[field]} -> ${meta[field]}`);
}
