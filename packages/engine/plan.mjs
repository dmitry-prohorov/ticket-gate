import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GATE } from './project.mjs';
import { ROOT } from './root.mjs';
import { globRe, pick } from './config.mjs';
import { newestLedgerLine } from './ledger.mjs';

// Config-only keys (limitS, reuse, stack, option, units) are read here and never copied
// onto a plan step, so they cannot reach the ledger or the receipt.
// A step's `when` is a boolean, a glob list or a function of ctx; `cmd` a string or a
// function of ctx. `base` is the full sha the mutation step compares against; `exists`
// says whether a changed path is still on disk (a deleted file is not mutated).

/** The step ids a red step before which stops the stack steps (`string | string[]`). */
export const stopsOf = (config) => [].concat(config.stopOnRedBefore ?? []);

const globHit = (globs, paths) =>
  paths.some((p) => globs.some((g) => globRe(g).test(p)));
const noUnits = (sel) => sel.mode === 'affected' && sel.units.length === 0;
const selectorFailed = (e) => ({
  mode: 'full',
  why: `unit selector failed: ${e.message}`,
  units: [],
});
const unitsCmd = (s, sel) => s.units.cmd(sel.units, sel);
const healthFn = (stack) => typeof stack.health === 'function';

/** The ctx a step's `when`, `cmd` and `units.select` read. */
export function planCtx(
  paths,
  { base = 'HEAD', exists = (p) => existsSync(join(ROOT, p)) } = {},
) {
  const touched = (prefix) => paths.some((p) => p.startsWith(prefix));
  return { paths, base, exists, touched };
}

const whenOf = (s, ctx) =>
  typeof s.when === 'function'
    ? s.when(ctx)
    : Array.isArray(s.when)
      ? globHit(s.when, ctx.paths)
      : s.when;

/**
 * Awaits `units.select(ctx)` of every units step whose `when` holds (or whose optional
 * `units.reaches(ctx)` says the diff reaches it anyway): { stepId: Sel }. A throwing
 * selector gives a full-mode Sel, never a skipped step. Pass the result to planFor as
 * `opts.units`.
 */
export async function selectUnits(config, ctx) {
  const out = {};
  for (const s of config.steps) {
    if (!s.units) continue;
    try {
      const reached = whenOf(s, ctx) || (await s.units.reaches?.(ctx));
      if (reached) out[s.id] = await s.units.select(ctx);
    } catch (e) {
      out[s.id] = selectorFailed(e);
    }
  }
  return out;
}

const buildPlan = (config, ctx, opts) => {
  const selOf = (s) => {
    if (!s.units) return undefined;
    // A precomputed map is authoritative: a step it does not name has no selection.
    if (opts.units) return opts.units[s.id];
    if (!whenOf(s, ctx)) return undefined;
    let got;
    try {
      got = s.units.select(ctx);
    } catch (e) {
      return selectorFailed(e);
    }
    if (typeof got?.then === 'function') {
      got.catch(() => {});
      throw new Error(
        `units.select of ${s.id} is async: precompute with selectUnits()`,
      );
    }
    return got;
  };
  return config.steps.map((s) => {
    const step = {
      id: s.id,
      when: whenOf(s, ctx),
      why: s.why,
      cmd: typeof s.cmd === 'function' ? s.cmd(ctx) : s.cmd,
      notRun: s.notRun,
      summary: s.summary,
    };
    if (s.failSummary) step.failSummary = s.failSummary;
    if (s.human) step.human = s.human;
    const sel = selOf(s);
    if (sel) {
      step.selection = sel;
      if (noUnits(sel)) {
        step.when = false;
        step.notRun = sel.why;
      } else {
        step.when = true;
        step.cmd = unitsCmd(s, sel);
        if (sel.prepare) step.prepare = sel.prepare;
      }
    }
    return step;
  });
};

/**
 * Pure planning over `config`: which steps run, in what mode, for these changed paths.
 * `opts` = { skip?, units?, exists?, base?, digestOf?, ledger?, fresh?, [option]? }.
 * `steps` are the selected steps in run order; `notRun` the unselected ones;
 * `notSelected` the valid skip ids whose step the diff did not select (a no-op);
 * `unknown` the skip ids that are not step ids; `stopBefore` the ids a red step before
 * which stops the stack steps.
 */
