// The `units` slot of the e2e step: an adapter over the pack's existing e2e
// planning in e2e-units.mjs. That module imports the digest and the ledger, which import
// gate.config.mjs, so it is loaded lazily inside select()/reaches() and never at import:
// gate.config.mjs imports this file.
import { E2E_FULL_CMD } from './step-defaults.mjs';

// An affected run always also runs the smoke tests and the seed-integrity setup
// (affectedListLines), so it never has zero units.
const SMOKE = { id: '@smoke+setup', inputs: [] };

/**
 * `ctx.run` = { e2eFlag, nowMs, fresh, state } is what cli.mjs adds to the plan ctx for a
 * select. Sel.plan is the pack's full e2e plan (finishE2e, the spec ledger and the shadow
 * read it); the engine reads mode, why, units, cmd, prepare and knownRedCount.
 */
export function e2eUnits() {
  return {
    reaches: async (ctx) =>
      (await import('./e2e-units.mjs')).toolsReachE2e(ctx.paths, ctx.base),
    select: async (ctx) => {
      const { planE2e } = await import('./e2e-units.mjs');
      const run = ctx.run ?? {};
      const plan = await planE2e(ctx.paths, ctx.base, {
        flag: run.e2eFlag,
        nowMs: run.nowMs ?? Date.now(),
        fresh: run.fresh ?? false,
        state: run.state,
      });
      return {
        mode: plan.mode,
        why: plan.why,
        units:
          plan.mode === 'affected'
            ? [
                ...plan.selected.map((id) => ({
                  id,
                  inputs: plan.inputs.get(id) ?? [],
                })),
                SMOKE,
              ]
            : [],
        cmd: plan.cmd,
        prepare: plan.prepare,
        knownRedCount: plan.knownRed.length,
        plan,
      };
    },
    cmd: (_units, sel) => sel.cmd ?? E2E_FULL_CMD,
  };
}
