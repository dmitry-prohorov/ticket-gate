// The wiring between a project's gate config and the mutation engine: the Setup a gate implies,
// the hooks the verify plan, precheck and review map read, and the runner behind
// `ticket-gate mutate` and `ticket-gate mutations`. Imported by the bin, cli, precheck, review-map
// and a project's scripts; never by a pack (a pack is in the gate config's import graph, and
// the config is loaded by ../project.mjs).
import { packHooksAll } from '../pack-hooks.mjs';
import { bindSetup } from './project.mjs';
import { resolveSetup } from './kinds.mjs';
import { sessionOf } from './harness.mjs';
import {
  loadRegistry,
  registryAt as registryAtRef,
} from './registry.mjs';
import {
  registryEntries,
  registryEntriesAt,
  selectChanged,
  splitServed,
} from './select.mjs';
import { ticketFromBranch } from './check.mjs';

/** The Setup a gate implies: `gate.mutations`, `gate.commands` and every pack's kinds and harnesses. */
export function setupOf(gate) {
  const kinds = packHooksAll('mutationKinds', gate).map(({ by, value }) => ({
    name: by,
    mutationKinds: value,
  }));
  const harnesses = packHooksAll('mutationHarnesses', gate).map(
    ({ by, value }) => ({ name: by, mutationHarnesses: value }),
  );
  return resolveSetup({
    ...gate.mutations,
    commands: gate.commands,
    packs: [...kinds, ...harnesses],
  });
}

/**
 * The registry entries this diff touches. `select` is injectable. A
 * selector that throws selects the step (fail closed, like toolsReachE2e): the
 * step then fails through mutate:check with the same error.
 */
export function registryPlan(
  base,
  select = (opts) => selectChanged(opts),
  entries = () => registryEntries(),
) {
  try {
    // Playwright-backed entries are the nightly rotation's, not the gate's.
    const split = splitServed(select({ base }), entries());
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

const hooksOf = new WeakMap();

/**
 * The hooks the engine's plan, dry-run line, precheck and review map read, or null when the gate
 * has no `mutations`. The gate's Setup is built and bound once per gate.
 */
export function registryHooks(gate) {
  if (gate.mutations === undefined) return null;
  if (hooksOf.has(gate)) return hooksOf.get(gate);
  const setup = bindSetup(setupOf(gate));
  const hooks = {
    plan: (base) =>
      registryPlan(
        base,
        (opts) => selectChanged(opts, setup),
        () => registryEntries(undefined, setup),
      ),
    dryLine: registryDryLine,
    entries: () => registryEntries(undefined, setup),
    entriesAt: (base) => registryEntriesAt(base, undefined, setup),
    load: (root) => loadRegistry(root, setup),
    at: (base, root) => registryAtRef(base, root, setup),
    ticketFromBranch,
  };
  hooksOf.set(gate, hooks);
  return hooks;
}

const notConfigured = (cmd, err) => {
  err.call(console, `${cmd}: mutations is not configured; set mutations in gate.config.mjs`);
  return 2;
};

/** Every non-retired entry of the registry, as the harness sees it (`{ id: key, ...entry }`). */
function liveEntries(setup) {
  const { entries } = loadRegistry(undefined, setup);
  return [...entries]
    .filter(([, v]) => !v.entry?.retired)
    .map(([key, v]) => ({ id: key, ...v.entry }));
}

/**
 * Run `mutate`, `mutations check` or `mutations select` for a gate. Binds the gate's Setup,
 * rejects a doubly claimed entry before any test runs, and returns the exit code.
 */
export async function runMutationCommand(
  cmd,
  argv,
  gate,
  { err } = console,
) {
  if (gate.mutations === undefined) return notConfigured(cmd, err);
  let setup;
  try {
    setup = setupOf(gate);
  } catch (e) {
    err.call(console, e.message);
    return 2;
  }
  bindSetup(setup);
  try {
    for (const entry of liveEntries(setup)) sessionOf(entry, setup);
  } catch (e) {
    err.call(console, e.message);
    return 2;
  }
  const args = argv.map((a) => (a === '--defer' ? '--defer-playwright' : a));
  process.argv = [process.argv[0], process.argv[1], ...args];
  if (cmd === 'mutate') {
    const cli = await import('./cli.mjs');
    await cli.main();
    return Number(process.exitCode ?? 0);
  }
  if (cmd === 'mutations check') {
    const check = await import('./check.mjs');
    return check.main(args, setup);
  }
  if (cmd === 'mutations select') {
    const select = await import('./select.mjs');
    await select.main();
    return Number(process.exitCode ?? 0);
  }
  err.call(console, `ticket-gate: unknown mutation command ${cmd}`);
  return 2;
}
