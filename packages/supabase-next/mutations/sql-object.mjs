// The `object` form of a registry `sql` entry (the schema-snapshot form).
//
// A function guard is `object` + `find` + `replace`: the entry names the
// function, and the run edits `pg_get_functiondef(<object>)` instead of
// carrying a whole `create or replace function` copy that goes stale when the
// function changes. This module checks an entry against the committed schema
// snapshot (supabase/schema/) and expands it into the SQL `applySql` runs.
//
// Library only; no CLI. `check-mutations.mjs` calls `checkSqlEntry` and
// `checkProtects` per entry, `mutate-check.mjs` calls `checkSqlEntry` and
// `expandSql`. The object grammar (`parseObject`) and the JS matcher
// (`locate`) are mutate-check's; the Postgres ARE builder here is
// `sqlFindPattern`.
import { locate } from '#engine/mutations/locate.mjs';
import { parseObject, snapshotPath } from './sql-kind.mjs';

export const WHOLE_BODY =
  /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\b|\bpg_get_functiondef\b/i;

// One statement of a grant / revoke / default-privileges / cron apply (or the
// PostgREST schema-reload notify that follows a grant), after
// an optional `do $x$ begin` or `execute '` wrapper is peeled off.
const PRIVILEGE_STATEMENT =
  /^(?:(?:grant|revoke|alter\s+default\s+privileges|select\s+cron\.(?:schedule|unschedule))\b|perform\s+pg_notify\(\s*'pgrst'\s*,)/i;

function peel(statement) {
  return statement
    .replace(/^\s*do\s+\$[A-Za-z0-9_]*\$/i, '')
    .replace(/^\s*begin\b/i, '')
    .replace(/^\s*execute\s+'/i, '')
    .replace(/'\s*$/, '')
    .replace(/^\s*end\s+\$[A-Za-z0-9_]*\$\s*$/i, '')
    .trim();
}

/** True when every statement of an apply is a grant, revoke, default-privileges or cron call. */
export const PRIVILEGE_ONLY = {
  test(apply) {
    const parts = String(apply)
      .split(';')
      .map(peel)
      .filter((s) => s !== '');
    return parts.length > 0 && parts.every((s) => PRIVILEGE_STATEMENT.test(s));
  },
};

const WS_RUN = /\s+/g;

/** A Postgres ARE for `find`: every whitespace run matches `[[:space:]]+`, every other character is literal. */
export function sqlFindPattern(find) {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(WS_RUN, '[[:space:]]+');
}

/** Text between `AS $tag$` and the closing `$tag$` of a function snapshot, or null. */
export function functionBody(snapshot) {
  const open = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(snapshot);
  if (!open) return null;
  const from = open.index + open[0].length;
  const end = snapshot.indexOf(open[1], from);
  return end === -1 ? null : snapshot.slice(from, end);
}

/** True when the table snapshot names the trigger, policy or constraint of `o`. */
function hasNamedObject(text, o) {
  const kinds =
    o.kind === 'constraint' ? 'CONSTRAINT|FK CONSTRAINT' : o.kind.toUpperCase();
  const header = new RegExp(
    `^-- Name: ${o.table} ${o.name}; Type: (?:${kinds});`,
    'm',
  );
  if (header.test(text)) return true;
  return (
    o.kind === 'constraint' && new RegExp(`\\bCONSTRAINT ${o.name} `).test(text)
  );
}

const edits = (entry) => [
  entry,
  ...(Array.isArray(entry.also) ? entry.also : []),
];
const TABLE_KINDS = new Set(['trigger', 'policy', 'constraint']);

/**
 * Why an sql entry is not valid, one string each; [] when valid. Shape rules
 * always; snapshot rules unless `opts.shapeOnly` (a key new on this branch).
 * `readFile(path)` returns the text or throws when the file is missing.
 */
export function checkSqlEntry(entry, readFile, opts = {}) {
  const errors = [];
  if (WHOLE_BODY.test(entry.apply ?? ''))
    errors.push(
      'whole-body apply: a function edit uses object + find + replace',
    );
  if (entry.object === undefined && !PRIVILEGE_ONLY.test(entry.apply ?? ''))
    errors.push(
      'apply without object: only grants, revokes and cron are object-less',
    );
  const own = parseObject(entry.object);
  const hasFind = entry.find !== undefined;
  if (own?.kind === 'function' && hasFind)
    for (const [i, e] of edits(entry).entries()) {
      const at = i === 0 ? entry.object : `also[${i - 1}] ${e.object}`;
      if (parseObject(e.object)?.kind !== 'function')
        errors.push(`${at}: find and replace edit a function object`);
      if (typeof e.find !== 'string' || e.find === '')
        errors.push(`${at}: find must be a non-empty string`);
      if (typeof e.replace !== 'string')
        errors.push(`${at}: replace must be a string`);
    }
  else if (own?.kind === 'function' && !PRIVILEGE_ONLY.test(entry.apply ?? ''))
    errors.push(
      `function object without find: edit it with find + replace; apply alone is only for grants`,
    );
  if (own && own.kind !== 'function' && (hasFind || entry.also !== undefined))
    errors.push(
      `${entry.object}: only a function object takes find, replace or also`,
    );
  if (own && own.kind === 'cron' && !PRIVILEGE_ONLY.test(entry.apply ?? ''))
    errors.push('cron object: apply must be cron.schedule or cron.unschedule');
  if (opts.shapeOnly) return errors;

  for (const edit of edits(entry)) {
    const o = parseObject(edit.object);
    if (!o) continue;
    const file = snapshotPath(edit.object)[0];
    let text = null;
    try {
      text = readFile(file);
    } catch {
      text = null;
    }
    const exists = text !== null;
    if (!exists) {
      errors.push(`unknown object ${edit.object}: ${file} does not exist`);
      continue;
    }
    if (o.kind === 'function') {
      const header = `-- Name: ${o.name}(${o.args}); Type: FUNCTION;`;
      if (!text.includes(header)) {
        errors.push(`unknown object ${edit.object}: no "${header}" in ${file}`);
        continue;
      }
      if (typeof edit.find !== 'string' || edit.find === '') continue;
      const body = functionBody(text.slice(text.indexOf(header)));
      const n = body === null ? 0 : locate(body, edit.find).count;
      if (n !== 1)
        errors.push(
          `find occurs ${n} times in the body of ${edit.object}, must be exactly 1`,
        );
    } else if (TABLE_KINDS.has(o.kind)) {
      if (!hasNamedObject(text, o))
        errors.push(`unknown object ${entry.object} in ${file}`);
    }
  }
  return errors;
}

export { checkProtects } from '#engine/mutations/kinds.mjs';

// A dollar tag whose `$tag$` occurs in none of `texts`.
function freeTag(texts, taken = []) {
  for (let i = 0; ; i++) {
    const tag = `m${i === 0 ? '' : i}`;
    if (!taken.includes(tag) && !texts.some((t) => t.includes(`$${tag}$`)))
      return tag;
  }
}

/** The SQL `applySql` receives for an entry. */
export function expandSql(entry) {
  if (entry.find === undefined) return entry.apply;
  const list = edits(entry);
  const patterns = list.map((e) => sqlFindPattern(e.find));
  const texts = [
    entry.apply ?? '',
    ...patterns,
    ...list.map((e) => e.find),
    ...list.map((e) => e.replace),
  ];
  const outer = freeTag(texts);
  const inner = freeTag(texts, [outer]);
  const q = (s) => `$${inner}$${s}$${inner}$`;
  const groups = new Map();
  list.forEach((e, i) => {
    groups.set(e.object, [...(groups.get(e.object) ?? []), i]);
  });
  const body = [];
  for (const [object, idx] of groups) {
    const o = parseObject(object);
    const label = object.replace(/%/g, '%%');
    body.push(
      `d := pg_get_functiondef('${o.schema}.${o.name}(${o.args})'::regprocedure);`,
      // Edit the body only (prosrc, the last text in the definition): a find in the signature is never meant.
      `b := (select prosrc from pg_proc where oid = '${o.schema}.${o.name}(${o.args})'::regprocedure);`,
      'k := length(d) - strpos(reverse(d), reverse(b)) - length(b) + 2;',
      `if substr(d, k, length(b)) <> b then raise exception 'mutation cannot locate the body of ${label}'; end if;`,
      'h := substr(d, 1, k - 1); t := substr(d, k + length(b));',
    );
    for (const i of idx) {
      const p = q(patterns[i]);
      const r = q(list[i].replace.replace(/\\/g, '\\\\'));
      body.push(
        `if regexp_count(b, ${p}) <> 1 then raise exception 'mutation find occurs % times in ${label}', regexp_count(b, ${p}); end if;`,
        `n := regexp_replace(b, ${p}, ${r});`,
        `if n = b then raise exception 'mutation replace changed nothing in ${label}'; end if;`,
        'b := n;',
      );
    }
    body.push('execute h || b || t;');
  }
  const block = `do $${outer}$ declare d text; n text; b text; h text; t text; k int; begin\n${body.join('\n')}\nend $${outer}$;`;
  return entry.apply ? `${entry.apply.trimEnd()}\n${block}` : block;
}
