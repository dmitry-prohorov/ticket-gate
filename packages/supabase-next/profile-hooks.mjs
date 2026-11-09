// Supabase hooks for the React profiler: reset the local database, read the
// magic link from Mailpit, and the two service probes.
import {
  runBounded,
  stackPreflight,
} from './checks/stack-preflight.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reset the local db. Re-checks the stack first (a red stack throws, no reset) and bounds the reset to 300 s. */
export async function dbReset(io) {
  const problems = await io.checkStack(['db']);
  if (problems.length > 0) throw new Error(`dbReset: ${problems.join('; ')}`);
  const r = await io.run('pnpm db:reset', { limitS: 300 });
  if (r.timedOut === true) throw new Error('dbReset: TIMEOUT after 300 s');
  if (r.code !== 0 && r.code !== undefined)
    throw new Error(`dbReset: pnpm db:reset exited ${r.code}`);
}

export function mailpitMagicLink({ mailUrl, email }) {
  return async (since) => {
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const query = encodeURIComponent(`to:"${email}"`);
      const list = await (
        await fetch(`${mailUrl}/api/v1/search?query=${query}`, {
          signal: AbortSignal.timeout(10_000),
        })
      ).json();
      const m = (list.messages ?? []).find(
        (x) => Date.parse(x.Created) >= since - 2000,
      );
      if (!m) continue;
      const msg = await (
        await fetch(`${mailUrl}/api/v1/message/${m.ID}`, {
          signal: AbortSignal.timeout(10_000),
        })
      ).json();
      await fetch(`${mailUrl}/api/v1/messages`, {
        method: 'DELETE',
        body: JSON.stringify({ IDs: [m.ID] }),
        signal: AbortSignal.timeout(10_000),
      });
      const url = (msg.Text ?? '').match(/https?:\/\/\S+\/auth\/v1\/verify\S*/);
      if (url) return url[0];
    }
    throw new Error(`no magic link for ${email} in Mailpit (${mailUrl})`);
  };
}

/** `stack` is { ...STACK_PREFLIGHT, services }. */
export function profileHooks({ root, stack, apiUrl, mailUrl, email }) {
  const checked = stackPreflight({ ...stack, root });
  const io = {
    checkStack: async (steps) =>
      (await checked.checkStack({ steps }, checked.realIo(root))).problems,
    run: (cmd, opts) => runBounded(cmd, { cwd: root, ...opts }),
  };
  const problems = {
    noSupabase: `the Supabase API (${apiUrl}) does not answer: pnpm supabase start`,
    noMailpit: `Mailpit (${mailUrl}) does not answer: pnpm supabase start`,
  };
  return {
    reset: () => dbReset(io),
    magicLink: mailpitMagicLink({ mailUrl, email }),
    services: [
      { url: `${apiUrl}/auth/v1/health`, problem: problems.noSupabase },
      { url: `${mailUrl}/livez`, problem: problems.noMailpit },
    ],
    problems,
  };
}
