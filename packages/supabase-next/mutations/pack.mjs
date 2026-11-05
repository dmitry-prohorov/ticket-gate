// The supabase-next pack: the kinds and harnesses a project
// hands to resolveSetup.
import { nextServed } from './next-served.mjs';
import { sqlKind, sqlKindFrom } from './sql-kind.mjs';

export const mutationKinds = { sql: sqlKind };

/** The kinds when a project sets `sql` options (reset, preflight). */
export const mutationKindsWith = (sql) => ({ sql: sqlKindFrom(sql) });

/** @param {object} opts serve options of the next-served harness (see served()) */
export const mutationHarnesses = (opts) => [nextServed(opts)];
