// The gate of the full example: every key of defineGate, each with a working value. The root
// gate.config.mjs re-exports it; every path below is relative to the project root, not to this file.
// Read it top to bottom with README.md beside it; docs/configuration.md in the ticket-gate
// repository is the reference for each key.
import { defineGate, step } from '@ticket-gate/engine';
import { assertions } from '@ticket-gate/engine/checks/assertions.mjs';
import { duplication } from '@ticket-gate/engine/checks/duplication.mjs';
import { moduleSize } from '@ticket-gate/engine/checks/ratchet-options.mjs';
import { surface } from '@ticket-gate/engine/checks/surface.mjs';
import { fileRoots, jsGraph } from '@ticket-gate/engine/graph/js.mjs';
import { resolveSetup } from '@ticket-gate/engine/mutations/kinds.mjs';
import { stryker } from '@ticket-gate/engine/score/adapters/stryker.mjs';

import { nodeTestSuite } from './nightly-suite.mjs';
import { shopPack } from './pack.mjs';

// ---------------------------------------------------------------- shared values

// The mutation registry: one JSON file per area under tools/gate/registry/, one entry per guard.
const mutations = {
  dir: 'tools/gate/registry',
  // Where `mutate <ID>` and `mutate --registry` write their receipts (read by the assertions ratchet).
  receipts: { ticket: '.turbo/mutation-check.json', registry: '.turbo/mutation-registry.json' },
};

// Which end-to-end specs a diff needs: each spec names its areas on line 1, and the import graph
// says which areas a changed file reaches.
const selection = {
  areas: ['checkout', 'catalog'],
  specs: { dir: 'e2e', match: /\.spec\.mjs$/, header: /^\/\/ e2e-areas: ([a-z]+(, [a-z]+)*)$/ },
  outside: { prefixes: ['src/', 'app/', 'e2e/'] },
  triggers: ['e2e/fixtures/', 'package.json'], // a change here needs every spec
  graphs: [
    jsGraph({
      roots: [fileRoots(['app/checkout.mjs'], 'checkout'), fileRoots(['app/catalog.mjs'], 'catalog')],
    }),
  ],
};

// The end-to-end assertion count per area may only go up, unless a green mutation receipt covers the drop.
const assertionsRatchet = assertions({
  name: 'assertions',
  specs: selection.specs,
  areas: selection.areas,
  counters: { asserts: 'assert.' },
  from: 'e2e/',
  receipt: mutations.receipts.ticket,
  baseline: 'tools/gate/assertions.json',
  registry: 'tools/gate/registry/',
  comment: 'Never edit by hand: run ticket-gate ratchet assertions --update.',
  commands: {
    update: 'npx ticket-gate ratchet assertions --update',
    mutate: 'npx ticket-gate mutate <ID>',
    usage: 'npx ticket-gate ratchet assertions [--update]',
  },
  setup: resolveSetup(mutations),
});

const size = moduleSize({
  limits: { module: 120, test: 200 },
  testRe: /\.(test|spec)\.mjs$/,
  roots: ['src', 'app', 'test', 'e2e'],
  baseline: 'tools/gate/module-size.json',
  comment: 'Files over the limit, and how long each may be. Never edit by hand.',
  name: 'module-size',
  cmd: 'npx ticket-gate ratchet module-size',
  fixNew: 'Fix: split the new module.',
  fixGrew: 'Fix: shrink the file back to its baseline.',
  usage: 'npx ticket-gate ratchet module-size [--update [--seed]]',
});

const surfaceRatchet = surface({
  manifest: 'tools/gate/surface.json',
  baseline: 'tools/gate/surface-baseline.json',
  roots: ['gate.config.mjs', 'tools/gate/'],
  comment: 'The pending globs of tools/gate/surface.json. Never edit by hand.',
  fix: 'Classify the file in tools/gate/surface.json, then run npx ticket-gate ratchet surface.',
  usage: 'npx ticket-gate ratchet surface [--update [--seed]]',
});

const dup = duplication({
  packages: { core: 'src/', app: 'app/' }, // a clone across two of these always counts
  withinMax: 8, // a clone inside one package counts above this many lines
  config: 'tools/gate/jscpd.json',
  report: '.turbo/jscpd',
  baseline: 'tools/gate/duplication.json',
  bin: 'node_modules/.bin/jscpd',
  comment: 'Known clones; each needs an "allow" reason. Never edit by hand.',
  name: 'duplication',
  fix: {
    noReport: 'Install jscpd (npm install) and rerun.',
    fresh: 'Extract the shared code instead of copying it.',
    stale: 'Run npx ticket-gate ratchet duplication --update.',
    unreasoned: 'Give each entry an "allow" reason.',
  },
});

