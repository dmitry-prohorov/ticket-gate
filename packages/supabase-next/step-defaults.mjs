// The supabase-next pack's step defaults: the db:reset command, the e2e trigger test and
// the summaries the project's gate.config.mjs shares between its db and seed steps.
import { pick } from '#engine/config.mjs';
import { tools } from './tools.mjs';

// db:reset regenerates db.types.ts and supabase/schema/, so
// RESET only checks both generated outputs. The untracked guard comes first
// because `git diff` ignores a new snapshot file.
const DRIFT =
  '! git ls-files --others --exclude-standard supabase/schema/ | grep . && git diff --exit-code packages/core/src/db.types.ts supabase/schema/';
export const RESET = `pnpm db:reset && ${DRIFT}`;

export const E2E_FULL_CMD = 'pnpm test:e2e';

export const resetSummary = (out) =>
  pick(out, [/Finished .*db reset/i, /Applying migration/]) ??
  'db:reset applied; db.types.ts clean';

const isTrigger = (p) =>
  tools.e2eAreas.FULL_TRIGGERS.some((t) => p === t || p.startsWith(t));

/**
 * G1 and R4 (a)-(d): does this diff need an e2e run? (e), a tools/ file the
 * harness imports, needs the selector and is main's.
 */
export function e2eWhen(paths) {
  if (paths.some((p) => p.startsWith('apps/web'))) return true;
  // prettier-ignore
  if (paths.some((p) => p.startsWith('packages/core/src/') && !tools.e2eAreas.TEST_FILE_RE.test(p))) return true;
  if (
    paths.some(
      (p) =>
        p.startsWith('supabase/migrations/') ||
        p === 'supabase/seed.sql' ||
        p.startsWith('supabase/functions/'),
    )
  )
    return true;
  if (paths.some(isTrigger)) return true;
  return false;
}
