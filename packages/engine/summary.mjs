/** `(1m05s)`: whole seconds, rounded, seconds padded to two digits. */
export function formatMs(ms) {
  const total = Math.round(ms / 1000);
  return `(${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s)`;
}

/** The lines inside the paste block's fence: one per result in run order, then one Not selected line. */
export function renderSummary(results, notRun, { failures } = {}) {
  const lines = results.map(
    (r) =>
      `${r.cmd}: ${r.summary}${r.ms === undefined ? '' : ` ${formatMs(r.ms)}`}${r.status === 'pass' ? '' : `  [${r.status.toUpperCase()}]`}`,
  );
  if (notRun.length)
    lines.push(`Not selected: ${notRun.map((s) => s.id).join(', ')}`);
  if (failures) lines.push(`Failures: ${failures}`);
  return lines;
}

export const oneLine = (out) =>
  String(out ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ');

const ERROR_LINE = /error|fail|stale|vanish|invalid|differ|drop|unguarded/i;

export const firstError = (out) => {
  const lines = String(out)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => ERROR_LINE.test(l)) ?? lines[0] ?? 'failed';
};
