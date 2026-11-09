// Environment variable names the engine reads or sets. The current prefix is TICKET_GATE_; the
// previous prefix is read as a fallback (with one deprecation line per name per process) and is
// set alongside the new one for the deprecation release. This is the only file that names the
// previous prefix.
export const REMOVED_IN = '0.2.0';
const WARNED = new Set();

export function envName(env, name, { log = console.error, warned = WARNED } = {}) {
  const current = env[`TICKET_GATE_${name}`];
  if (current !== undefined) return current;
  const old = `FP_${name}`;
  const value = env[old];
  if (value === undefined) return undefined;
  if (!warned.has(old)) {
    warned.add(old);
    log(`ticket-gate: ${old} is deprecated; set TICKET_GATE_${name} (${old} is read until ${REMOVED_IN})`);
  }
  return value;
}

export const bothNames = (name, value) => ({
  [`TICKET_GATE_${name}`]: value,
  [`FP_${name}`]: value,
});
