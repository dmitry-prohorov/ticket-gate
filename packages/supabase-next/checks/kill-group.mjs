// Process-group kill helpers: signal a spawned child's whole group, not only the child. A leaf
// module with no imports of its own, so any script that spawns a stack, a test run or a server
// can share it without pulling in a config or another script.
export const killGroup = (pid, sig) => process.kill(-pid, sig);

/** killGroup that ignores ESRCH: the group may already be gone. */
export function safeKillGroup(pid, sig) {
  try {
    killGroup(pid, sig);
  } catch {
    // ESRCH: the group is already gone
  }
}
