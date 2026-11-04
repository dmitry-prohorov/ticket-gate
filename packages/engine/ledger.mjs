import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { VERIFIED_STATUSES } from './digest.mjs';
import { ROOT } from './root.mjs';
import { HISTORY_REL, readHistory } from './tree.mjs';
import { formatMs } from './summary.mjs';

export const LEDGER_REL = '.turbo/ticket-verify-steps.jsonl';

export const LEDGER = join(ROOT, LEDGER_REL);

export const LEDGER_MAX = 200;

// One line per e2e spec per run, kept apart from the step ledger.
export const SPEC_LEDGER = join(ROOT, '.turbo', 'ticket-verify-specs.jsonl');

export const SPEC_LEDGER_MAX = 2000;

export const HISTORY = join(ROOT, HISTORY_REL);

export const HISTORY_MAX = 50;

/** { treeHash, ranAt } (exactly these keys) of a green receipt, else null. */
export function historyEntry(receipt) {
  if (receipt?.ok !== true) return null;
  if (receipt.oversize === true) return null;
  // prettier-ignore
  if (!(receipt.results ?? []).every((r) => VERIFIED_STATUSES.includes(r.status))) return null;
  if (typeof receipt.treeHash !== 'string') return null;
  return { treeHash: receipt.treeHash, ranAt: receipt.ranAt };
}

const writeLines = (path, entries) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    `${path}.tmp`,
    entries.map((e) => `${JSON.stringify(e)}\n`).join(''),
  );
  renameSync(`${path}.tmp`, path);
};

/** No history file yet and receiptPath holds a receipt historyEntry accepts: write that one line. */
export function seedHistory(historyPath, receiptPath) {
  if (existsSync(historyPath)) return false;
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  } catch {
    return false;
  }
  const entry = historyEntry(receipt);
  if (!entry) return false;
  writeLines(historyPath, [entry]);
  return true;
}

/** historyEntry(receipt) null: no write. Else keep the newest HISTORY_MAX lines. */
export function appendHistory(historyPath, receipt) {
  const entry = historyEntry(receipt);
  if (!entry) return false;
  const kept = [...readHistory(historyPath), entry].slice(-HISTORY_MAX);
  writeLines(historyPath, kept);
  return true;
}

/** Lines of the step ledger in file order. Missing file -> []; a blank, non-JSON or non-object line is skipped. */
export function readLedger(path = LEDGER) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // a corrupt line is skipped, never fatal
    }
    if (line && typeof line === 'object' && !Array.isArray(line))
      out.push(line);
  }
  return out;
}

/** The newest ledger line matching id, cmd and digest. */
export function newestLedgerLine(ledger, { id, cmd, digest }) {
  return ledger.findLast(
    (l) => l.id === id && l.cmd === cmd && l.digest === digest,
  );
}

/**
 * One ledger line per pass or fail result (a timeout is a fail) whose inputs
 * are still what the plan digested: `digestNow(id, cmd)` is the digest of the
 * tree after the steps ran. A pass is never filed under inputs it did not see.
 */
export function ledgerLines(results, { ranAt, digestNow }) {
  return results
    .filter(
      (r) =>
        (r.status === 'pass' || r.status === 'fail') &&
        typeof r.digest === 'string' &&
        digestNow(r.id, r.cmd) === r.digest,
    )
    .map((r) => ({
      id: r.id,
      cmd: r.cmd,
      digest: r.digest,
      status: r.status,
      ranAt,
      summary: r.summary,
      ms: r.ms,
      ...(r.mode ? { mode: r.mode } : {}),
    }));
}

/** Append `lines` to the ledger at `path`, keeping the newest LEDGER_MAX. */
export function appendLedger(path, lines) {
  writeLines(path, [...readLedger(path), ...lines].slice(-LEDGER_MAX));
}

/** Append `lines` to the spec ledger at `path`, keeping the newest SPEC_LEDGER_MAX. */
export function appendSpecLedger(path, lines) {
  writeLines(path, [...readLedger(path), ...lines].slice(-SPEC_LEDGER_MAX));
}

/** One spec-ledger line per pass or fail entry whose digest still holds after the run. */
export function specLedgerLines(specs, { ranAt, mode, ms, digestNow }) {
  return specs
    .filter(
      (s) =>
        (s.status === 'pass' || s.status === 'fail') &&
        typeof s.digest === 'string' &&
        digestNow(s.file) === s.digest,
    )
    .map((s) => ({
      id: 'e2e-spec',
      file: s.file,
      digest: s.digest,
      status: s.status,
      ranAt,
      mode,
      ms: s.ms ?? ms,
    }));
}

/** D10: median of the newest 5 full e2e passes, with the largest specs of the newest when it is over budget. */
export function fullMedianLine(ledger, specLedger) {
  const runs = ledger
    .filter(
      (l) =>
        l.id === 'e2e' &&
        l.status === 'pass' &&
        typeof l.ms === 'number' &&
        (l.mode ?? 'full') === 'full',
    )
    .slice(-5);
  if (runs.length === 0) return null;
  const sorted = runs.map((l) => l.ms).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const warn = median > FULL_MEDIAN_WARN_MS;
  let line = `e2e full median: ${formatMs(median)} over the last ${runs.length} full runs`;
  if (warn) {
    const newest = runs.at(-1).ranAt;
    const top = specLedger
      .filter(
        (l) =>
          l.id === 'e2e-spec' && l.ranAt === newest && typeof l.ms === 'number',
      )
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map((l) => `${l.file} ${formatMs(l.ms)}`);
    line += `\nWARNING: over the 20 min budget (D10)${top.length ? `; largest specs: ${top.join(', ')}` : ''}`;
  }
  return { line, warn };
}

// D10: a full-suite median above this prints a warning.
export const FULL_MEDIAN_WARN_MS = 20 * 60 * 1000;
