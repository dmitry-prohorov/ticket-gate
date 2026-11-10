// The supabase-next pack: a factory, so gate.config.mjs hands it the project modules it
// needs (tools.mjs) and the pack imports nothing outside tools/gate/. The version is a
// digest input (inputState `packs`): bump it when a step's command, selector or summary
// changes behaviour, and every reusable step re-runs once.
//
// The engine reaches the pack only through these hooks (tools/gate/pack-hooks.mjs); a pack
// without one is a pack that does not do that:
//   mutationKinds     { sql }                      the mutation kinds this pack contributes
//   mutationHarnesses [nextServed(opts)] or []     the served-test harness, when `mutations` is given
//   nightlyPayloads  [supabase-stack]            the nightly's Supabase payload, only when `nightlyStack` is given
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
import { supabaseStack } from './nightly/stack-payload.mjs';
import { e2eWhen } from './step-defaults.mjs';

export function supabaseNext({ tools: project, mutations, sql, stackPreflight, dbSchema, nightlyStack } = {}) {
  bindTools(project);
  return {
    name: 'supabase-next',
    version: '0.0.0-local',
    mutationKinds: sql ? mutationKindsWith(sql) : mutationKinds,
    mutationHarnesses: mutations ? mutationHarnesses(mutations) : [],
    ...(nightlyStack ? { nightlyPayloads: [supabaseStack(nightlyStack)] } : {}),
    sqlRanges: { H1_REASON, migrationFacts, migrationReadRanges },
    packCommands: packCommandsFor({ stackPreflight, dbSchema }),
    e2eWhen,
  };
}
