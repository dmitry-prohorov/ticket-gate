# @ticket-gate/engine

The engine of ticket-gate: a configurable verification gate for agent-driven ticket work.

It provides:

- the `ticket-gate` command (`verify`, `hook`, `review-map`, `move-check`, `fu`, `ratchet`, `mutate`, `mutations`, `score`, `select`);
- the mutation engine behind `mutate` and `mutations`, enabled by the `mutations` key of `defineGate`;
- the mutation score gate behind `score`, enabled by the `score` key of `defineGate`;
- the affected-spec selection behind `select` and `select check` (import-graph and spec-header based), enabled by the `selection` key of `defineGate`, with graph sources, rules and test runners from the `selectionGraphs`, `selectionRules` and `testRunners` pack hooks;
- `nightlyUnits({ selection, suite, full, runFrom })` (`selection/units.mjs`), the units of a step backed by a nightly record; it reads the record from the `read()` of a pack's `nightly` hook;
- `defineGate` and `step`, the API a project's `gate.config.mjs` is written against;
- the Stop and PreToolUse hooks, which make no network call and collect no telemetry;
- the receipt, ledger, review-map and follow-up register code.

It has no runtime dependencies and needs Node.js 22 or newer. Install an exact version:

```sh
npm install --save-exact --save-dev @ticket-gate/engine@0.1.0-rc.1
```

What the gate does, how to configure it and how to release it are in the repository README:
https://github.com/dmitry-prohorov/ticket-gate#readme

Licence: Apache-2.0.
