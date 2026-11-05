// The supabase-next pack: the kinds and harnesses a project
// hands to resolveSetup.
import { nextServed } from './next-served.mjs';
import { sqlKind } from './sql-kind.mjs';

export const mutationKinds = { sql: sqlKind };

/** @param {object} opts serve options of the next-served harness (see served()) */
export const mutationHarnesses = (opts) => [nextServed(opts)];
