# @ticket-gate/engine

The engine of ticket-gate: a configurable verification gate for agent-driven ticket work.

It provides:

- the `ticket-gate` command (`verify`, `hook`, `review-map`, `move-check`, `fu`, `ratchet` (`ratchet --all` runs every ratchet with group `check`), `cache-report`, `docs-stale`, `mutate`, `mutations`, `score`, `select`, `nightly`);
- the mutation engine behind `mutate` and `mutations`, enabled by the `mutations` key of `defineGate`;
- the mutation score gate behind `score`, enabled by the `score` key of `defineGate`;
- the affected-spec selection behind `select` and `select check` (import-graph and spec-header based), enabled by the `selection` key of `defineGate`, with graph sources, rules and test runners from the `selectionGraphs`, `selectionRules` and `testRunners` pack hooks;
- `nightlyUnits({ selection, suite, full, runFrom })` (`selection/units.mjs`), the units of a step backed by a nightly record; it reads the record the gate's `nightly` key points at (`nightlyRecord(gate)`);
- the nightly (`ticket-gate nightly run [--now] | install | status`), enabled by the `nightly` key of `defineGate`; see Nightly below;
- `serve({ build, start, port, env }, { onSpawn })` (`serve.mjs`): refuses a busy port, builds, starts the server and resolves with `{ stop }` once the port answers; it rejects on a busy port, a failed build or a server that never answers, and `onSpawn(stop)` runs right after the spawn;
- the check modules in `checks/` (`surface`, `duplication`, `docs-stale`, `cache-report`, `ratchet-options`, `assertions`, `unguardedKind`), exported for a project's ratchets; `jscpd` is resolved from the consuming project;
  - the `surface` manifest holds `entries` of `{ match, kind, why, owner? }`, an optional `ownerPattern`, `strict` and, when strict, `budget.check` and `budget.wiring` (non-negative integers; `strict: true` without both is exit 2);
  - `strict: true` adds: a `pending` entry fails (rule 2), the code lines of `check` files over `budget.check` fail (rule 5), more than `budget.wiring` files of kind `wiring` fail (rule 6), and `budget.check` may only go down against the baseline's `budget.check` (`--update` records it and refuses a raise); a non-strict manifest ignores `budget`;
- pack commands: a pack's `packCommands` hook is an object of `name -> (args, { root, gate }) -> code`; `ticket-gate <name> [args]` calls it with the arguments after the name, the project root and the gate, and exits with the number it returns (0 when it returns nothing);
- `defineGate` and `step`, the API a project's `gate.config.mjs` is written against;
- the Stop and PreToolUse hooks, which make no network call and collect no telemetry;
- the receipt, ledger, review-map and follow-up register code.

## Assertions ratchet

`checks/assertions.mjs` exports `assertions(cfg)`: it counts configured needles per spec file, groups the totals by the areas named in each spec's header, and fails when an area's total drops below its baseline unless a green mutation receipt covers the dropped spec. A rise is reported as stale until the baseline is rewritten with `--update`. A project passes `check` under `ratchets`:

```js
import { defineGate } from '@ticket-gate/engine';
import { assertions } from '@ticket-gate/engine/checks/assertions.mjs';
import { unguardedKind } from '@ticket-gate/engine/checks/assertions-unguarded.mjs';
import { resolveSetup } from '@ticket-gate/engine/mutations/kinds.mjs';

const mutations = {
  dir: 'gate/registry',
  receipts: { ticket: '.gate/mutation-check.json', registry: '.gate/mutation-registry.json' },
  kinds: { unguarded: unguardedKind({ from: /^tests\/.+\.test\.ts$/, fromHint: 'tests/<...>.test.ts' }) },
};
const a = assertions({
  name: 'assertions',
  specs: { dir: 'tests', match: /\.test\.ts$/, header: /^\/\/ areas: ([a-z]+(, [a-z]+)*)$/ },
  areas: ['billing', 'search'],
  counters: { asserts: 'expect(' },
  from: 'tests/',
  receipt: '.gate/mutation-check.json',
  baseline: 'gate/assertions.json',
  registry: 'gate/registry/',
  comment: 'Never edit by hand: run the update command.',
  commands: { update: 'npm run assertions -- --update', mutate: 'npm run mutate -- <ID>', usage: 'npm run assertions' },
  setup: resolveSetup(mutations), // required under `ratchets`, which binds no setup
});
export default defineGate({
  ratchets: { assertions: { check: a.check, group: 'check' } },
  mutations,
});
```

`unguardedKind` is a factory, not a registered kind: an `unguarded` registry entry records a guard no test bites, with a reason, and its `from` covers a dropped spec. `from` must not carry the `g` or `y` flag.

## Nightly

`defineGate({ nightly })` enables the nightly: an unattended run of your end-to-end suites on a scheduled worktree, with a record of each night. `nightly` is one object, checked by `defineNightly` (`nightly/define.mjs`); a bad one fails as `gate.config: nightly: <reason>`.

- `suites`: the suites, run in order. Each is `{ name, runner, limitS, keep? }`; `runner.run({ wt, io, args, limitS, env, out, dir })` returns the result and may add an `extra` value that is stored in the record; every suite after the first needs `runner.statusLine(view)`, which prints its line in `ticket-gate nightly status`, which also prints one `move-to-ci 1 (<name>)` line per suite after the first, from that suite's own time and busy nights; the first suite's time is the record's `firstMs` (written when there are two or more suites) or, for an older record, `ms`. `playwrightSuite({ cmd })` (`nightly/suites.mjs`) is the Playwright runner. A suite may set its own `keep` (`reports`: `'all'`, `'history'` or a positive integer; `traces`: a positive integer; the first suite keeps no traces) and its own flaky and move-to-CI handling. The rotation, when configured with `rotate: { command }`, runs last.
- `worktree: { dir, install }`, `window`, `remote`, `keep`, `selects` and `commands` as in `NIGHTLY_DEFAULTS` (`nightly/define.mjs`).
- `payloads`: environment setup around the suites (`name`, `preflight`, optional `before`, `after`, `io`). A pack adds its own through the `nightlyPayloads` hook, collected with `packHooksAll`; a duplicate payload name is a config error naming both givers.
- `scheduler`: `{ name, install(io, dir) }`, what `ticket-gate nightly install` calls (a returned number is the exit code); without it `install` exits 2 (the launchd one is `nightly/launchd.mjs`, macOS only: on another platform it prints one line and exits 2).
- `ticket-gate nightly run [--now]` runs one night, `ticket-gate nightly install` installs the scheduler job (macOS launchd), `ticket-gate nightly status` prints the status lines, including the two move-to-CI measures.
- The record (`{ latest, history }`) lives in the nightly directory. The gate also appends one line `{ ranAt, ms, mode, why }` to `e2e-runs.jsonl` there for every end-to-end run; `move-to-ci 2` prints the share of the last 14 days spent in a forced full run against the 25% limit.

It has no runtime dependencies and needs Node.js 22 or newer. Install an exact version:

```sh
npm install --save-exact --save-dev @ticket-gate/engine@0.1.0-rc.1
```

What the gate does, how to configure it and how to release it are in the repository README:
https://github.com/dmitry-prohorov/ticket-gate#readme

- Getting started: https://github.com/dmitry-prohorov/ticket-gate/blob/main/docs/getting-started.md
- Configuration reference: https://github.com/dmitry-prohorov/ticket-gate/blob/main/docs/configuration.md
- A complete example project: https://github.com/dmitry-prohorov/ticket-gate/tree/main/examples/basic

Licence: Apache-2.0.
