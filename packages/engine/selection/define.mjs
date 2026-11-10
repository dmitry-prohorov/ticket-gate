/**
 * The selection config. `defineSelection(input)` fills the defaults and rejects a
 * config that has no graph source or no spec location, so a wrong config fails at load, not mid-run.
 * Dependency-free Node ESM.
 */

export class SelectionConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SelectionConfigError';
  }
}

const missing = (key) =>
  new SelectionConfigError(`selection.${key} is required`);

export function defineSelection(input = {}) {
  const specs = input.specs ?? {};
  if (!specs.dir) throw missing('specs.dir');
  if (!specs.match) throw missing('specs.match');
  if (!specs.header) throw missing('specs.header');
  const out = {
    label: 'e2e-select',
    root: process.cwd(),
    areas: null,
    ...input,
    specs: {
      setup: new Set(),
      smokeMax: Infinity,
      ticketNamed: null,
      grandfathered: new Set(),
      ...specs,
    },
    outside: {
      prefixes: [],
      rootRe: null,
      testFile: null,
      reach: [],
      ...input.outside,
    },
    triggers: input.triggers ?? [],
    ignored: input.ignored ?? [],
    rules: input.rules ?? [],
    unreachedOk: input.unreachedOk ?? [],
    checks: input.checks ?? [],
    runner: input.runner ?? null,
    locale: input.locale ?? null,
    drift: input.drift ?? null,
    replayPaths: input.replayPaths ?? [],
    commands: input.commands ?? {},
  };
  if (!Array.isArray(out.graphs) || out.graphs.length === 0)
    throw missing('graphs');
  return out;
}
