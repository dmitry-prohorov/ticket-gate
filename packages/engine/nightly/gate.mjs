// What the rest of the engine reads from a gate's `nightly` key: the record, its status line and
// the gate's own e2e run log. Each answers null when the gate has no nightly.
import { appendE2eRun, e2eRunOf } from './e2e-runs.mjs';
import { nightlyDir, readNightly } from './record.mjs';
import { statusLines } from './status.mjs';

/** `{ latest, history }` of the gate's nightly dir, or null without a `nightly` key. */
export function nightlyRecord(gate) {
  return gate?.nightly ? readNightly(nightlyDir()) : null;
}

/** The first status line (what the dry run prints), or null without a `nightly` key. */
export function nightlyLine(gate, nowMs) {
  const cfg = gate?.nightly;
  if (!cfg) return null;
  return statusLines({ ...readNightly(nightlyDir()), queued: 0 }, nowMs, undefined, undefined, cfg)[0];
}

/** Append this gate run's e2e line to the nightly dir; null (nothing written) without a `nightly` key. */
export function recordE2eRun({ gate, results, id, ranAt, dir = nightlyDir() }) {
  if (!gate?.nightly) return null;
  const line = e2eRunOf(results, id, ranAt);
  if (line) appendE2eRun(dir, line);
  return line;
}
