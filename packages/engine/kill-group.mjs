// Process-group kill helpers shared by stack-preflight.mjs and mutate-check.mjs. A leaf
// module: stack-preflight.mjs reads gate.config.mjs at load, so mutate-check.mjs (which
// gate.config.mjs hands to the pack) must not import it.
export const killGroup = (pid, sig) => process.kill(-pid, sig);

/** killGroup that ignores ESRCH: the group may already be gone. */
export function safeKillGroup(pid, sig) {
  try {
    killGroup(pid, sig);
  } catch {
    // ESRCH: the group is already gone
  }
}
