// The Supabase stack descriptor a gate config hands the engine. `services` maps a
// step id to the services that must be healthy; `health` builds the preflight and ready
// commands the engine runs before the stack steps. Pure: no I/O, no project literal.

/**
 * @param {object} cfg
 * @param {Record<string, string[]>} cfg.services step id -> service names
 * @param {string} cfg.cmd the preflight CLI command (no flags)
 * @param {{ preflight: number, ready: number }} [cfg.waits] seconds each command waits
 * @param {unknown} [cfg.reset] passed through untouched, present only when given
 */
export function supabaseStack({
  services,
  cmd,
  waits = { preflight: 20, ready: 90 },
  reset,
}) {
  const stack = {
    services,
    health: {
      step: 'preflight',
      preflight: (ids) =>
        `${cmd} --wait=${waits.preflight} --steps=${ids.join(',')}`,
      ready: (ids) => `${cmd} --wait=${waits.ready} --steps=${ids.join(',')}`,
    },
  };
  if (reset !== undefined) stack.reset = reset;
  return stack;
}
