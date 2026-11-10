// A project-local pack. A pack is a plain object with a name, a version and hooks; the published
// packs (@ticket-gate/supabase-next, @ticket-gate/react) are built the same way. This one adds:
//   - `ticket-gate db-status`, a command (packCommands);
//   - the database as a payload of the nightly (nightlyPayloads): checked before, reset around the suites.
import { spawnSync } from 'node:child_process';

const db = (root, ...args) =>
  spawnSync(process.execPath, ['gate/db.mjs', ...args], { cwd: root, encoding: 'utf8' });

export function shopPack() {
  return {
    name: 'shop-pack',
    version: '1.0.0',
    packCommands: {
      // `ticket-gate db-status [args]`: the return value is the exit code.
      'db-status': (_args, { root }) => {
        const r = db(root, 'status');
        process.stdout.write(r.stdout);
        return r.status;
      },
    },
    nightlyPayloads: [
      {
        name: 'db',
        // `main` is the main checkout; return { ok: true } or { reason } to skip the night.
        preflight: async (main) => (db(main, 'health').status === 0 ? { ok: true } : { reason: 'db-down' }),
        before: async (wt) => void db(wt, 'reset'),
        after: async (wt) => void db(wt, 'reset'),
      },
    ],
  };
}
