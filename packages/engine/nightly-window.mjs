// The nightly record an affected run may lean on. Import-free so the selection planner can load
// it while the gate config is still loading (digest.mjs reaches the project config, this does not).

/** D4: the newest nightly an affected run may lean on; equals nightly-status FRESH_MS. */
export const NIGHTLY_MAX_AGE_MS = 36 * 3600 * 1000;
export const AFFECTED_NIGHTLY = Object.freeze(['green', 'amber']);
