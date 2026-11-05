// The project root: the nearest directory at or above the working directory that holds
// gate.config.mjs. Sync and `node:` only, so the config's own import graph may import it.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Walk up from `start` to the first dir holding gate.config.mjs; none throws. */
export function findRoot(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'gate.config.mjs'))) return dir;
    const up = dirname(dir);
    if (up === dir)
      throw new Error(`ticket-gate: no gate.config.mjs at or above ${start}`);
    dir = up;
  }
}

// TICKET_GATE_ROOT, when set, names the project root outright (resolved against the working
// directory) and skips the walk. A tool that runs the engine against its own tree, with no
// gate.config.mjs there, pins it so an ancestor's config cannot become the root.
// A hook must reach its own fail-closed branch when no config exists (exit 2 on a tick), so the
// shared constant falls back to the working directory instead of throwing at import (exit 1,
// which Claude Code reads as "proceed"). `findRoot` itself still throws.
function rootOrCwd() {
  if (process.env.TICKET_GATE_ROOT) return resolve(process.env.TICKET_GATE_ROOT);
  try {
    return findRoot();
  } catch {
    return process.cwd();
  }
}

export const ROOT = rootOrCwd();
