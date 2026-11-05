import { diffCatalog, buildRestore, uncoveredStatement } from './snapshot.mjs';
import { checkSqlEntry, expandSql } from './sql-object.mjs';
import {
  FUNCTION_SNAPSHOT,
  escapeRe,
  guardPaths,
  schemaChanged,
} from './sql-check.mjs';
import { LIMITS, tail, verdict } from '#engine/mutations/verdict.mjs';
import { PREFLIGHT, sqlIo } from './sql-channel.mjs';

export { PREFLIGHT };

/**
 * Parses an entry's `object`: `function <s>.<n>(<args>)`, `table <s>.<n>`,
 * `type <s>.<n>`, `cron <job>`, and `trigger|policy|constraint
 * <name> on <s>.<t>` (name = the object's own name, schema and table = the
 * table's). null for anything else. This is the one parser.
 */
export function parseObject(o) {
  if (typeof o !== 'string') return null;
  const f = /^function ([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\((.*)\)$/s.exec(
    o,
  );
  if (f) return { kind: 'function', schema: f[1], name: f[2], args: f[3] };
  const t = /^(table|type) ([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/.exec(o);
  if (t) return { kind: t[1], schema: t[2], name: t[3] };
  const c = /^cron (\S+)$/.exec(o);
  if (c) return { kind: 'cron', name: c[1] };
  const n =
    /^(trigger|policy|constraint) ([a-z_][a-z0-9_]*) on ([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/.exec(
      o,
    );
  if (n) return { kind: n[1], name: n[2], schema: n[3], table: n[4] };
  return null;
}

export function objectKind(object) {
  return parseObject(object)?.kind ?? null;
}

/** Candidate snapshot paths for an `object`; [] when it does not parse. */
export function snapshotPath(object) {
  const o = parseObject(object);
  if (!o) return [];
  if (o.kind === 'function')
    return [`supabase/schema/functions/${o.schema}.${o.name}.sql`];
  if (o.kind === 'cron') return ['supabase/schema/cron/jobs.sql'];
  if (o.kind === 'table')
    return [`supabase/schema/tables/${o.schema}.${o.name}.sql`];
  if (o.table !== undefined)
    return [`supabase/schema/tables/${o.schema}.${o.table}.sql`];
  if (o.kind === 'type')
    return [`supabase/schema/types/${o.schema}.${o.name}.sql`];
  return [];
}

/** The lean reset: seed catalog and vault, no db:types / db:schema (tracked files stay put). */
// prettier-ignore
export const LEAN_RESET = 'pnpm supabase db reset && pnpm supabase db query --local -f tools/local-vault.sql';

// The sql session's own bookkeeping lives on the engine's run context.
function sqlCtx(io, ctx) {
  if (ctx.sqlTests === undefined)
    Object.assign(ctx, {
      baseDigest: null,
      baseSnap: null,
      sqlRan: false,
      sqlTests: new Set(),
      proven: async () => (await io.digest()) === ctx.baseDigest,
    });
  return ctx;
}

const kindsOf = (diff) =>
  [...new Set(diff.map((d) => d.kind))].sort().join(', ');

async function readBaseline(io, ctx) {
  if (ctx.baseDigest !== null) return;
  try {
    const digest = await io.digest();
    const snap = await io.snapshot();
    ctx.baseDigest = digest;
    ctx.baseSnap = snap;
  } catch (err) {
    ctx.fatal = `baseline not readable: ${tail(String(err?.message ?? err))}`;
  }
}

// sqlApplied stays set across the reset: a Ctrl-C mid-reset still ends at the seed.
async function finalReset(io, state, ctx) {
  state.sqlApplied = true;
  const r = await io.resetDb();
  if (r.code !== 0) {
    ctx.fatal = `baseline not reproducible: lean db:reset failed after the last mutation: ${tail(r.out)}`;
    return;
  }
  try {
    if (!(await ctx.proven())) ctx.fatal = 'baseline not reproducible (final)';
  } catch (err) {
    ctx.fatal = `baseline not reproducible: ${tail(String(err?.message ?? err))}`;
  }
}

// A killed result is trusted only if the test is also red on a freshly reset db.
async function rerunWithReset(m, io, state, ctx) {
  state.sqlApplied = true;
  const r = await io.resetDb();
  if (r.code !== 0) {
    ctx.fatal = `baseline not reproducible: lean db:reset failed after ${m.id}: ${tail(r.out)}`;
    return { id: m.id, status: 'error', detail: ctx.fatal };
  }
  try {
    if (!(await ctx.proven())) {
      ctx.fatal = `baseline not reproducible (re-run of ${m.id})`;
      return { id: m.id, status: 'error', detail: ctx.fatal };
    }
  } catch (err) {
    ctx.fatal = `baseline not reproducible: ${tail(String(err?.message ?? err))}`;
    return { id: m.id, status: 'error', detail: ctx.fatal };
  }
  return await (ctx.runOne ?? runOne)(m, io, state, ctx);
}

// Re-creates what the mutation changed from the baseline snapshot. { code: 0 }
// when the catalog is proven back at the baseline digest, else { code: 1, out:
// <reason to reset> }.
async function autoRestore(io, ctx) {
  for (let pass = 0; pass < 2; pass++) {
    const diff = diffCatalog(ctx.baseSnap, await io.snapshot());
    const restore = buildRestore(diff);
    if (restore.unrestorable.length)
      return { code: 1, out: restore.unrestorable.join(', ') };
    if (restore.sql !== null) {
      const r = await io.applySql(restore.sql);
      if (r.code !== 0) return { code: 1, out: 'restore failed' };
    }
    if (await ctx.proven()) return { code: 0, out: '' };
  }
  const left = kindsOf(diffCatalog(ctx.baseSnap, await io.snapshot()));
  return { code: 1, out: left || 'digest differs' };
}

async function runOne(m, io, state, ctx) {
  await readBaseline(io, ctx);
  if (ctx.fatal) return { id: m.id, status: 'error', detail: ctx.fatal };
  let result;
  let resetReason = null;
  state.restore = null;
  state.sqlApplied = true;
  ctx.sqlRan = true;
  ctx.sqlTests.add(m.test);
  let a;
  try {
    a = await io.applySql(expandSql(m));
  } catch (err) {
    a = { code: 1, out: String(err?.message ?? err) };
  }
  if (a.code !== 0) {
    resetReason = 'apply failed';
    result = {
      id: m.id,
      status: 'error',
      detail: `apply failed: ${tail(a.out)}`,
    };
  } else {
    try {
      result = verdict(m, await io.run(m.test));
    } catch (err) {
      result = {
        id: m.id,
        status: 'error',
        detail: String(err?.message ?? err),
      };
    }
  }
  const uncovered = uncoveredStatement(expandSql(m));
  if (uncovered) resetReason = `uncovered: ${uncovered}`;
  if (resetReason === null) {
    try {
      // prettier-ignore
      const r = m.restore !== undefined ? await io.applySql(m.restore) : await autoRestore(io, ctx);
      if (r.code !== 0)
        resetReason = m.restore !== undefined ? 'restore failed' : r.out;
      else if (m.restore !== undefined && !(await ctx.proven()))
        resetReason = 'restore failed';
    } catch {
      resetReason = 'restore failed';
    }
  }
  if (resetReason === null) {
    state.sqlApplied = false;
    return result;
  }
  const r = await io.resetDb();
  if (r.code !== 0) {
    ctx.fatal = `baseline not reproducible: lean db:reset failed after ${m.id}: ${tail(r.out)}`;
    return { id: m.id, status: 'error', detail: ctx.fatal };
  }
  state.sqlApplied = false;
  try {
    if (!(await ctx.proven())) {
      ctx.fatal = `baseline not reproducible (${resetReason})`;
      return {
        id: m.id,
        status: 'error',
        detail: `${result.detail}\n${ctx.fatal}`,
      };
    }
  } catch (err) {
    ctx.fatal = `baseline not reproducible: ${tail(String(err?.message ?? err))}`;
    return { id: m.id, status: 'error', detail: ctx.fatal };
  }
  return {
    ...result,
    detail: `${result.detail}\nrestored by reset (${resetReason})`,
  };
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

const OBJECT_GRAMMAR =
  'object must be function <s>.<n>(<args>), table <s>.<n>, type <s>.<n>, cron <job> or trigger|policy|constraint <name> on <s>.<t>';

// The first snapshot that exists, { path, text }, read through readFile (which throws when missing).
function firstReadable(readFile, paths) {
  for (const path of paths) {
    try {
      return { path, text: readFile(path) };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * The `sql` kind: schema and stale rules, the registry area,
 * the select rule, the function-snapshot rename repair, the plan note and the
 * inline session (open = stack preflight, runOne, settle = pollution re-run,
 * close = final reset, interrupt = one lean reset).
 */
export const sqlKind = {
  name: 'sql',
  runs: true,
  fields: [
    'protects',
    'object',
    'find',
    'replace',
    'apply',
    'restore',
    'also',
    'test',
    'testFile',
    'testName',
  ],
  runFields: [
    'file',
    'within',
    'find',
    'replace',
    'apply',
    'restore',
    'test',
    'object',
    'also',
  ],
  shape(e, readFile) {
    const out = [];
    for (const f of ['protects', 'object', 'test', 'testFile'])
      if (!isStr(e[f])) out.push(`${f} must be a non-empty string`);
    // The object form edits a function (find + replace); apply is then optional.
    if ((e.find === undefined || e.apply !== undefined) && !isStr(e.apply))
      out.push('apply must be a non-empty string');
    if (isStr(e.object) && !parseObject(e.object)) out.push(OBJECT_GRAMMAR);
    if (e.restore !== undefined && typeof e.restore !== 'string')
      out.push('restore must be a string');
    out.push(...checkSqlEntry(e, readFile, { shapeOnly: true }));
    return out;
  },
  // What validateSpec adds for a runnable spec entry: apply/restore text, then the
  // shape and snapshot rules of checkSqlEntry (messages as before the split).
  validate(m, readFile) {
    const out = [];
    if (
      m.restore !== undefined &&
      (typeof m.restore !== 'string' || m.restore.trim() === '')
    )
      out.push('"restore" must be a non-empty string');
    // The object form edits a function with find + replace; its
    // "apply" is optional. Every other sql mutation needs one.
    const objectForm = m.find !== undefined;
    if ((m.apply !== undefined || !objectForm) && !isStr(m.apply))
      out.push('sql mutation needs a non-empty "apply"');
    out.push(...checkSqlEntry(m, readFile));
    return out;
  },
  // Existence, the named object and the find against the snapshot body: the
  // snapshot rules of checkSqlEntry (the shape rules are reported apart).
  stale(e, readFile) {
    const out = [];
    const shape = new Set(checkSqlEntry(e, readFile, { shapeOnly: true }));
    for (const why of checkSqlEntry(e, readFile))
      if (!shape.has(why)) out.push(why);
    const o = parseObject(e.object);
    if (o?.kind === 'cron') {
      const found = firstReadable(readFile, snapshotPath(e.object));
      if (found && !found.text.includes(`'${o.name}'`))
        out.push(
          `snapshot ${found.path} does not mention cron job '${o.name}'`,
        );
    }
    return out;
  },
  area(e, dir) {
    const o = parseObject(e.object);
    const stem = !o
      ? 'unknown'
      : o.kind === 'cron'
        ? `cron.${o.name}`
        : `${o.schema}.${o.table ?? o.name}`;
    return `${dir}/db/${stem}.json`;
  },
  // The snapshot files an entry guards, for `mutations:affected`.
  paths: guardPaths,
  selectRules: [['schema', schemaChanged]],
  // A moved function snapshot renames the object (and its apply/restore text).
  // { entry, notes: [[from, to]] } when it applies (or nothing moved),
  // { left: why } when a rename cannot be followed.
  repair(entry, diff) {
    const next = structuredClone(entry);
    const notes = [];
    const o = parseObject(next.object);
    const snap = snapshotPath(next.object)[0];
    const to = snap && diff.renames.get(snap);
    if (o && to) {
      const m = FUNCTION_SNAPSHOT.exec(to);
      if (o.kind !== 'function' || !m)
        return {
          left: `${o.kind} snapshot moved ${snap} -> ${to}; re-aim it by hand`,
        };
      const oldName = `${o.schema}.${o.name}`;
      const newName = `${m[1]}.${m[2]}`;
      const whole = new RegExp(
        `(?<![\\w.$"])${escapeRe(oldName)}(?![\\w$"])`,
        'g',
      );
      next.object = `function ${newName}(${o.args})`;
      for (const f of ['apply', 'restore'])
        if (typeof next[f] === 'string')
          next[f] = next[f].replace(whole, newName);
      notes.push([snap, to]);
    }
    return { entry: next, notes };
  },
  planNote(m) {
    const unc = uncoveredStatement(expandSql(m));
    return unc ? `[reset: uncovered ${unc}]` : null;
  },
  session: {
    name: 'sql',
    order: 0,
    inline: true,
    ioMethods: (h) => ({
      resetDb: () => h.sh(LEAN_RESET, LIMITS.reset),
      ...sqlIo(h),
    }),
    async open(_entries, io) {
      const pre = await io.preflight();
      return pre.code !== 0
        ? { fatal: `stack preflight failed: ${tail(pre.out)}` }
        : {};
    },
    runOne: (m, io, state, ctx) => runOne(m, io, state, sqlCtx(io, ctx)),
    // A killed result is trusted only if the test is also red on a freshly reset db.
    async settle(results, entries, io, state, ctx) {
      const c = sqlCtx(io, ctx);
      if (c.sqlTests.size === 0) return { results, rerun: 0 };
      const red = new Set();
      for (const cmd of c.sqlTests) {
        if ((await io.run(cmd)).code !== 0) red.add(cmd);
      }
      let rerun = 0;
      for (let i = 0; i < results.length && !c.fatal; i++) {
        const m = entries.find((x) => x.id === results[i].id);
        if (!m || results[i].status !== 'killed' || !red.has(m.test)) continue;
        results[i] = await rerunWithReset(m, io, state, c);
        rerun++;
      }
      return { results, rerun };
    },
    async close(io, state, ctx) {
      const c = sqlCtx(io, ctx);
      if (c.sqlRan) await finalReset(io, state, c);
      return c.fatal ? { fatal: c.fatal } : {};
    },
    // A sql mutation in flight ends at the seed via one lean reset.
    async interrupt(state, io, setup) {
      if (state.sqlApplied && (await io.resetDb()).code !== 0)
        console.error(setup.commands.afterFatal);
    },
  },
};

export { finalReset, rerunWithReset, runOne };

const SQL_OPTIONS = ['reset', 'preflight'];

/**
 * The sql kind with a project's own lean reset command and stack preflight; both default to
 * the literals above. Only the session's io methods differ from `sqlKind`.
 */
export function sqlKindWith({ reset = LEAN_RESET, preflight = PREFLIGHT } = {}) {
  return {
    ...sqlKind,
    session: {
      ...sqlKind.session,
      ioMethods: (h) => ({
        resetDb: () => h.sh(reset, LIMITS.reset),
        ...sqlIo(h, { preflight }),
      }),
    },
  };
}

/** Validates `supabaseNext({ sql })` and returns the kind it selects. */
export function sqlKindFrom(sql = {}) {
  for (const k of Object.keys(sql))
    if (!SQL_OPTIONS.includes(k))
      throw new Error(`supabase-next: unknown sql option ${k}`);
  return sqlKindWith(sql);
}