export function planFor(config, paths, opts = {}) {
  const { digestOf, ledger = [], fresh = false } = opts;
  const skip = new Set(opts.skip ?? []);
  const stepIds = config.steps.map((s) => s.id);
  const ctx = planCtx(paths, opts);
  const plan = buildPlan(config, ctx, opts);
  const cfg = (id) => config.steps.find((c) => c.id === id);
  const planned = (id) => plan.find((s) => s.id === id);
  // main decides an option step's `when`, command and list files
  // (`prepare`) through opts[step.option]; a plan without the option is today's.
  for (const s of plan) {
    const o = opts[cfg(s.id).option];
    if (o?.when !== undefined) s.when = o.when;
    if (o?.cmd) s.cmd = o.cmd;
    if (o?.prepare) s.prepare = o.prepare;
  }
  const unknown = [...skip].filter((id) => !stepIds.includes(id));
  // The newest ledger line on this step's (id, cmd, digest), or undefined.
  const lastRun = (s) =>
    newestLedgerLine(ledger, {
      id: s.id,
      cmd: s.cmd,
      digest: digestOf(s.id, s.cmd),
    });
  const modeOf = (s) => {
    if (s.human) return 'human';
    if (skip.has(s.id)) return 'skip';
    const c = cfg(s.id);
    if (digestOf && c.reuse && !fresh) {
      const last = lastRun(s);
      // R1, F4: only a full result with no knownRed stands in for a full run.
      const o =
        opts[c.option] ??
        (s.selection && {
          mode: s.selection.mode,
          knownRedCount: s.selection.knownRedCount,
        });
      // prettier-ignore
      if (c.reuse.fullOnly && (o?.mode === 'affected' || (last?.mode ?? 'full') !== 'full' || (o?.knownRedCount ?? 0) > 0)) return 'run';
      if (last?.status === 'pass') return 'reuse';
    }
    return 'run';
  };
  const withMode = (list) => list.map((s) => ({ ...s, mode: modeOf(s) }));

  // Playwright shares one seed across specs and fails on a used one, so
  // a step that needs a fresh seed is preceded by exactly one reset: in a
  // `satisfiedBy` step if that runs, else in the stack's own reset step.
  const steps0 = withMode(plan.filter((s) => s.when));
  const runs = (id) => steps0.find((s) => s.id === id)?.mode === 'run';
  for (const stack of Object.values(config.stacks)) {
    const { reset } = stack;
    if (!reset) continue;
    planned(reset.step).when =
      reset.before.some(runs) && !reset.satisfiedBy.some(runs);
  }

  // R4: the health step checks the stack steps that actually run, and nothing else.
  for (const [name, stack] of Object.entries(config.stacks)) {
    if (!stack.health || healthFn(stack)) continue;
    const stackRuns = plan
      .filter((s) => cfg(s.id).stack === name && s.when && modeOf(s) === 'run')
      .map((s) => s.id);
    const health = planned(stack.health.step);
    health.when = stackRuns.length > 0;
    health.cmd = stack.health.preflight(stackRuns);
  }

  const selected = plan.filter((s) => s.when);
  const steps = withMode(selected);

  // R3: after a reset passes, wait until the services the later stack steps
  // need are healthy. The step's own cmd is untouched.
  for (const [name, stack] of Object.entries(config.stacks)) {
    const { reset } = stack;
    const runStack = steps.filter(
      (s) => cfg(s.id).stack === name && s.mode === 'run',
    );
    for (const s of steps) {
      if (
        !reset ||
        !stack.health?.ready ||
        (s.id !== reset.step && !reset.satisfiedBy.includes(s.id))
      )
        continue;
      const after = runStack
        .slice(runStack.findIndex((r) => r.id === s.id) + 1)
        .map((r) => r.id);
      if (s.mode === 'run' && after.length) s.ready = stack.health.ready(after);
    }
    if (!reset?.note) continue;
    const by = reset.satisfiedBy.find(runs) ?? reset.step;
    for (const s of steps) {
      if (!reset.note.steps.includes(s.id)) continue;
      const base = s.summary;
      s.summary = (out) => `${base(out) ?? 'passed'}; ${reset.note.text(by)}`;
    }
  }

  // 4.2 form: a function `health` is the step `<stack>:health`, before the stack's first run step.
  for (const [name, stack] of Object.entries(config.stacks)) {
    if (!healthFn(stack)) continue;
    const onStack = (s) => cfg(s.id)?.stack === name && s.mode === 'run';
    const at = steps.findIndex(onStack);
    if (at < 0) continue;
    steps.splice(at, 0, {
      id: `${name}:health`,
      when: true,
      why: `the ${name} stack must be healthy before its steps run`,
      cmd: stack.health(steps.filter(onStack).map((s) => s.id)),
      notRun: `no step needs the ${name} stack`,
      summary: (out) => pick(out, [/.+/]) ?? `${name} stack ok`,
      mode: 'run',
      limitS: 120,
      health: true,
    });
  }

  // Every non-human step carries its digest; a reused one also says where from.
  const withDigest = (s) => {
    if (!digestOf || s.human || s.health) return s;
    const digest = digestOf(s.id, s.cmd);
    if (s.mode !== 'reuse') return { ...s, digest };
    const last = lastRun(s);
    return {
      ...s,
      digest,
      reusedFrom: last.ranAt,
      reusedSummary: String(last.summary ?? 'passed'),
    };
  };

  return {
    steps: steps.map(withDigest),
    notRun: plan.filter((s) => !s.when),
    notSelected: [...skip].filter(
      (id) => stepIds.includes(id) && !selected.some((s) => s.id === id),
    ),
    unknown,
    stopBefore: stopsOf(config),
  };
}

/**
 * The gate's plan. A plan with no precomputed `opts.units` never calls
 * a units selector (a selector is async; cli.mjs awaits selectUnits() first), so a
 * units step runs its own `cmd`, as before units existed.
 */
export const planSteps = (paths, skipIds, opts = {}) =>
  planFor(GATE, paths, { ...opts, skip: skipIds, units: opts.units ?? {} });
