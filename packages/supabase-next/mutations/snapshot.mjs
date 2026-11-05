// Pure catalog logic for tools/mutate-check.mjs: the SQL that
// fingerprints the local database, the parsers for its output, the diff between
// two snapshots, the SQL that restores a diff, and the CLI-channel statement
// wrapper. Nothing here spawns a process or touches the filesystem; the loop,
// the channel and the stack live in mutate-check.mjs.
//
// Dependency-free Node ESM.

const SCHEMAS = `('public', 'private', 'cron')`;

// ACL rows as 'grantee|privilege|grantable', sorted. `acl` is the raw aclitem[]
// column, `kind` the acldefault object type ('f' function, 'r' relation).
const aclSql = (
  acl,
  kind,
  owner,
) => String.raw`(select coalesce(array_agg(x.g || '|' || x.p || '|' || x.gr order by x.g collate "C", x.p collate "C", x.gr collate "C"), '{}'::text[])
    from (select case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as g,
                 a.privilege_type::text as p, a.is_grantable::text as gr
            from aclexplode(coalesce(${acl}, acldefault('${kind}', ${owner}))) a) x)`;

const US = String.raw`E'\x1f'`;

/**
 * One row per catalog object: kind, key, fp, "create", "drop", extra (jsonb).
 * The single source for DIGEST_SQL and SNAPSHOT_SQL (equal digests imply equal
 * fp per object). Schemas public, private, cron; extension members skipped.
 */
export const OBJECTS_SQL = String.raw`select 'function'::text as kind,
       format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as key,
       concat_ws(${US}, pg_get_functiondef(p.oid), p.prosecdef::text, coalesce(array_to_string(p.proconfig, ','), ''),
                 array_to_string(${aclSql('p.proacl', 'f', 'p.proowner')}, ',')) as fp,
       rtrim(pg_get_functiondef(p.oid), E' \n\t') as "create",
       format('drop function %s.%s(%s) cascade', quote_ident(n.nspname), quote_ident(p.proname), pg_get_function_identity_arguments(p.oid)) as "drop",
       jsonb_build_object('args', pg_get_function_arguments(p.oid), 'result', coalesce(pg_get_function_result(p.oid), ''),
                          'owner', pg_get_userbyid(p.proowner), 'acl', to_jsonb(${aclSql('p.proacl', 'f', 'p.proowner')})) as extra
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ${SCHEMAS} and p.prokind in ('f', 'p')
   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
union all
select 'policy', format('%I.%I.%I', pl.schemaname, pl.tablename, pl.policyname),
       concat_ws(${US}, pl.permissive, coalesce((select string_agg(r::text, ',' order by r::text collate "C") from unnest(pl.roles) r), ''),
                 pl.cmd, coalesce(pl.qual, ''), coalesce(pl.with_check, '')),
       format('create policy %I on %I.%I as %s for %s to %s%s%s', pl.policyname, pl.schemaname, pl.tablename, lower(pl.permissive), pl.cmd,
              (select string_agg(case when r::text = 'public' then 'public' else quote_ident(r::text) end, ', ' order by r::text collate "C") from unnest(pl.roles) r),
              case when pl.qual is not null then ' using (' || pl.qual || ')' else '' end,
              case when pl.with_check is not null then ' with check (' || pl.with_check || ')' else '' end),
       format('drop policy if exists %I on %I.%I', pl.policyname, pl.schemaname, pl.tablename),
       '{}'::jsonb
  from pg_policies pl
 where pl.schemaname in ${SCHEMAS}
   and not exists (select 1 from pg_class pc join pg_namespace pn on pn.oid = pc.relnamespace join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = pc.oid and d.deptype = 'e'
                    where pn.nspname = pl.schemaname and pc.relname = pl.tablename)
union all
select 'trigger', format('%I.%I.%I', n.nspname, c.relname, t.tgname),
       concat_ws(${US}, pg_get_triggerdef(t.oid), t.tgenabled::text),
       pg_get_triggerdef(t.oid) || case t.tgenabled
         when 'D' then format('; alter table %I.%I disable trigger %I', n.nspname, c.relname, t.tgname)
         when 'R' then format('; alter table %I.%I enable replica trigger %I', n.nspname, c.relname, t.tgname)
         when 'A' then format('; alter table %I.%I enable always trigger %I', n.nspname, c.relname, t.tgname)
         else '' end,
       format('drop trigger if exists %I on %I.%I', t.tgname, n.nspname, c.relname),
       '{}'::jsonb
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where not t.tgisinternal and n.nspname in ${SCHEMAS}
   and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
union all
select 'constraint', format('%I.%I.%I', n.nspname, c.relname, k.conname),
       concat_ws(${US}, k.contype::text, pg_get_constraintdef(k.oid)),
       format('alter table %I.%I add constraint %I %s', n.nspname, c.relname, k.conname, pg_get_constraintdef(k.oid)),
       format('alter table %I.%I drop constraint if exists %I', n.nspname, c.relname, k.conname),
       jsonb_build_object('contype', k.contype::text)
  from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
 where k.conrelid <> 0 and k.contype not in ('t', 'n') and k.conislocal and n.nspname in ${SCHEMAS}
   and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
union all
select 'index', format('%I.%I', n.nspname, ic.relname),
       pg_get_indexdef(i.indexrelid),
       pg_get_indexdef(i.indexrelid),
       format('drop index if exists %I.%I', n.nspname, ic.relname),
       '{}'::jsonb
  from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_namespace n on n.oid = ic.relnamespace
 where n.nspname in ${SCHEMAS}
   and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = i.indrelid and d.deptype = 'e')
   and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.contype in ('p', 'u', 'x'))
union all
select 'table', format('%I.%I', n.nspname, c.relname),
       concat_ws(${US}, c.relrowsecurity::text, c.relforcerowsecurity::text, array_to_string(${aclSql('c.relacl', 'r', 'c.relowner')}, ',')),
       null::text, null::text,
       jsonb_build_object('relkind', c.relkind::text, 'rls', c.relrowsecurity, 'force', c.relforcerowsecurity,
                          'owner', pg_get_userbyid(c.relowner), 'acl', to_jsonb(${aclSql('c.relacl', 'r', 'c.relowner')}))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname in ${SCHEMAS}
   and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
union all
select 'enum', format('%I.%I', n.nspname, t.typname),
       (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid),
       null::text, null::text, '{}'::jsonb
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
 where t.typtype = 'e' and n.nspname in ${SCHEMAS}
union all
select 'cron', coalesce(j.jobname, '#' || md5(j.schedule || j.command)),
       concat_ws(${US}, j.schedule, j.command, j.active::text),
       case when j.active then 'select ' || s.call else format('select cron.alter_job(%s, active := false)', s.call) end,
       format('select cron.unschedule(%s::bigint)', j.jobid),
       jsonb_build_object('jobid', j.jobid)
  from cron.job j
  cross join lateral (select case when j.jobname is null then format('cron.schedule(%L, %L)', j.schedule, j.command)
                                  else format('cron.schedule(%L, %L, %L)', j.jobname, j.schedule, j.command) end as call) s`;

