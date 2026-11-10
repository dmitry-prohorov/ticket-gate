// The nightly's one config object. `defineNightly` fills the defaults
// and rejects a config the runner cannot honour; the engine reads nothing else
// about the project. Dependency-free Node ESM.

export const NIGHTLY_DEFAULTS = Object.freeze({
  window: { start: '00:50', end: '06:00', catchUpBy: '00:30' },
  remote: { name: 'origin', branch: 'main' },
  payloads: [],
  keep: { reports: 'history' },
  selects: { interim: () => false, load: null },
  commands: {
    run: 'ticket-gate nightly run',
    install: 'ticket-gate nightly install',
    status: 'ticket-gate nightly status',
  },
});

const bad = (reason) => {
  throw new Error(`nightly config: ${reason}`);
};
const posInt = (n) => Number.isInteger(n) && n > 0;

function checkKeep(keep, where) {
  if (keep.reports !== undefined) {
    const r = keep.reports;
    if (r !== 'all' && r !== 'history' && !posInt(r))
      bad(
        `${where} keep.reports must be 'all', 'history' or a positive integer`,
      );
  }
  if (keep.traces !== undefined && !posInt(keep.traces))
    bad(`${where} keep.traces must be a positive integer`);
}

function checkSuites(suites) {
  if (!Array.isArray(suites) || suites.length === 0)
    bad('suites must list at least one suite');
  const seen = new Set();
  for (const [i, s] of suites.entries()) {
    if (typeof s?.name !== 'string' || s.name === '')
      bad(`suite ${i} has no name`);
    if (seen.has(s.name)) bad(`duplicate suite name '${s.name}'`);
    seen.add(s.name);
    if (typeof s.runner?.run !== 'function')
      bad(`suite '${s.name}' has no runner.run`);
    if (typeof s.limitS !== 'number' || !(s.limitS > 0))
      bad(`suite '${s.name}' limitS must be greater than 0`);
    if (i > 0 && typeof s.runner.statusLine !== 'function')
      bad(
        `suite '${s.name}' needs runner.statusLine (only the first suite may omit it)`,
      );
    checkKeep(s.keep ?? {}, `suite '${s.name}'`);
    if (i === 0 && s.keep?.traces !== undefined)
      bad(`suite '${s.name}' is the first suite and keeps no traces dirs`);
  }
}

function checkPayloads(payloads) {
  const seen = new Set();
  for (const p of payloads) {
    if (
      typeof p?.name !== 'string' ||
      p.name === '' ||
      typeof p.preflight !== 'function'
    )
      bad('a payload needs a name and a preflight function');
    if (seen.has(p.name)) bad(`duplicate payload name '${p.name}'`);
    seen.add(p.name);
  }
}

/** Fill defaults, validate, freeze. Idempotent. */
export function defineNightly(cfg) {
  const d = NIGHTLY_DEFAULTS;
  const out = {
    ...cfg,
    window: { ...d.window, ...cfg.window },
    remote: { ...d.remote, ...cfg.remote },
    payloads: cfg.payloads ?? [],
    keep: { ...d.keep, ...cfg.keep },
    selects: { ...d.selects, ...cfg.selects },
    commands: { ...d.commands, ...cfg.commands },
  };
  checkKeep(out.keep, 'config');
  checkSuites(out.suites);
  checkPayloads(out.payloads);
  const w = out.worktree;
  if (
    typeof w?.dir !== 'string' ||
    w.dir === '' ||
    !Array.isArray(w.install) ||
    w.install.length === 0
  )
    bad('worktree needs dir and install');
  // rotate is optional (no rotation runs without it) but never half-formed.
  if (
    out.rotate !== undefined &&
    (!Array.isArray(out.rotate.command) || out.rotate.command.length === 0)
  )
    bad('rotate needs command');
  // The top-level keep is the default for a suite that names none of its own;
  // the first suite keeps no traces dirs, so it inherits reports only.
  out.suites = out.suites.map((s, i) => ({
    ...s,
    keep:
      i === 0
        ? { reports: out.keep.reports, ...s.keep }
        : { ...out.keep, ...s.keep },
  }));
  return Object.freeze(out);
}
