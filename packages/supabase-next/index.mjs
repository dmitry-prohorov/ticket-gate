// The supabase-next pack: a factory, so gate.config.mjs hands it the project modules it
// needs (tools.mjs) and the pack imports nothing outside tools/gate/. The version is a
// digest input (inputState `packs`): bump it when a step's command, selector or summary
// changes behaviour, and every reusable step re-runs once.
//
// The engine reaches the pack only through these hooks (tools/gate/pack-hooks.mjs); a pack
// without one is a pack that does not do that:
//   mutationKinds     { sql }                      the mutation kinds this pack contributes
//   mutationHarnesses [nextServed(opts)] or []     the served-test harness, when `mutations` is given
//   nightly    { line(nowMs), read() }       the dry-run's nightly status line; `read()` is the
//              nightly record `{ latest, history }` the engine's nightly units plan from
//   sqlRanges  { H1_REASON, migrationFacts, migrationReadRanges }   migration read ranges
//   packCommands  { 'stack-preflight', 'db-schema' }   CLI commands, each only when its option is given
// It also carries `e2eWhen` for gate.config.mjs's e2e step.
import { packCommandsFor } from './commands.mjs';
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

export function supabaseNext({ tools: project, mutations, sql, stackPreflight, dbSchema } = {}) {
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
      read: () => tools.nightly.readNightly(tools.nightly.nightlyDir()),
    },
    sqlRanges: { H1_REASON, migrationFacts, migrationReadRanges },
    packCommands: packCommandsFor({ stackPreflight, dbSchema }),
    e2eWhen,
  };
}
