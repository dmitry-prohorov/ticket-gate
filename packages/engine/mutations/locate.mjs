// Where a patch's `find` sits in a source (moved out of registry.mjs so a kind
// module can use it without reaching the project setup).
const WS_RUN = /\s+/g;

/** A global RegExp for `find`: every whitespace run in it matches `\s+`. */
export function findPattern(find) {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(WS_RUN, '\\s+'), 'g');
}

const lineStart = (src, i) => src.lastIndexOf('\n', i - 1) + 1;
const indentOf = (src, ls) => /^[ \t]*/.exec(src.slice(ls))[0].length;

/**
 * The block an anchor opens: from the anchor's line up to, not including, the
 * first later non-blank line indented <= the anchor's whose first character is
 * not `}`, `)` or `]` (end of file when none). { count } when the anchor does
 * not occur exactly once.
 */
export function blockSpan(src, anchor) {
  const hits = [...src.matchAll(findPattern(anchor))];
  if (hits.length !== 1) return { count: hits.length };
  const start = lineStart(src, hits[0].index);
  const indent = indentOf(src, start);
  const from = hits[0].index + hits[0][0].length;
  let pos = src.indexOf('\n', from);
  while (pos !== -1) {
    const ls = pos + 1;
    const line = src.slice(
      ls,
      src.indexOf('\n', ls) === -1 ? src.length : src.indexOf('\n', ls),
    );
    if (
      line.trim() !== '' &&
      indentOf(src, ls) <= indent &&
      !'})]'.includes(line.trim()[0])
    )
      return { start, end: ls };
    pos = src.indexOf('\n', ls);
  }
  return { start, end: src.length };
}

/** Where `find` sits: { count, index, length }; index and length only when count is 1. */
export function locate(src, find, within) {
  if (typeof find !== 'string' || find === '') return { count: 0 };
  let base = 0;
  let hay = src;
  if (within !== undefined) {
    const span = blockSpan(src, within);
    if (span.count !== undefined) return { count: 0, anchorCount: span.count };
    base = span.start;
    hay = src.slice(span.start, span.end);
  }
  const hits = [...hay.matchAll(findPattern(find))];
  if (hits.length !== 1) return { count: hits.length };
  return { count: 1, index: base + hits[0].index, length: hits[0][0].length };
}

export function patchedSource(original, m) {
  const hit = locate(original, m.find, m.within);
  if (hit.count !== 1)
    throw new Error(
      `"find" occurs ${hit.count} times in ${m.file}, must be exactly 1`,
    );
  return (
    original.slice(0, hit.index) +
    m.replace +
    original.slice(hit.index + hit.length)
  );
}
