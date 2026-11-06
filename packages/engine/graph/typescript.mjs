/**
 * `typescript` is the project's, resolved at call time from `from` (the project
 * root), never imported statically by the engine. Dependency-free Node ESM.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { SelectionConfigError } from '../selection/define.mjs';

const cache = new Map();

export function typescript(from = process.cwd()) {
  if (cache.has(from)) return cache.get(from);
  let mod;
  try {
    mod = createRequire(join(from, 'package.json'))('typescript');
  } catch {
    throw new SelectionConfigError(
      `typescript is not resolvable from ${from}: install it there as a devDependency`,
    );
  }
  cache.set(from, mod);
  return mod;
}

/** A module-level `ts` that resolves on first property read, so nothing loads at import time. */
export const lazyTs = () =>
  new Proxy({}, { get: (_, key) => typescript()[key] });
