import { snapshotPath } from './sql-kind.mjs';

const FUNCTION_SNAPSHOT =
  /^supabase\/schema\/functions\/([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\.sql$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The snapshot files an sql entry (and its `also` edits) guards. */
function guardPaths(e) {
  const objects = [e.object, ...(e.also ?? []).map((a) => a.object)];
  return objects.flatMap((o) => snapshotPath(o));
}

function schemaChanged(ctx, key, rec) {
  const e = rec.entry;
  return e.kind === 'sql' && guardPaths(e).some((p) => ctx.changed.has(p));
}

export { FUNCTION_SNAPSHOT, escapeRe, guardPaths, schemaChanged };
