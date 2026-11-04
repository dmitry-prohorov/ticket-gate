import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A dollar-quote opener: `$$` or `$tag$`, the tag an identifier not starting with a digit.
const DOLLAR_TAG = /\$([A-Za-z_][A-Za-z_0-9]*)?\$/y;
const FUNCTION_START = /create\s+(?:or\s+replace\s+)?function\b/iy;
const IDENT_CHAR = /[A-Za-z0-9_$]/;
const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z_0-9$]*)';
const FUNCTION_NAME = new RegExp(
  `\\s*(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?\\s*\\(`,
  'y',
);

const unquote = (id) =>
  id.startsWith('"') ? id.slice(1, -1).replace(/""/g, '"') : id.toLowerCase();

/** [schema, name] of the function a statement creates, unqualified = public; null when unreadable. */
function functionName(text, from) {
  FUNCTION_NAME.lastIndex = from;
  const m = FUNCTION_NAME.exec(text);
  if (!m) return null;
  return m[2] === undefined
    ? ['public', unquote(m[1])]
    : [unquote(m[1]), unquote(m[2])];
}

/** The snapshot (the project's schema dump) dumps only public and private. */
const defaultInSnapshot = (schema) =>
  schema === 'public' || schema === 'private';

/** End index of the opaque construct (comment, string, quoted identifier, dollar-quote)
 *  opening at text[i]; -1 when none opens there; null when it never closes. */
function skipOpaque(text, i) {
  const c = text[i];
  if (c === '-' && text[i + 1] === '-') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl;
  }
  if (c === '/' && text[i + 1] === '*') {
    let depth = 1;
    let j = i + 2;
    while (j < text.length && depth > 0) {
      if (text[j] === '/' && text[j + 1] === '*') {
        depth += 1;
        j += 2;
      } else if (text[j] === '*' && text[j + 1] === '/') {
        depth -= 1;
        j += 2;
      } else j += 1;
    }
    return depth === 0 ? j : null;
  }
  if (c === "'") {
    const escapes =
      i > 0 && /[eE]/.test(text[i - 1]) && !IDENT_CHAR.test(text[i - 2] ?? ' ');
    let j = i + 1;
    while (j < text.length) {
      if (escapes && text[j] === '\\') j += 2;
      else if (text[j] === "'") {
        if (text[j + 1] === "'") j += 2;
        else return j + 1;
      } else j += 1;
    }
    return null;
  }
  if (c === '"') {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === '"') {
        if (text[j + 1] === '"') j += 2;
        else return j + 1;
      } else j += 1;
    }
    return null;
  }
  if (c === '$' && !IDENT_CHAR.test(text[i - 1] ?? ' ')) {
    DOLLAR_TAG.lastIndex = i;
    const m = DOLLAR_TAG.exec(text);
    if (!m) return -1;
    const close = text.indexOf(m[0], i + m[0].length);
    return close === -1 ? null : close + m[0].length;
  }
  return -1;
}

/** [start, end) character spans of every function statement; null when the file cannot be parsed. */
function functionSpans(text, inSnapshot) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    const opaque = skipOpaque(text, i);
    if (opaque === null) return null;
    if (opaque !== -1) {
      i = opaque;
      continue;
    }
    FUNCTION_START.lastIndex = i;
    const m = IDENT_CHAR.test(text[i - 1] ?? ' ')
      ? null
      : FUNCTION_START.exec(text);
    if (!m) {
      i += 1;
      continue;
    }
    let j = i + m[0].length;
    let inBody = false;
    for (;;) {
      if (j >= text.length) return null;
      const o = skipOpaque(text, j);
      if (o === null) return null;
      if (o !== -1) {
        if (text[j] === '$') inBody = true;
        j = o;
      } else if (text[j] === ';') {
        if (!inBody) return null;
        break;
      } else j += 1;
    }
    const qn = functionName(text, i + m[0].length);
    if (qn && inSnapshot(qn[0], qn[1])) spans.push([i, j + 1]);
    i = j + 1;
  }
  return spans;
}

/** 1-based inclusive line ranges outside every `create [or replace] function` statement,
 *  adjacent ranges merged, ascending. A function is cut only when inSnapshot(schema, name)
 *  says supabase/schema/functions/ shows it (default: schema public or private); a
 *  pg_temp or create-and-drop helper keeps its body in the ranges. null = read the whole file: no function statement,
 *  an unparseable file (unclosed quote or comment, a function without a dollar-quoted
 *  body), or an empty result. */
export function migrationReadRanges(text, inSnapshot = defaultInSnapshot) {
  const spans = functionSpans(text, inSnapshot);
  if (spans === null) return null;
  if (spans.length === 0) return null;
  const covered = new Uint8Array(text.length);
  for (const [a, b] of spans) covered.fill(1, a, b);
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const ranges = [];
  let offset = 0;
  lines.forEach((line, k) => {
    const end = offset + line.length;
    let cut = true;
    let blank = true;
    for (let p = offset; p < end; p += 1) {
      if (/\s/.test(text[p])) continue;
      blank = false;
      if (!covered[p]) cut = false;
    }
    // A blank line is cut only when it sits inside a span (not between statements).
    if (blank) cut = spans.some(([a, b]) => a < offset && end < b);
    if (!cut) {
      const n = k + 1;
      const last = ranges[ranges.length - 1];
      if (last && last[1] === n - 1) last[1] = n;
      else ranges.push([n, n]);
    }
    offset = end + 1;
  });
  if (ranges.length === 0) return null;
  return ranges;
}

/** The H1 reason tail after the read ranges (`fmt` = the formatted ranges). */
export const H1_REASON = (fmt) =>
  `read lines ${fmt.join(', ')}; function bodies in supabase/schema/functions/`;

/** What `collect` records for a changed path: a migration's text, and whether a function
 *  has its snapshot file (a function is cut from the read ranges only when it does). */
export function migrationFacts(path, root) {
  let text = null;
  if (path.startsWith('supabase/migrations/')) {
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      /* unreadable: read whole */
    }
  }
  const inSnapshot = (schema, name) =>
    existsSync(
      join(root, 'supabase/schema/functions', `${schema}.${name}.sql`),
    );
  return { text, inSnapshot };
}
