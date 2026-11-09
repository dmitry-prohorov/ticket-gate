// `ticket-gate nightly run [--now] | install | status`: the sub-command switch over the runner,
// the scheduler install and the status printer, with the io the config's payloads add.
import { loadRegistry } from '../mutations/registry.mjs';
import { realIo } from './io.mjs';
import { main as runMain } from './run.mjs';
import { main as statusMain } from './status.mjs';

export const NIGHTLY_USAGE = 'usage: ticket-gate nightly run [--now] | install | status';

/** The runner's io: the real one, the registry loader, then every payload's `io` entries. */
export function nightlyIo(cfg) {
  return {
    ...realIo(),
    registry: cfg.rotate?.registry ?? ((root) => loadRegistry(root)),
    ...Object.assign({}, ...cfg.payloads.map((p) => p.io ?? {})),
  };
}

/** Run one sub-command; resolves to the exit code. */
export async function nightlyMain([sub, ...rest], cfg) {
  if (sub === 'run' && !rest.includes('--install')) return runMain(rest, cfg, nightlyIo(cfg));
  if (sub === 'install' && rest.length === 0) return runMain(['--install'], cfg, nightlyIo(cfg));
  if (sub === 'status') return statusMain(rest, cfg);
  console.error(NIGHTLY_USAGE);
  return 2;
}
