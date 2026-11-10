#!/usr/bin/env node
// INFRA-18: is the local Supabase stack healthy enough for the gate steps about to run?
//
//   node tools/stack-preflight.mjs --steps=<ids> [--wait=<sec>]
//   ids: db, seed, integration, e2e, mutation-registry (comma separated). Exit 0 ok, 1 problems, 2 bad args.
//
// Library and CLI. verify-ticket runs the CLI as a step (so the watchdog bounds it),
// mutate-check runs it through its own exec, profile-web calls checkStack. Every
// problem line names the command that fixes it. Dependency-free Node ESM, no build step.
//
// INFRA-75: the body moved to tools/checks/supabase-next/stack-preflight.mjs; this path is the
// CLI shim that binds the family values and keeps every name it exported.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { E2E_SERVICES } from '../../../stack.mjs';
import {
  GRACE_S,
  NEVER_REQUIRED,
  SILENT,
  classify,
  httpAnswers,
  httpStatus,
  killGroup,
  parseDockerPs,
  projectId,
  runBounded as runBoundedIn,
  safeKillGroup,
  stackPreflight,
} from '../../../checks/stack-preflight.mjs';

export {
  GRACE_S,
  NEVER_REQUIRED,
  SILENT,
  classify,
  httpAnswers,
  httpStatus,
  killGroup,
  parseDockerPs,
  projectId,
  safeKillGroup,
};

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

// Moved verbatim from profile-web's PREFLIGHT.noWebEnv.
// A new git worktree has no gitignored env: the build then has no Supabase
// URL and /sign-in never renders its form (a 30 s timeout on the Email field).
export const NO_WEB_ENV =
  'apps/web/.env.local is missing (a new worktree does not copy it): cp apps/web/.env.example apps/web/.env.local, or copy it from the main checkout';

const USAGE =
  'usage: node tools/stack-preflight.mjs --steps=<db,seed,integration,e2e,mutation-registry> [--wait=<sec>]';

const bound = stackPreflight({
  // Step id -> services that must be healthy: gate.config.mjs stacks.supabase.services.
  services: {
    db: ['db', 'pg_meta'],
    seed: ['db', 'pg_meta'],
    integration: ['db', 'kong', 'auth', 'rest'],
    e2e: E2E_SERVICES,
    'mutation-registry': E2E_SERVICES,
  },
  root: ROOT,
  cli: 'pnpm supabase',
  webEnv: { file: 'apps/web/.env.local', missing: NO_WEB_ENV },
  anonKey: {
    file: 'apps/web/.env.example',
    name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  },
  usage: USAGE,
});

export const { REQUIRED, checkStack, waitReady, parseArgs, realIo, main } =
  bound;

/** Run `bash -lc cmd` in its own process group; cwd defaults to the repo. */
export const runBounded = (cmd, { limitS, cwd = ROOT } = {}) =>
  runBoundedIn(cmd, { limitS, cwd });

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
