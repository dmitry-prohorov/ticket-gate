// The supabase-next pack: a factory, so gate.config.mjs hands it the project modules it
// needs (tools.mjs) and the pack imports nothing outside tools/gate/. The version is a
// digest input (inputState `packs`): bump it when a step's command, selector or summary
// changes behaviour, and every reusable step re-runs once.
//
// The engine reaches the pack only through these hooks (tools/gate/pack-hooks.mjs); a pack
// without one is a pack that does not do that:
//   mutationKinds     { sql }                      the mutation kinds this pack contributes
//   mutationHarnesses [nextServed(opts)] or []     the served-test harness, when `mutations` is given
//   nightly    { line(nowMs) }                                  the dry-run's nightly status line
//   e2e        () => Promise<{ reportPath, parseFlag(args), dryLine(plan), finish(result, ctx),
//                finishShadow(plan, results), shadowLine(shadow) }>   loaded lazily: it reads
//              the digest, which imports gate.config.mjs
//   sqlRanges  { H1_REASON, migrationFacts, migrationReadRanges }   migration read ranges
// It also carries `e2eWhen` and `e2eUnits` for gate.config.mjs's e2e step.
import { bindTools, tools } from './tools.mjs';
import {
  mutationHarnesses,
  mutationKinds,
  mutationKindsWith,
} from './mutations/pack.mjs';
import {
  H1_REASON,
  migrationFacts,
  migrationReadRanges,
} from './sql-ranges.mjs';
import { e2eWhen } from './step-defaults.mjs';
import { e2eUnits } from './units.mjs';

export function supabaseNext({ tools: project, mutations, sql } = {}) {
  bindTools(project);
  return {
    name: 'supabase-next',
    version: '0.0.0-local',
    mutationKinds: sql ? mutationKindsWith(sql) : mutationKinds,
    mutationHarnesses: mutations ? mutationHarnesses(mutations) : [],
    nightly: {
      line(nowMs) {
        const { nightlyDir, readNightly, statusLines } = tools.nightly;
        const { latest, history } = readNightly(nightlyDir());
        return statusLines({ latest, history, queued: 0 }, nowMs)[0];
      },
    },
    e2e: async () => {
      const m = await import('./e2e-units.mjs');
      return {
        reportPath: m.E2E_REPORT,
        parseFlag: m.parseE2eFlag,
        dryLine: m.e2eDryLine,
        finish: m.finishE2e,
        finishShadow: m.finishShadow,
        shadowLine: m.shadowLine,
      };
    },
    sqlRanges: { H1_REASON, migrationFacts, migrationReadRanges },
    e2eWhen,
    e2eUnits,
  };
}
