# ticket-gate

A configurable verification gate for agent-driven ticket work. It decides which checks a change requires, runs them in
order, records a receipt of the result, and blocks an agent from declaring work done while that receipt is missing, stale
or red. Projects describe their own steps in a `gate.config.mjs`; the engine ships no project knowledge.

This is a pre-release (`0.1.0-rc.1`). The configuration surface may still change before `0.1.0`.

## Packages

| Package | What it is |
|---|---|
| `@ticket-gate/engine` | The CLI (`ticket-gate`), the configuration API, the hooks, the receipt and ledger code. No runtime dependencies. |
| `@ticket-gate/supabase-next` | A pack for projects built on Supabase and Next.js: stack handling, SQL and end-to-end test selection, ratchets. It depends on the engine. |

Both require Node.js 22 or newer.

## Install

Pin exact versions. A release candidate is published under the `next` dist-tag, so name it:

```sh
npm install --save-exact --save-dev @ticket-gate/engine@0.1.0-rc.1
npm install --save-exact --save-dev @ticket-gate/supabase-next@0.1.0-rc.1   # only for that stack
```

Exact pins matter: the engine runs inside your agent's hooks, so a range would let a new version execute there
unreviewed. Update by editing the version yourself.

## Commands

`ticket-gate <command>` at release candidate 1:

| Command | What it does |
|---|---|
| `verify [flags]` | Run the steps the diff requires and write the receipt. |
| `hook stop` / `hook pre-tool-use` | Hook entry points; stdin and the exit code pass through. |
| `review-map [--base=REF] [--full]` | Print which changed files a human must read, and which gates cover the rest. |
| `move-check [--base=REF]` | Prove a move-only diff; exit 1 while lines are unmatched. |
| `fu list\|show\|next\|close\|check` | Work with the follow-up register. |
| `ratchet <name> [args]` | Run a configured ratchet (`--update` where it has one). |
| `mutate <ID>` / `mutate --registry (--ids=\|--all\|--changed)` | Prove each registered guard bites: apply its patch, run its test, expect a failure, restore the file. Needs `mutations` in the config. |
| `mutate --rotate --ledger=<dir> [--budget-min=<n>] [--batch=<n>] [--deadline=<ISO>] [--sha=<sha>]` | One budgeted rotation over the live registry: batches of `mutate --registry --ids=`, never-run keys first then the oldest proof, results appended to `<dir>/mutations.jsonl`. Without `--deadline` the budget is soft: the batch in flight at its end finishes. Takes the stack lock; exit 1 when a guard survived. Needs `mutations` in the config. |
| `mutations check [--fix]` / `mutations select [--affected --paths=]` | Validate (and repair) the mutation registry; list the entries a diff selects. |
| `select [--test-list \| --replay=REV --count=N \| --for=FILES \| --drift=REPORT \| --load-time]` | Pick the end-to-end specs a diff reaches from the import graph and the spec headers. Needs `selection` in the config. |
| `select check` | Validate the spec headers against the selection (every spec has its areas, every area is reached). Exit 1 with one line per problem. Needs `selection` in the config. |
| `score --base=REF [--files= --report= --base-report=]` | Judge a mutation-testing report against the base: no open mutant on a changed line, a new file at the floor, no regression. Exit 0 pass, 1 a file failed, 2 the tool, report or install failed. Needs `score` in the config. |

## A minimal `gate.config.mjs`

```js
import { defineGate, step } from '@ticket-gate/engine';

export default defineGate({
  base: 'origin/main',
  steps: [
    step({ id: 'deps', when: true, cmd: 'npm ci', reuse: false }),
    step({ id: 'test', when: ['src/**', 'test/**'], cmd: 'npm test', reuse: { deny: [] } }),
  ],
  reviewMap: {
    rules: [],
  },
});
```

A step runs when its `when` matches the diff (`true` always runs it). `reuse: false` reruns a step every time; `reuse: { deny: [...] }` lets an earlier result stand and lists the paths that cannot affect the step. The engine validates the file on load and names the
key to fix when something is wrong.

## The mutation registry

A guard is only worth having if its test fails without it. `mutation-registry/` holds one JSON entry per guard
(`patch`: a file, a line to find, what to put there instead, and the test that must then fail). `mutations` in a
`gate.config.mjs` turns the commands on: `mutations: { dir: 'mutation-registry' }`, optionally with `kinds`, `receipts`,
`area`, `fieldOrder` and `legacy`. A pack contributes kinds and harnesses through the `mutationKinds` and
`mutationHarnesses` hooks; `supabaseNext({ mutations })` adds the SQL kind and the served-test harness, and
`supabaseNext({ sql: { reset, preflight } })` replaces the lean reset command and the stack preflight
(`{ cmd, args, limitS }`) that the SQL session runs.

This repository registers its own engine and pack guards the same way (`scripts/mutations.mjs` is its config):

```sh
npm run mutations:check            # validate the registry (part of npm run check)
npm run mutate -- --registry --all # apply every guard, expect its test to fail (run by the release script)
```

## The score gate

`ticket-gate score` judges a mutation-testing report of the branch against the same report on a base worktree. The `score` key
of `defineGate` turns it on; the rest of the shape is validated on load and a bad value names the key to fix. It sits beside the
registry above: the registry proves your guards bite, the score gate proves your changed lines are covered by tests that bite.

