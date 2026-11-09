// The Supabase stack as a nightly payload: docker must be up, the
// stack must already be running (the nightly never starts it), it is reset
// before the suites and again after them for the main checkout.
import { spawnSync } from 'node:child_process';

export const dockerInfo = async () =>
  spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }).status ===
  0;

export function supabaseStack({ preflight, reset } = {}) {
  if (
    !Array.isArray(preflight) ||
    preflight.length === 0 ||
    !Array.isArray(reset) ||
    reset.length === 0
  )
    throw new TypeError(
      'supabase-next: supabaseStack needs preflight and reset argv arrays',
    );
  return {
    name: 'supabase-stack',
    io: { dockerUp: dockerInfo },
    async preflight(main, io) {
      if (!(await io.dockerUp())) return { reason: 'docker-down' };
      return { ok: true };
    },
    async before(wt, io) {
      const pre = await io.run(preflight[0], preflight.slice(1), {
        cwd: wt,
        limitS: 180,
      });
      if (pre.code !== 0) return { reason: 'stack-down', runAfter: false };
      const rst = await io.run(reset[0], reset.slice(1), {
        cwd: wt,
        limitS: 600,
      });
      if (rst.code !== 0) return { reason: 'reset-failed', runAfter: true };
      return { ok: true };
    },
    async after(main, io) {
      const fr = await io.run(reset[0], reset.slice(1), {
        cwd: main,
        limitS: 600,
      });
      return fr.code === 0 ? 'pass' : 'fail';
    },
  };
}
