// The collection half of the pack hooks, with no import: config.mjs reads pack hooks while it
// validates a gate, and pack-hooks.mjs imports the project's loaded gate (project.mjs), which
// imports the config that is being validated. Keeping this function here avoids that cycle.

/**
 * Every pack's hook of that name, in `packs` order, as `{ by, value }` (`by` is the pack's name).
 * For hooks that all packs contribute to, such as mutation kinds and harnesses.
 */
export function packHooksAll(name, config) {
  const out = [];
  for (const pack of config.packs ?? [])
    if (pack?.[name] !== undefined && pack[name] !== null)
      out.push({ by: pack.name, value: pack[name] });
  return out;
}