/** One text value: 'MCDIGEST:' || md5 over kind, key and fp of every object || ':MCDIGEST'. */
export const DIGEST_SQL = String.raw`select 'MCDIGEST:' || md5(coalesce(string_agg(o.kind || ${US} || o.key || ${US} || coalesce(o.fp, ''), E'\x1e' order by o.kind collate "C", o.key collate "C"), '')) || ':MCDIGEST'
  from (${OBJECTS_SQL}) o`;

/** One text value: 'MCSNAP:' || base64(json array of every object) || ':MCSNAP'. */
export const SNAPSHOT_SQL = String.raw`select 'MCSNAP:' || translate(encode(convert_to(coalesce(json_agg(row_to_json(o) order by o.kind collate "C", o.key collate "C")::text, '[]'), 'UTF8'), 'base64'), E'\n', '') || ':MCSNAP'
  from (${OBJECTS_SQL}) o`;

/** The 32 hex digits between the MCDIGEST markers, wherever they sit in stdout. */
export function parseDigest(out) {
  const m = /MCDIGEST:([0-9a-f]{32}):MCDIGEST/.exec(String(out));
  if (!m)
    throw new Error(
      'no MCDIGEST marker in the output; run pnpm mutate:check again after pnpm db:reset',
    );
  return m[1];
}

