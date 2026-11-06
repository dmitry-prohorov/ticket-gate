// The selection config the engine tests run on: a web project's values inlined, with a
// demo workspace package, no project rules or checks, and a synthetic ticket-name rule. Not a test file.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { alias, fileRoots, jsGraph } from '../../../graph/js.mjs';
import { playwright } from '../../../runners/playwright.mjs';
import { defineSelection } from '../../../selection/define.mjs';
import { objectTable } from '../../../selection/value-rules.mjs';
import { nextAppRoutes } from '../../../../supabase-next/selection/next-routes.mjs';
import { supabaseFunctions } from '../../../../supabase-next/selection/supabase-rules.mjs';
import { workspaceExports } from '../../../../supabase-next/selection/workspace-exports.mjs';

const AREAS = [
  'auth',
  'onboarding',
  'invite',
  'calendar',
  'editor',
  'detail',
  'timetable',
  'family',
  'settings',
  'telegram',
  'legal',
];

/** [prefix, area] over paths relative to apps/web/app/. Longest prefix wins; '*' = shell entry. */
const ROUTE_AREAS = [
  ['layout.tsx', '*'],
  ['page.tsx', '*'],
  ['(auth)/', '*'],
  ['auth/callback/', '*'],
  ['(app)/layout.tsx', '*'],
  ['(app)/@drawer/default.tsx', '*'],
  ['auth/', 'auth'],
  ['onboarding/', 'onboarding'],
  ['invite/', 'invite'],
  ['(app)/family/invite/', 'invite'],
  ['.well-known/', 'invite'],
  ['(app)/calendar/', 'calendar'],
  ['(app)/event/new/', 'editor'],
  ['(app)/event/[id]/edit/', 'editor'],
  ['(app)/@drawer/(.)event/new/', 'editor'],
  ['(app)/@drawer/(.)event/[id]/edit/', 'editor'],
  ['(app)/event/[id]/', 'detail'],
  ['(app)/@drawer/(.)event/[id]/', 'detail'],
  ['(app)/timetable/', 'timetable'],
  ['(app)/family/', 'family'],
  ['(app)/settings/', 'settings'],
  ['tg/', 'telegram'],
  ['privacy/', 'legal'],
  ['terms/', 'legal'],
];

/** [importer, imported, area]: the import edge makes `imported` a root of `area`, not of the shell. */
const SHELL_EDGE_AREAS = [
  [
    'apps/web/components/AppShell.tsx',
    'apps/web/components/calendar/LandscapeWeek.tsx',
    'calendar',
  ],
  [
    'apps/web/components/AppShell.tsx',
    'apps/web/components/timetable/LandscapeTimetable.tsx',
    'timetable',
  ],
];

const ENTRY_RE =
  /(^|\/)(page|layout|loading|error|default|template|not-found|global-error)\.tsx$|(^|\/)route\.ts$/;

const FULL_TRIGGERS = [
  'apps/web/app/globals.css',
  'apps/web/tailwind.config.ts',
  'apps/web/postcss.config.mjs',
  'apps/web/next.config.ts',
  'apps/web/proxy.ts',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
  'apps/web/playwright.config.ts',
  'apps/web/public/',
  'apps/web/e2e/fixtures/',
  'apps/web/e2e/sign-in.ts',
  'apps/web/e2e/inbucket.ts',
  'apps/web/e2e/seed-integrity',
  'tools/e2e-seed-copy',
  'tools/e2e-select.mjs',
  'tools/e2e-areas.mjs',
  'tools/e2e/',
  'supabase/migrations/',
  'supabase/seed.sql',
  'supabase/config.toml',
  'supabase/schema/',
  'supabase/templates/',
  'supabase/functions/deno.json',
  'supabase/functions/deno.lock',
  'supabase/functions/import_map.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'turbo.json',
  'tsconfig',
  '.npmrc',
  'packages/config/',
  'packages/core/package.json',
  'packages/core/tsconfig',
  'packages/core/tsup.config.ts',
];

const IGNORED = [
  'apps/web/eslint.config.js',
  'apps/web/vitest.config.ts',
  'apps/web/components.json',
  'apps/web/vercel.json',
  'apps/web/.env.example',
  'apps/web/next-env.d.ts',
  'supabase/tests/',
  'supabase/snippets/',
  'supabase/eslint.config.js',
  'supabase/vitest.config.ts',
  'supabase/tsconfig.json',
  'supabase/package.json',
  'supabase/functions/_test/',
  'packages/core/eslint',
  'packages/core/vitest',
  'tools/e2e-assertions-baseline.json',
];

const I18N_TABLES = [
  'packages/core/src/i18n/en.ts',
  'packages/core/src/i18n/uk.ts',
];

const nextRoutes = nextAppRoutes({
  appDir: 'apps/web/app',
  entryRe: ENTRY_RE,
  routeAreas: ROUTE_AREAS,
});

export const DEMO = defineSelection({
  label: 'e2e-select',
  root: join(dirname(fileURLToPath(import.meta.url)), '../../../../..'),
  areas: AREAS,
  specs: {
    dir: 'apps/web/e2e',
    match: /\.spec\.ts$/,
    header: /^\/\/ e2e-areas: ([a-z]+(, [a-z]+)*)$/,
    setup: new Set(['seed-integrity.setup.ts', 'seed-integrity.teardown.ts']),
    smokeMax: 12,
    ticketNamed: /^tk\d/,
    grandfathered: new Set(['tk1-old.spec.ts']),
  },
  outside: {
    prefixes: [
      'apps/web/',
      'packages/core/',
      'packages/config/',
      'supabase/',
      'tools/e2e-',
      'tools/e2e/',
    ],
    rootRe:
      /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|tsconfig[^/]*\.json|\.npmrc)$/,
    testFile: /\.test\.(ts|tsx|mjs)$/,
    reach: ['tools/'],
  },
  triggers: FULL_TRIGGERS,
  ignored: IGNORED,
  graphs: [
    jsGraph({
      roots: [
        nextRoutes,
        fileRoots(
          [
            'apps/web/proxy.ts',
            'apps/web/next.config.ts',
            'apps/web/tailwind.config.ts',
            'apps/web/playwright.config.ts',
          ],
          '*',
        ),
      ],
      resolvers: [
        alias('@/', 'apps/web'),
        workspaceExports('@demo/core', 'packages/core'),
      ],
      skipEdges: SHELL_EDGE_AREAS,
      tables: I18N_TABLES,
      loadTime: true,
    }),
  ],
  rules: [
    objectTable(I18N_TABLES),
    supabaseFunctions({
      dir: 'supabase/functions/',
      areas: { 'telegram/': 'telegram' },
    }),
  ],
  unreachedOk: ['packages/core/'],
  runner: playwright({
    cmd: ['pnpm', '-F', 'web', 'exec', 'playwright', 'test'],
    specPrefix: 'e2e/',
  }),
  checks: [nextRoutes],
  drift: { map: async () => [] },
  locale: { table: 'packages/core/src/i18n/en.ts' },
  replayPaths: ['apps/web'],
  commands: { self: 'node tools/e2e-select.mjs', verify: 'pnpm verify:ticket' },
});
