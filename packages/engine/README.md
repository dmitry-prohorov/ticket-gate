# @ticket-gate/engine

The engine of ticket-gate: a configurable verification gate for agent-driven ticket work.

It provides:

- the `ticket-gate` command (`verify`, `hook`, `review-map`, `move-check`, `fu`, `ratchet` (`ratchet --all` runs every ratchet with group `check`), `cache-report`, `docs-stale`, `mutate`, `mutations`, `score`, `select`, `nightly`);
- the mutation engine behind `mutate` and `mutations`, enabled by the `mutations` key of `defineGate`;
- the mutation score gate behind `score`, enabled by the `score` key of `defineGate`;
- the affected-spec selection behind `select` and `select check` (import-graph and spec-header based), enabled by the `selection` key of `defineGate`, with graph sources, rules and test runners from the `selectionGraphs`, `selectionRules` and `testRunners` pack hooks;
- `nightlyUnits({ selection, suite, full, runFrom })` (`selection/units.mjs`), the units of a step backed by a nightly record; it reads the record the gate's `nightly` key points at (`nightlyRecord(gate)`);
- the nightly (`ticket-gate nightly run [--now] | install | status`), enabled by the `nightly` key of `defineGate`; see Nightly below;
- the check modules in `checks/` (`surface`, `duplication`, `docs-stale`, `cache-report`, `ratchet-options`), exported for a project's ratchets; `jscpd` is resolved from the consuming project;
- pack commands: a pack's `packCommands` hook is an object of `name -> (args, { root, gate }) -> code`; `ticket-gate <name> [args]` calls it with the arguments after the name, the project root and the gate, and exits with the number it returns (0 when it returns nothing);
- `defineGate` and `step`, the API a project's `gate.config.mjs` is written against;
- the Stop and PreToolUse hooks, which make no network call and collect no telemetry;
- the receipt, ledger, review-map and follow-up register code.

## Nightly

`defineGate({ nightly })` enables the nightly: an unattended run of your end-to-end suites on a scheduled worktree, with a record of each night. `nightly` is one object, checked by `defineNightly` (`nightly/define.mjs`); a bad one fails as `gate.config: nightly: <reason>`.

- `suites`: the suites, run in order. Each is `{ name, runner, limitS, keep? }`; `runner.run({ wt, io, args, limitS, env, out })` returns the result and may add an `extra` value that is stored in the record; every suite after the first needs `runner.statusLine(view)`, which prints its line in `ticket-gate nightly status`. `playwrightSuite({ cmd })` (`nightly/suites.mjs`) is the Playwright runner. A suite may set its own `keep` (`reports`: `'all'`, `'history'` or a positive integer; `traces`: a positive integer; the first suite keeps no traces) and its own flaky and move-to-CI handling. The rotation, when configured with `rotate: { command }`, runs last.
- `worktree: { dir, install }`, `window`, `remote`, `keep`, `selects` and `commands` as in `NIGHTLY_DEFAULTS` (`nightly/define.mjs`).
- `payloads`: environment setup around the suites (`name`, `preflight`, optional `before`, `after`, `io`). A pack adds its own through the `nightlyPayloads` hook, collected with `packHooksAll`; a duplicate payload name is a config error naming both givers.
- `scheduler`: `{ name, install(io, dir) }`, what `ticket-gate nightly install` calls; without it `install` exits 2 (the launchd one is `nightly/launchd.mjs`).
- `ticket-gate nightly run [--now]` runs one night, `ticket-gate nightly install` installs the scheduler job (macOS launchd), `ticket-gate nightly status` prints the status lines, including the two move-to-CI measures.
- The record (`{ latest, history }`) lives in the nightly directory. The gate also appends one line `{ ranAt, ms, mode, why }` to `e2e-runs.jsonl` there for every end-to-end run; `move-to-ci 2` prints the share of the last 14 days spent in a forced full run against the 25% limit.

It has no runtime dependencies and needs Node.js 22 or newer. Install an exact version:

```sh
npm install --save-exact --save-dev @ticket-gate/engine@0.1.0-rc.1
```

What the gate does, how to configure it and how to release it are in the repository README:
https://github.com/dmitry-prohorov/ticket-gate#readme

Licence: Apache-2.0.
