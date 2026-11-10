// The nightly config the ported tests run on: a web project's values inlined (window, worktree
// rule, Playwright suite, Supabase payload, rotation command, launchd label). Not a test file.
import { loadRegistry } from '../../../mutations/registry.mjs';
import { defineNightly } from '../../../nightly/define.mjs';
import { launchd } from '../../../nightly/launchd.mjs';
import { envValue } from '../../../nightly/run.mjs';
import { playwrightSuite } from '../../../nightly/suites.mjs';
import { specHeaders } from '../../../selection/select.mjs';
import { supabaseStack } from '../../../../supabase-next/nightly/stack-payload.mjs';
import { DEMO } from '../../e2e/__tests__/demo-selection.mjs';

/** The non-empty TELEGRAM_BOT_TOKEN value of a dotenv text, else null. */
export const tokenOf = (envText) => envValue(envText, 'TELEGRAM_BOT_TOKEN');

/** [RegExp, area] over URL pathnames, first match wins. */
const PATH_AREAS = [
  [/^\/onboarding/, 'onboarding'],
  [/^\/invite(\/|$)/, 'invite'],
  [/^\/family\/invite/, 'invite'],
  [/^\/\.well-known\//, 'invite'],
  [/^\/calendar/, 'calendar'],
  [/^\/event\/new/, 'editor'],
  [/^\/event\/[^/]+\/edit/, 'editor'],
  [/^\/event\/[^/]+/, 'detail'],
  [/^\/timetable/, 'timetable'],
  [/^\/family/, 'family'],
  [/^\/settings/, 'settings'],
  [/^\/tg/, 'telegram'],
  [/^\/(privacy|terms)/, 'legal'],
  [/^\/auth\/reset/, 'auth'],
];

/** Pathnames every signed-in spec passes through; never drift. */
const SESSION_PATHS = /^\/($|sign-in|check-email|auth\/callback)/;

/** Interim suspect rule; the fallback when selection throws. */
export function interimSelects(files, redSpecs) {
  return files.some(
    (f) =>
      redSpecs.some((s) => f === `apps/web/e2e/${s}`) ||
      (f.startsWith('apps/web/e2e/') && !f.endsWith('.spec.ts')) ||
      f === 'apps/web/playwright.config.ts',
  );
}

export const nightly = defineNightly({
  window: { start: '00:50', end: '06:00', catchUpBy: '00:30' },
  worktree: {
    dir: 'demo-nightly',
    install: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'],
    prepare: [['pnpm', '-F', '@demo/core', 'build']],
    env: [
      { path: 'apps/web/.env.local', reason: 'env-missing' },
      {
        path: 'supabase/functions/.env',
        require: 'TELEGRAM_BOT_TOKEN',
        reason: 'token-missing',
      },
    ],
  },
  suites: [
    {
      name: 'e2e',
      runner: playwrightSuite({
        cmd: ['pnpm', '-F', 'web', 'exec', 'playwright', 'test'],
      }),
      args: ['--retries=2'],
      limitS: 1800,
    },
  ],
  payloads: [
    supabaseStack({
      preflight: [
        'node',
        'tools/stack-preflight.mjs',
        '--wait=90',
        '--steps=seed,e2e',
      ],
      reset: ['pnpm', 'db:reset'],
    }),
  ],
  rotate: {
    command: ['node', 'tools/mutate-check.mjs'],
    registry: (root) => loadRegistry(root),
  },
  drift: {
    pathAreas: PATH_AREAS,
    session: SESSION_PATHS,
    headers: (wt) => specHeaders(wt, DEMO),
  },
  selects: { interim: interimSelects },
  scheduler: launchd({
    label: 'com.example.nightly-e2e',
    template: 'tools/launchd/com.example.nightly-e2e.plist',
    wake: '00:55',
  }),
  commands: {
    run: 'pnpm nightly:e2e',
    install: 'pnpm nightly:install',
    status: 'pnpm nightly:status',
  },
});
