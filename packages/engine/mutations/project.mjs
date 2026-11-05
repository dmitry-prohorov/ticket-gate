// The mutation engine's injection point. The engine modules read the project's Setup through
// `projectSetup()`; whoever drives them (the bin, a script, a test) binds one first with
// `bindSetup(setupOf(gate))`. This module imports nothing outside `node:`: the pack is in the
// gate config's import graph, so importing the config from here would deadlock.
let bound = null;

/** Bind the Setup the engine modules will read; returns it. */
export function bindSetup(setup) {
  bound = setup;
  return setup;
}

function notBound() {
  return new Error(
    'mutations: no setup bound. Run ticket-gate mutate or ticket-gate mutations, or call bindSetup(setupOf(gate)) first',
  );
}

/** The bound Setup. Throws when nothing was bound. */
export const projectSetup = () => {
  if (bound === null) throw notBound();
  return bound;
};
