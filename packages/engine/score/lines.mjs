// Line arithmetic over a `git diff -U0` text. Pure.

/** New-side line numbers of a `git diff -U0` text. */
export function parseChangedLines(diffU0) {
  const lines = new Set();
  for (const m of diffU0.matchAll(
    /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
  )) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

/**
 * Base line -> head line for the lines a `git diff -U0` left untouched; null for a
 * base line the diff removed or rewrote.
 */
export function baseToHeadLines(diffU0) {
  const hunks = [];
  for (const m of diffU0.matchAll(
    /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm,
  ))
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  return (line) => {
    let delta = 0;
    for (const h of hunks) {
      // `-a,0` inserts after base line a; `-a,b` rewrites base lines a..a+b-1.
      const last = h.oldCount === 0 ? h.oldStart : h.oldStart + h.oldCount - 1;
      if (h.oldCount > 0 && line >= h.oldStart && line <= last) return null;
      if (line > last) delta += h.newCount - h.oldCount;
    }
    return line + delta;
  };
}