// ---------------------------------------------------------------- the gate

export default defineGate({
  base: 'main',

  // Steps run in this order. Each `when` decides from the changed paths whether the step runs.
  steps: [
    step({
      id: 'syntax',
      when: ['src/**', 'app/**', 'tools/**', 'gate.config.mjs'],
      // `cmd` may be a function of ctx: here it checks only the changed .mjs files that still exist.
      cmd: (ctx) =>
        `node --check ${ctx.paths.filter((p) => p.endsWith('.mjs') && ctx.exists(p)).join(' ') || 'gate.config.mjs'}`,
      reuse: false,
      limitS: 60,
    }),
    step({
      id: 'unit',
      when: ['src/**', 'test/**'],
      cmd: 'npm test',
      reuse: { deny: ['*.md', 'docs/', 'e2e/', 'tickets/', 'followups/'] },
      summary: { pick: [/^ℹ pass \d+/] },
      limitS: 300,
    }),
    step({
      id: 'ratchets',
      when: true,
      cmd: 'npx --no-install ticket-gate ratchet --all',
      reuse: false,
      summary: { pick: [/^ratchet --all: .+/] },
    }),
    step({
      id: 'migrate',
      when: ['db/**'],
      cmd: 'node tools/gate/db.mjs migrate',
      reuse: false,
      stack: 'db',
    }),
    step({
      id: 'db-reset',
      when: false, // planned by stacks.db.reset, never by the diff
      cmd: 'node tools/gate/db.mjs reset',
      reuse: false,
      stack: 'db',
    }),
    step({
      id: 'e2e',
      // `when` may be a function of ctx: { paths, base, exists(path), touched(prefix) }.
      when: (ctx) => ['src/', 'app/', 'e2e/', 'db/'].some((p) => ctx.touched(p)),
      cmd: 'npm run e2e',
      reuse: { deny: ['*.md', 'docs/', 'test/', 'tickets/', 'followups/'] },
      stack: 'db',
      summary: { pick: [/^ℹ pass \d+/] },
    }),
    step({
      id: 'staging',
      human: true, // printed and recorded, never run
      when: ['src/**', 'app/**'],
      cmd: 'deploy the branch to staging and click through the checkout',
    }),
  ],

  // A stack is a service some steps need. health runs before the first stack step that runs; the
  // reset runs before e2e unless migrate runs (and leaves a fresh database) first.
  stacks: {
    db: {
      health: () => 'node tools/gate/db.mjs health',
      reset: { step: 'db-reset', before: ['e2e'], satisfiedBy: ['migrate'] },
      services: { migrate: ['db'], 'db-reset': ['db'], e2e: ['db'] },
    },
  },
  // A red step before `migrate` (syntax, unit, ratchets) stops the stack steps: no point touching the database.
  stopOnRedBefore: ['migrate'],

  // Inputs for reuse: e2e/fixtures/ feeds e2e only; tools/gate/ feeds every step.
  dataPaths: { 'e2e/fixtures/': ['e2e'] },
  toolPrefixes: ['tools/'],

  reviewMap: {
    // First match wins; a path no rule matches is HUMAN.
    rules: [
      { id: 'H1', tier: 'HUMAN', reason: 'database migration', match: ({ path }) => path.startsWith('db/migrations/') },
      {
        id: 'H2',
        tier: 'HUMAN',
        reason: 'adds a lint or type suppression',
        match: ({ addedLines }) => addedLines.some(({ text }) => /eslint-disable|@ts-(ignore|expect-error)/.test(text)),
      },
      {
        id: 'H3',
        tier: 'HUMAN',
        reason: 'a dependency changed',
        match: ({ path, depsChanged }) => path === 'package.json' && depsChanged,
      },
      {
        id: 'H4',
        tier: 'HUMAN',
        reason: 'the gate itself',
        match: ({ path }) => path === 'gate.config.mjs' || (path.startsWith('tools/gate/') && path.endsWith('.mjs')),
      },
      { id: 'G1', tier: 'GATED', reason: 'core logic: the mutation registry', match: ({ path }) => path.startsWith('src/') },
      { id: 'G2', tier: 'GATED', reason: 'registry and baselines: read the diff', match: ({ path }) => path.startsWith('tools/gate/') },
      { id: 'M1', tier: 'MACHINE', reason: 'pages: the e2e specs cover them', match: ({ path }) => path.startsWith('app/') },
      { id: 'M2', tier: 'MACHINE', reason: 'tests', match: ({ path }) => /^(test|e2e)\//.test(path) },
      { id: 'M3', tier: 'MACHINE', reason: 'docs, tickets, follow-ups', match: ({ path }) => path.endsWith('.md') },
    ],
    sizeExcluded: ['M2', 'M3', 'tools/gate/registry/**'],
    humanLines: [{ match: 'db/migrations/**', line: 'apply it to a copy of production first: node tools/gate/db.mjs migrate' }],
    warn: 300,
    oversize: 600,
    splitHint: 'split by layer: src/ first, then app/ and e2e/',
  },

  dod: {
    files: ['tickets/phase-*.md'],
    contract: 'tickets/{id}.md',
    human: '(human)',
  },

  pushGuard: { protected: ['main', 'release'] },

  followUps: { dir: 'followups' },

  // `ticket-gate verify --precheck`: a quick look before the full run, without the stack.
  precheck: [
    { id: 'syntax', cmd: 'node --check src/cart.mjs src/catalog.mjs', fix: 'fix the syntax error above' },
    { id: 'unit', cmd: 'npm test', fix: 'fix the failing unit test above' },
  ],

  // Metrics that may only improve. `ratchet --all` runs those in group 'check'.
  ratchets: {
    'module-size': {
      group: 'check',
      baseline: 'tools/gate/module-size.json',
      check: ({ root, args }) => size.runModuleSize(root, args),
    },
    surface: { group: 'check', ...surfaceRatchet },
    duplication: { group: 'check', baseline: 'tools/gate/duplication.json', check: dup.check },
    assertions: { group: 'check', check: assertionsRatchet.check },
  },

  // The commands the engine's messages name, as this project spells them.
  commands: {
    verify: 'npm run gate',
    fu: 'npx ticket-gate fu',
    moveCheck: 'npx ticket-gate move-check',
    mutate: 'npx ticket-gate mutate',
    checkMutations: 'npx ticket-gate mutations check',
  },

  docs: { stamped: ['docs/guide'], ext: '.md', exclude: [] },

  packs: [shopPack()],

  mutations,
  selection,

  // `ticket-gate score`: judge a Stryker report of the branch against the base. Needs Stryker installed.
  // The score gate mutates TypeScript modules only, so in this .mjs project it always prints `noTargets`;
  // in a TypeScript project the same block judges every changed src/*.ts file.
  score: {
    scope: /^src\/.*\.ts$/,
    packageDir: '.',
    adapter: stryker({
      branchCmd: ['npx', 'stryker', 'run'],
      packageDir: '.',
      config: 'stryker.config.json',
      reportPath: 'reports/mutation/mutation.json',
    }),
    baseInstall: { cmd: 'npm', args: ['ci'], label: 'npm ci', hint: 'run npm ci in the base worktree', marker: 'package-lock.json' },
    newFileMin: 80,
    noTargets: 'no TypeScript module in src/ changed',
  },

  // `ticket-gate nightly run|install|status`: the full e2e suite on a fresh worktree of origin/main every night.
  nightly: {
    suites: [{ name: 'e2e', runner: nodeTestSuite({ glob: 'e2e/*.spec.mjs' }), limitS: 1800 }],
    worktree: { dir: 'shop-nightly', install: ['npm', 'ci'] },
    window: { start: '01:00', end: '05:00', catchUpBy: '00:30' },
    scheduler: {
      name: 'cron',
      install: () => {
        console.log('add to your crontab: 0 1 * * * cd <repo> && npx ticket-gate nightly run');
        return 0;
      },
    },
  },

  // Validated, and left for your own tooling (the engine does not read them): who owns which paths.
  roles: {
    'dev-core': { owns: ['src/**', 'test/**'], axis: 'CORE-' },
    'dev-ui': { owns: ['app/**', 'e2e/**'], axis: 'UI-' },
  },
  skills: { dir: '.claude/skills' },

  registryFile: (path) => path.startsWith('tools/gate/registry/'),
  stackHint: (stepId) => `node tools/gate/db.mjs status   # then: node tools/gate/db.mjs up (step ${stepId})`,
});
