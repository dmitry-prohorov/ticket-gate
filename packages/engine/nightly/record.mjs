import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { mainCheckout } from '../lock.mjs';

export const H = 3_600_000;
export const FLAKY_PROMOTE = { of: 7, min: 2 };
export const FRESH_MS = 36 * H;
export const REACHED = (r) => r.reachedPlaywright === true;
export const WINDOW_MS = 7 * 24 * H;
const HISTORY_MAX = 60;

export const byRanAtDesc = (a, b) => Date.parse(b.ranAt) - Date.parse(a.ranAt);

/** One suite's view of a history line: null = the first suite (the record itself). */
export const suiteView = (record, name = null) =>
  name === null ? record : (record.suites?.[name] ?? null);

const NO_DRIFT = { pathAreas: [], session: /(?!)/ };

/**
 * Pages a spec visited outside the areas its `// e2e-areas:` header declares.
 * navigation: { [specFile]: string[] }; headers: Map<specFile, string[]>.
 * Session paths, unmapped paths and specs without a header are never drift.
 */
export function mapDrift(navigation, headers, drift = NO_DRIFT) {
  const areaOfPath = (pathname) => {
    for (const [re, area] of drift.pathAreas)
      if (re.test(pathname)) return area;
    return null;
  };
  const out = [];
  for (const [file, paths] of Object.entries(navigation ?? {})) {
    const declared = headers.get(file);
    if (!declared) continue;
    for (const pathname of paths) {
      if (drift.session.test(pathname)) continue;
      const area = areaOfPath(pathname);
      if (area !== null && !declared.includes(area))
        out.push({ file, pathname, area });
    }
  }
  return out;
}

const redDrift = (drift, flakySpecs) => ({
  status: 'red',
  reason: 'map-drift',
  redSpecs: [...new Set(drift.map((d) => d.file))].sort(),
  flakySpecs,
  drift,
});

/** Status of one run: error when there is no summary, red, amber, else green (N-R2 promotion). */
export function classifyRun({
  summary,
  reason,
  history,
  drift = [],
  suite = null,
}) {
  if (summary === null || summary.stats === null)
    return {
      status: 'error',
      reason: reason ?? 'no-report',
      redSpecs: [],
      flakySpecs: [],
    };
  const flakySpecs = summary.flakySpecs;
  if (summary.stats.unexpected > 0)
    return {
      status: 'red',
      reason: 'failed',
      redSpecs: summary.failedSpecs,
      flakySpecs,
    };
  if (drift.length > 0) return redDrift(drift, flakySpecs);
  const recent = history
    .map((r) => suiteView(r, suite))
    .filter(Boolean)
    .filter(REACHED)
    .sort(byRanAtDesc)
    .slice(0, FLAKY_PROMOTE.of - 1);
  const promoted = flakySpecs.filter(
    (spec) =>
      1 + recent.filter((r) => (r.flakySpecs ?? []).includes(spec)).length >=
      FLAKY_PROMOTE.min,
  );
  if (promoted.length > 0)
    return {
      status: 'red',
      reason: 'flaky-2-of-7',
      redSpecs: promoted,
      flakySpecs,
    };
  if (summary.stats.flaky > 0)
    return { status: 'amber', reason: null, redSpecs: [], flakySpecs };
  return { status: 'green', reason: null, redSpecs: [], flakySpecs };
}

/** Newest run that reached Playwright: { ranAt, ageMs, stale }, or null. */
export function freshness(history, nowMs) {
  const newest = history.filter(REACHED).sort(byRanAtDesc)[0];
  if (!newest) return null;
  const ageMs = nowMs - Date.parse(newest.ranAt);
  return { ranAt: newest.ranAt, ageMs, stale: ageMs > FRESH_MS };
}

/** Reads latest.json and history.jsonl (bad lines skipped; absent files -> null / []). */
export function readNightly(dir) {
  const read = (name) => {
    const p = join(dir, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  };
  let latest = null;
  try {
    latest = JSON.parse(read('latest.json'));
  } catch {
    latest = null;
  }
  const history = read('history.jsonl')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  return { latest, history };
}

export const nightlyDir = (env = process.env) =>
  env.FP_NIGHTLY_DIR ?? join(mainCheckout(), '.turbo', 'nightly');

export const nightlyDirOf = (io) =>
  process.env.FP_NIGHTLY_DIR ?? join(io.mainCheckout, '.turbo', 'nightly');

const REPORT_FILE = /^[^.].*-\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Per-suite retention (R5). The first suite keeps `<dir>/<sha12>-<day>.json` files;
 * another suite keeps `<dir>/<name>/<sha12>-<day>/` run dirs. `keep.reports`:
 * 'history' (a night a history line names), 'all', or the newest N nights;
 * `keep.traces` drops the traces/ of all but the newest N nights.
 */
export function retain(dir, history, suites = []) {
  for (const [i, suite] of suites.entries()) {
    const keep = suite.keep ?? { reports: 'history' };
    if (i === 0) {
      const reports = keep.reports ?? 'history';
      if (reports === 'all') continue;
      const order = [];
      for (const l of history.slice().reverse())
        if (l.report && !order.includes(l.report)) order.push(l.report);
      const limit = Number.isInteger(reports) ? reports : order.length;
      const kept = new Set(order.slice(0, limit));
      for (const f of readdirSync(dir))
        if (REPORT_FILE.test(f) && !kept.has(f))
          rmSync(join(dir, f), { force: true });
      continue;
    }
    const root = join(dir, suite.name);
    if (!existsSync(root)) continue;
    const nights = [];
    for (const l of history) {
      const r = l.suites?.[suite.name]?.report;
      const n = r ? r.split('/')[1] : null;
      if (n && !nights.includes(n)) nights.push(n);
    }
    const order = [...nights.reverse()]; // newest first
    const dirs = readdirSync(root);
    // A run dir no history line names is older than every named one; orphans
    // rank among themselves newest first by name.
    const orphans = dirs
      .filter((n) => !order.includes(n))
      .sort()
      .reverse();
    const rank = (n) =>
      order.includes(n) ? order.indexOf(n) : order.length + orphans.indexOf(n);
    const reports = keep.reports ?? 'history';
    for (const n of dirs) {
      const nightDir = join(root, n);
      if (reports === 'history' && rank(n) >= order.length)
        rmSync(nightDir, { recursive: true, force: true });
      else if (Number.isInteger(reports) && rank(n) >= reports)
        rmSync(nightDir, { recursive: true, force: true });
      else if (keep.traces !== undefined && rank(n) >= keep.traces)
        rmSync(join(nightDir, 'traces'), { recursive: true, force: true });
    }
  }
}

export function writeOutputs(
  dir,
  line,
  redTests,
  firstReport,
  suiteReports = {},
  suites = [],
) {
  mkdirSync(dir, { recursive: true });
  if (line.report !== null)
    writeFileSync(join(dir, line.report), JSON.stringify(firstReport));
  for (const [name, report] of Object.entries(suiteReports)) {
    const rel = line.suites?.[name]?.report;
    if (!rel || report === null) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), JSON.stringify(report));
  }
  const prior = readNightly(dir).history;
  const history = [...prior, line].slice(-HISTORY_MAX);
  writeFileSync(
    join(dir, 'history.jsonl'),
    `${history.map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
  writeFileSync(
    join(dir, 'latest.json'),
    `${JSON.stringify({ ...line, redTests })}\n`,
  );
  retain(dir, history, suites);
}
