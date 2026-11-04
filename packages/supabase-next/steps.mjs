import { tools } from './tools.mjs';

/**
 * The registry entries this diff touches. `select` is injectable. A
 * selector that throws selects the step (fail closed, like toolsReachE2e): the
 * step then fails through mutate:check with the same error.
 */
export function registryPlan(
  base,
  select = (opts) => tools.mutationSelect.selectChanged(opts),
  entries = () => tools.mutationSelect.registryEntries(),
) {
  try {
    // Playwright-backed entries are the nightly rotation's, not the gate's.
    const split = tools.mutationSelect.splitServed(select({ base }), entries());
    const keys = split.run.map((s) => s.key);
    const deferred = split.deferred.map((s) => s.key);
    return { when: keys.length > 0, keys, deferred, error: null };
  } catch (err) {
    return { when: true, keys: [], error: err.message };
  }
}

export const registryDryLine = (p) =>
  p.error
    ? `mutation-registry: selection failed (${p.error}); the step runs`
    : `mutation-registry: ${p.keys.length} selected (${p.keys.slice(0, 10).join(', ')}${p.keys.length > 10 ? ', ...' : ''}), ${p.deferred?.length ?? 0} Playwright-backed deferred to the nightly`;
