// The engine's config-taking functions bound to the demo nightly (demo-nightly.mjs), under the
// names the ported tests use.
import { realIo as engineRealIo } from '../../../nightly/io.mjs';
import { mapDrift as engineMapDrift } from '../../../nightly/record.mjs';
import {
  main as engineMain,
  runMutationPhase as engineRunMutationPhase,
  runNightly as engineRunNightly,
} from '../../../nightly/run.mjs';
import {
  fixSeed as engineFixSeed,
  selectionSelects as engineSelectionSelects,
} from '../../../nightly/seed.mjs';
import {
  main as engineStatusMain,
  statusLines as engineStatusLines,
} from '../../../nightly/status.mjs';
import { dockerInfo } from '../../../../supabase-next/nightly/stack-payload.mjs';
import { interimSelects, nightly, tokenOf } from './demo-nightly.mjs';

export {
  MUTATION_BATCH,
  MUTATION_BUDGET_MS,
  MUTATION_GRACE_S,
} from '../../../nightly/run.mjs';
export { nightly, tokenOf };

export const realIo = () => ({
  ...engineRealIo(),
  dockerUp: dockerInfo,
  registry: nightly.rotate.registry,
});
export const runNightly = (io, opts = {}) =>
  engineRunNightly(io, { ...opts, config: nightly });
export const runMutationPhase = (io, opts) =>
  engineRunMutationPhase(io, { command: nightly.rotate.command, ...opts });
export const main = (argv) => engineMain(argv, nightly, realIo());
export const statusMain = (argv) => engineStatusMain(argv, nightly);
export const statusLines = (state, nowMs, git, selects) =>
  engineStatusLines(state, nowMs, git, selects, nightly);
export const selectionSelects = (input) =>
  engineSelectionSelects({ interim: interimSelects, ...input });
export const mapDrift = (navigation, headers) =>
  engineMapDrift(navigation, headers, nightly.drift);
export const fixSeed = (input) =>
  engineFixSeed({ ...input, selects: input.selects ?? interimSelects });