/** CatalogObject[] from the base64 JSON between the MCSNAP markers (extra is flattened in). */
export function parseSnapshot(out) {
  const m = /MCSNAP:([A-Za-z0-9+/=]*):MCSNAP/.exec(String(out));
  if (!m)
    throw new Error(
      'no MCSNAP marker in the output; run pnpm mutate:check again after pnpm db:reset',
    );
  const rows = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  return rows.map(({ extra, ...row }) => ({ ...row, ...(extra ?? {}) }));
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** appeared / missing / changed per kind + key, sorted by kind then key; unchanged omitted. */
export function diffCatalog(base, now) {
  const id = (o) => `${o.kind}\u0000${o.key}`;
  const b = new Map(base.map((o) => [id(o), o]));
  const n = new Map(now.map((o) => [id(o), o]));
  const out = [];
  for (const [k, bo] of b) {
    const no = n.get(k);
    if (!no)
      out.push({ kind: bo.kind, key: bo.key, change: 'missing', base: bo });
    else if (bo.fp !== no.fp)
      out.push({
        kind: bo.kind,
        key: bo.key,
        change: 'changed',
        base: bo,
        now: no,
      });
  }
  for (const [k, no] of n)
    if (!b.has(k))
      out.push({ kind: no.kind, key: no.key, change: 'appeared', now: no });
  return out.sort((x, y) => cmp(x.kind, y.kind) || cmp(x.key, y.key));
}

// prettier-ignore
export const DROP_ORDER = ['policy', 'trigger', 'constraint', 'index', 'cron', 'function'];
// prettier-ignore
export const CREATE_ORDER = ['function', 'table', 'index', 'constraint', 'trigger', 'policy', 'cron'];

// Foreign keys are dropped first and created last (they depend on other constraints/indexes).
const fkRank = (d, last) => {
  if (d.kind !== 'constraint') return 0;
  const fk = (d.now ?? d.base)?.contype === 'f' ? 1 : 0;
  return last ? fk : -fk;
};

const ident = (s) =>
  s === 'PUBLIC'
    ? 'public'
    : /^[a-z_][a-z0-9_$]*$/.test(s)
      ? s
      : `"${s.replaceAll('"', '""')}"`;
const splitAcl = (acl) =>
  (acl ?? []).map((r) => {
    const [grantee, privilege, grantable] = r.split('|');
    return { grantee, privilege, grantable: grantable === 'true' };
  });

// revoke everything non-owner, then grant back the base rows (owner rows never named).
function aclLines(what, key, base, now) {
  const owner = (base ?? now)?.owner;
  const baseRows = splitAcl(base?.acl).filter((r) => r.grantee !== owner);
  const nowRows = splitAcl(now?.acl).filter((r) => r.grantee !== owner);
  const grantees = [
    ...new Set(
      [...baseRows, ...nowRows]
        .map((r) => r.grantee)
        .filter((g) => g !== 'PUBLIC'),
    ),
  ].sort(cmp);
  return [
    `revoke all on ${what} ${key} from ${['public', ...grantees.map(ident)].join(', ')}`,
    ...baseRows.map(
      (r) =>
        `grant ${r.privilege.toLowerCase()} on ${what} ${key} to ${ident(r.grantee)}${r.grantable ? ' with grant option' : ''}`,
    ),
  ];
}

/**
 * The restore for a diff (base is the target). { sql, unrestorable }: sql is one
 * atomic do-block, null for an empty diff or when anything is unrestorable.
 */
export function buildRestore(diff) {
  const unrestorable = new Set();
  const drops = [];
  const creates = [];
  for (const d of diff) {
    const { kind, change, base, now } = d;
    if (kind === 'enum') {
      unrestorable.add('enum');
      continue;
    }
    if (kind === 'table' || kind === 'function') {
      if (base && now && base.owner !== now.owner) unrestorable.add('owner');
    }
    if (kind === 'table' && change !== 'changed') {
      unrestorable.add('table');
      continue;
    }
    if (kind === 'function') {
      const inPlace =
        change === 'changed' &&
        base.args === now.args &&
        base.result === now.result;
      if (!inPlace && (change === 'appeared' || change === 'changed'))
        drops.push(d);
    } else if (change === 'appeared' || change === 'changed') {
      if (kind !== 'table') drops.push(d);
    }
    if (change === 'missing' || change === 'changed') creates.push(d);
  }
  if (unrestorable.size)
    return { sql: null, unrestorable: [...unrestorable].sort() };

  const stmts = [];
  for (const kind of DROP_ORDER)
    for (const d of drops
      .filter((x) => x.kind === kind)
      .sort((x, y) => fkRank(x, false) - fkRank(y, false) || cmp(x.key, y.key)))
      if (d.now.drop) stmts.push(d.now.drop);
  for (const kind of CREATE_ORDER)
    for (const d of creates
      .filter((x) => x.kind === kind)
      .sort((x, y) => fkRank(x, true) - fkRank(y, true) || cmp(x.key, y.key))) {
      const { base, now, key } = d;
      if (kind === 'table') {
        if (base.relkind === 'r' || base.relkind === 'p') {
          stmts.push(
            `alter table ${key} ${base.rls ? 'enable' : 'disable'} row level security`,
            `alter table ${key} ${base.force ? 'force' : 'no force'} row level security`,
          );
        }
        stmts.push(...aclLines('table', key, base, now));
        continue;
      }
      if (base.create) stmts.push(base.create);
      if (kind === 'function')
        stmts.push(...aclLines('function', key, base, now));
    }
  if (!stmts.length) return { sql: null, unrestorable: [] };
  stmts.push(`select pg_notify('pgrst', 'reload schema')`);
  return {
    sql: `do $mutate_check_restore$ begin\n${stmts.map(toPlpgsql).join(';\n')};\nend $mutate_check_restore$;`,
    unrestorable: [],
  };
}

/**
 * Top-level statements of a SQL script. A `;` inside '..', E'..' (backslash
 * escapes), "..", $tag$..$tag$, -- comments and nested block comments does not
 * split. Blank and comment-only pieces are dropped.
 */
export function splitStatements(sql) {
  const out = [];
  let start = 0;
  let meaningful = false;
  const isId = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  const push = (end) => {
    if (meaningful) out.push(sql.slice(start, end).trim());
    meaningful = false;
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (two === '/*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) (depth++, (i += 2));
        else if (sql.startsWith('*/', i)) (depth--, (i += 2));
        else i++;
      }
    } else if (c === "'") {
      const esc = /[eE]/.test(sql[i - 1] ?? '') && !isId(sql[i - 2]);
      meaningful = true;
      i++;
      while (i < sql.length) {
        if (esc && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
    } else if (c === '"') {
      meaningful = true;
      const end = sql.indexOf('"', i + 1);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === '$' && !isId(sql[i - 1])) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      meaningful = true;
      if (!tag) i++;
      else {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
      }
    } else if (c === ';') {
      push(i);
      start = ++i;
    } else {
      if (!/\s/.test(c)) meaningful = true;
      i++;
    }
  }
  push(sql.length);
  return out;
}

const stripLeadingComments = (s) => {
  let t = s.trimStart();
  for (;;) {
    if (t.startsWith('--'))
      t = t
        .slice(t.indexOf('\n') === -1 ? t.length : t.indexOf('\n'))
        .trimStart();
    else if (t.startsWith('/*')) {
      const end = t.indexOf('*/');
      t = (end === -1 ? '' : t.slice(end + 2)).trimStart();
    } else return t;
  }
};

/** A statement as plpgsql: no trailing `;`, a leading `select` becomes `perform`. */
export function toPlpgsql(stmt) {
  const body = stmt.trim().replace(/;+\s*$/, '');
  const head = /^(\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)select\b/i.exec(
    body,
  );
  return head ? `${head[1]}perform${body.slice(head[0].length)}` : body;
}

const NO_WRAP = new Set([
  'do',
  'begin',
  'start',
  'commit',
  'end',
  'rollback',
  'savepoint',
  'release',
  'with',
  'copy',
  'vacuum',
]);

/**
 * The CLI channel runs one statement per call, so a multi-statement apply goes
 * inside one do-block. A single statement (a `do` block included) is untouched.
 */
export function wrapForCli(sql) {
  const stmts = splitStatements(sql);
  if (stmts.length < 2) return sql;
  if (sql.includes('$mutate_check_wrap$'))
    throw new Error(
      'cannot wrap for the CLI channel: the apply already uses $mutate_check_wrap$',
    );
  for (const s of stmts) {
    const word = /^[A-Za-z]+/.exec(stripLeadingComments(s))?.[0].toLowerCase();
    if (word && NO_WRAP.has(word))
      throw new Error(
        `cannot wrap for the CLI channel: a statement starts with "${word}"; put the apply in one do $$ ... $$ block`,
      );
  }
  return `do $mutate_check_wrap$ begin\n${stmts.map(toPlpgsql).join(';\n')};\nend $mutate_check_wrap$;`;
}

const UNCOVERED =
  /\b(?:alter\s+column|(?:add|drop)\s+column|alter\s+(?:type|domain|view|materialized\s+view|sequence|schema|extension|rule)|(?:create|drop)\s+(?:or\s+replace\s+)?(?:type|domain|view|materialized\s+view|sequence|schema|extension|rule|table)|comment\s+on|rename\s+(?:to|column)|(?:set|drop)\s+not\s+null|(?:set|drop)\s+default|owner\s+to|security\s+label|default\s+privileges)\b/i;

/** The first statement shape the digest cannot see (so it cannot prove a restore), or null. */
export function uncoveredStatement(sql) {
  const m = UNCOVERED.exec(sql);
  return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : null;
}

/** supabase_db_<project_id> from the text of supabase/config.toml. */
export function dbContainer(configToml) {
  for (const line of String(configToml).split('\n')) {
    const m = /^\s*project_id\s*=\s*"([^"]+)"/.exec(line);
    if (m) return `supabase_db_${m[1]}`;
  }
  throw new Error(
    'no project_id in supabase/config.toml; set it (supabase init writes one)',
  );
}
