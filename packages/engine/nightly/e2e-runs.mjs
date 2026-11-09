// The gate's own e2e runs, one JSON line each, beside the nightly record. The nightly
// status reads them to say how much of the last two weeks the gate spent in a forced
// full run. Dependency-free Node ESM (`node:` only).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const E2E_RUNS_FILE = 'e2e-runs.jsonl';
export const E2E_RUNS_MAX = 1000;
export const FORCED_WINDOW_MS = 14 * 24 * 3_600_000;
export const FORCED_MAX = 0.25;

/** The e2e step's line for one gate run, or null when it did not pass or fail. */
export function e2eRunOf(results, id, ranAt) {
  const r = results.find(
    (x) =>
      x.id === id &&
      ['pass', 'fail'].includes(x.status) &&
      typeof x.mode === 'string',
  );
  return r ? { ranAt, ms: r.ms, mode: r.mode, why: r.why ?? null } : null;
}

/** Every parsable line of `<dir>/e2e-runs.jsonl`; a missing file is []. */
export function readE2eRuns(dir) {
  let text;
  try {
    text = readFileSync(join(dir, E2E_RUNS_FILE), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // an unparsable line is skipped
    }
  }
  return out;
}

/** Append `line`, keeping the newest `max` lines. */
export function appendE2eRun(dir, line, max = E2E_RUNS_MAX) {
  mkdirSync(dir, { recursive: true });
  const lines = [...readE2eRuns(dir), line];
  writeFileSync(
    join(dir, E2E_RUNS_FILE),
    `${lines
      .slice(-max)
      .map((l) => JSON.stringify(l))
      .join('\n')}\n`,
  );
}

/** Share of the last 14 days' gate e2e time spent in a forced full run. */
export function forcedShare(runs, nowMs) {
  const recent = runs.filter(
    (r) =>
      Number.isFinite(r.ms) && nowMs - Date.parse(r.ranAt) <= FORCED_WINDOW_MS,
  );
  const totalMs = recent.reduce((a, r) => a + r.ms, 0);
  if (totalMs === 0) return { share: null, totalMs: 0 };
  const forced = recent
    .filter(
      (r) =>
        r.mode === 'full' &&
        typeof r.why === 'string' &&
        r.why.startsWith('nightly '),
    )
    .reduce((a, r) => a + r.ms, 0);
  return { share: forced / totalMs, totalMs };
}
