// How the engine reaches pack behaviour: only through the named hooks a pack in
// `GATE.packs` carries (the supabase-next pack documents its own in
// packs/supabase-next/index.mjs). A missing hook means "no pack does that", and every
// caller keeps working with a fallback; a config with no packs plans and runs.
import { packHooksAll as collectHooks } from './pack-hooks-all.mjs';
import { GATE } from './project.mjs';

/** The first pack's hook of that name, or undefined. */
export function packHook(name, config = GATE) {
  for (const pack of config.packs ?? [])
    if (pack?.[name] !== undefined && pack[name] !== null) return pack[name];
  return undefined;
}

/** A hook that may be a function resolving to its object (a pack's lazy load), or an object. */
export async function packHookAsync(name, config = GATE) {
  const hook = packHook(name, config);
  return typeof hook === 'function' ? await hook() : hook;
}

/**
 * Every pack's hook of that name, in `packs` order, as `{ by, value }` (`by` is the pack's name).
 * For hooks that all packs contribute to, such as mutation kinds and harnesses.
 */
export const packHooksAll = (name, config = GATE) =>
  collectHooks(name, config);
