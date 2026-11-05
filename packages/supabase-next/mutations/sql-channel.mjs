// The sql channel of the mutation io (cut from exec.mjs's
// realIo): psql in the db container, else `supabase db query --local`, resolved
// on the first call. `sqlIo({ exec, sh })` returns the io methods the sql
// session drives.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT } from '#engine/root.mjs';
import { LIMITS, tail } from '#engine/mutations/verdict.mjs';
import {
  dbContainer,
  DIGEST_SQL,
  parseDigest,
  parseSnapshot,
  SNAPSHOT_SQL,
  wrapForCli,
} from './snapshot.mjs';

const PSQL = ['psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-At'];

/** The stack preflight the sql session runs before it opens. */
export const PREFLIGHT = Object.freeze({
  cmd: 'node',
  args: ['tools/stack-preflight.mjs', '--steps=db', '--wait=20'],
  limitS: 30,
});

/**
 * @param {{ exec: Function, sh: Function }} h the engine's child runners
 * @param {{ preflight?: { cmd: string, args: string[], limitS?: number } }} [opts]
 */
export function sqlIo({ exec, sh }, { preflight = PREFLIGHT } = {}) {
  // Resolved on the first SQL call: psql in the db container, else the CLI.
  let channel = null;
  const resolveChannel = async () => {
    if (channel) return channel;
    const container = dbContainer(
      readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8'),
    );
    const probe = await exec(
      'docker',
      ['exec', '-i', container, ...PSQL, '-c', 'select 1'],
      { limitS: LIMITS.probe },
    );
    if (probe.code === 0 && probe.out.trim().split('\n').includes('1')) {
      channel = { kind: 'psql', container };
      console.log(`sql channel: psql (docker exec ${container})`);
    } else {
      const why = probe.out.trim().split('\n')[0] || 'docker not available';
      channel = { kind: 'cli' };
      console.log(`sql channel: supabase db query --local (${why})`);
    }
    return channel;
  };
  const sqlRun = async (sql) => {
    const ch = await resolveChannel();
    if (ch.kind === 'psql') {
      return exec(
        'docker',
        [
          'exec',
          '-i',
          ch.container,
          ...PSQL,
          '-v',
          'ON_ERROR_STOP=1',
          '--single-transaction',
          '-f',
          '-',
        ],
        { input: sql, limitS: LIMITS.sql },
      );
    }
    let wrapped;
    try {
      wrapped = wrapForCli(sql);
    } catch (err) {
      return { code: 1, out: err.message };
    }
    const f = join(tmpdir(), `mutate-check-${process.pid}.sql`);
    writeFileSync(f, wrapped);
    return sh(
      `pnpm supabase db query --local -f ${JSON.stringify(f)}`,
      LIMITS.sql,
    );
  };
  const query = async (sql, parse) => {
    const r = await sqlRun(sql);
    if (r.code !== 0) throw new Error(`catalog query failed: ${tail(r.out)}`);
    return parse(r.out);
  };
  return {
    preflight: () =>
      exec(preflight.cmd, preflight.args, { limitS: preflight.limitS ?? 30 }),
    applySql: sqlRun,
    digest: () => query(DIGEST_SQL, parseDigest),
    snapshot: () => query(SNAPSHOT_SQL, parseSnapshot),
  };
}