```js
import { stryker } from '@ticket-gate/engine/score/adapters/stryker.mjs';
import { pnpmFilterInstall } from '@ticket-gate/supabase-next/score.mjs';

score: {
  scope: /^src\/.*\.ts$/,            // files that can be mutated
  packageDir: 'packages/app',        // where the tool runs; '.' for a package at the repo root
  adapter: stryker({                 // or your own { name, reportPath, runBranch, runBase, disablesWithoutReason, addedDisables }
    branchCmd: ['npx', 'stryker', 'run'],
    packageDir: 'packages/app',
    config: 'stryker.config.json',
    reportPath: 'packages/app/.turbo/mutation/report.json',
  }),
  baseInstall: pnpmFilterInstall('@scope/app'), // how the base worktree gets its dependencies
  newFileMin: 80,                    // optional: floor for a new file (default 80)
}
```

Optional keys: `extra`, `excluded`, `survivors`, `worktreeDir`, `handoff`, `commands.score` and `noTargets` (the line printed when
no file in the scope changed). The gate reads only the fields of the mutation-testing-report-schema it needs; a report that
cannot be read, or whose `schemaVersion` is not a 1.x or 2.x version, exits 2 with a `mutation: FAIL` line.

## Affected-spec selection

`ticket-gate select` decides which end-to-end specs a diff needs, so a branch runs the affected set and the nightly runs the rest.
The `selection` key of `defineGate` turns it on; it is validated on load and a bad value throws `gate.config: selection: <what>`.
Required: `specs: { dir, match, header }` and at least one graph source. Optional: `label`, `root`, `areas`, `triggers`, `ignored`,
`outside`, `unreachedOk`, `checks`, `locale`, `drift: { map(navigation, headers) }`, `replayPaths`, `commands` and `runner`.

Graph sources, rules and test runners are items with a string `name`, given inline (`selection.graphs`, `selection.rules`) or by a pack
through the `selectionGraphs`, `selectionRules` and `testRunners` hooks. They are collected with `packHooksAll`: the config's own items
first, then each pack in `packs` order. A name given twice is a config error naming both sources. `runner` may be a runner object or the
name of one a pack provides. `@ticket-gate/supabase-next` ships `supabaseFunctions`, `nextAppRoutes` and `workspaceExports` as
building blocks for those items; the Playwright runner is at `@ticket-gate/engine/runners/playwright.mjs`.

```js
import { playwright } from '@ticket-gate/engine/runners/playwright.mjs';
import { nightlyUnits } from '@ticket-gate/engine/selection/units.mjs';

const selection = {
  specs: { dir: 'e2e', match: /\.spec\.ts$/, header: /^\/\/ e2e-areas:/ },
  graphs: [/* ... */],
  runner: playwright({ cmd: ['npx', 'playwright', 'test'], specPrefix: 'e2e/' }),
};

selection,
steps: [
  step({
    id: 'e2e',
    when: ['src/**', 'e2e/**'],
    cmd: 'npx playwright test',
    units: nightlyUnits({ selection, suite: 'e2e', full: 'npx playwright test', runFrom: '.' }),
  }),
],
```

`nightlyUnits({ selection, suite, full, runFrom })` is the `units` of the step that runs the suite (it carries the `nightly` slot). `suite` names the
suite in the nightly record, `full` is the command of a full run, and `runFrom` is the path from the runner's working directory to the
repository root (default `.`). `selection` defaults to the config's own. It plans an affected run from the selection, the newest
nightly record and the spec ledger, and falls back to a full run (`full (nightly missing)`) when there is no usable record. It reads
the record through the `read()` function of the pack's `nightly` hook (`{ latest, history }`); without that hook the plan is full.
At most one step carries nightly units, and the engine finds it by `units.nightly`, not by a step id.

The Stop hook judges every unit result that carries a `mode` by the affected-mode rules, whatever the step is called. The pack `e2e`
hook of earlier release candidates is removed: a pack that provided one now provides `nightly.read()` and the selection hooks.

## What the hooks do and do not do

- The hooks read the working tree and the receipt, and they exit. They make no network call and collect no telemetry.
  A test in this repository walks every module reachable from the hooks and fails on a network import.
- Nothing updates itself. The CLI does not check for newer versions.
- The packages ship no secrets and read none, other than what your own `gate.config.mjs` and steps read.

## Contributing

```sh
npm ci            # installs the workspace links; nothing is downloaded
npm test          # every test, offline
npm run check     # npm test, the scrub (below), then the mutation registry check
```

`npm run check` is the gate for a pull request. The scrub (`scripts/scrub.mjs`) scans the working tree and every commit
for material that does not belong in a public repository: hosted project references, tokens, user-shaped paths, planning
documents, non-public email addresses. It reads an optional private denylist from the file named by `TICKET_GATE_DENYLIST`
(a path outside every git work tree); without it the two denylist rows report `SKIPPED`.

Commits use a public noreply address; the scrub rejects any other author email.

## Releasing

Maintainers only. Publishing runs from CI, by trusted publishing with provenance; no token is stored.

1. Write the changes under `## Unreleased` in `CHANGELOG.md`.
2. On `main` with a clean tree, with `gitleaks` and `trufflehog` installed and `TICKET_GATE_DENYLIST` exported:
   `npm run release -- <version>` (add `--dry-run` to check the gates only). It runs the scrub and both scanners, runs
   the tests, proves every registry guard with `mutate --registry --all`, sets both versions and the exact engine dependency, moves the changelog entry, commits and tags. It does
   not push and does not publish.
3. Push `main`, then push the tag it printed. The tag push starts the `publish` workflow, which waits on the
   `npm-publish` environment's reviewer, re-checks that the tag matches the manifests, and publishes the engine, then the
   pack. A version containing `-` goes to the `next` dist-tag; any other goes to `latest`.

One-time setup on npmjs.com: add a trusted publisher to each package (this repository, workflow `publish.yml`,
environment `npm-publish`).

## Licence

Apache-2.0. See `LICENSE`.
