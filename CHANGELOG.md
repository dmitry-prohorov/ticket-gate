# Changelog

## Unreleased

- `@ticket-gate/supabase-next`: the check modules `checks/db-schema.mjs`, `checks/stack-preflight.mjs`, `checks/stack.mjs`, `checks/kill-group.mjs` and `checks/env-keys.mjs`; `supabaseNext({ stackPreflight, dbSchema })` adds the `stack-preflight` and `db-schema` commands through `packCommands` (`commands.mjs`); the guards are registered in `mutation-registry/`.
- `@ticket-gate/engine`: the check modules `checks/surface.mjs`, `checks/duplication.mjs`, `checks/docs-stale.mjs`, `checks/cache-report.mjs` and `checks/ratchet-options.mjs`; the commands `ticket-gate cache-report` and `ticket-gate docs-stale`; `ticket-gate ratchet --all` with the `group: 'check'` ratchet field; pack commands (`packCommands` hook, collected with `packHooksAll`; a duplicate name, or a name of an engine command, is a config error); the guards are registered in `mutation-registry/`.
- `@ticket-gate/react`: new package, `reactCompiler(options)` (`compiler.mjs`), the React Compiler bailout ratchet; `@babel/core` and `babel-plugin-react-compiler` are resolved from the consuming project. Published at the version of the other packages (0.1.0-rc.1).
- `@ticket-gate/engine`: affected-spec selection (`ticket-gate select`, `ticket-gate select check`), the `selection` key of `defineGate`, the graph sources (`graph/`), the Playwright runner (`runners/playwright.mjs`) and the selection engine (`selection/`); `selectionGraphs`, `selectionRules` and `testRunners` pack hooks are collected with `packHooksAll` (a duplicate name is a config error naming both packs); the selection guards are registered in `mutation-registry/`.
- `@ticket-gate/engine`: `nightlyUnits({ selection, suite, full, runFrom })` (`selection/units.mjs`) is the `units` of a nightly-backed step; the Stop hook judges every unit result that carries a `mode`, not only a step named `e2e`.
- `@ticket-gate/supabase-next`: removed the `e2e` hook and `e2eUnits()`; the `nightly` hook gains `read()`; adds the selection building blocks `supabaseFunctions`, `nextAppRoutes` and `workspaceExports`.
- `@ticket-gate/engine`: the mutation score gate (`ticket-gate score`, the `score` key of `defineGate`, the Stryker adapter at `score/adapters/stryker.mjs`); a report that cannot be read or whose `schemaVersion` is not 1.x or 2.x exits 2; the score guards are registered in `mutation-registry/`.
- `@ticket-gate/supabase-next`: `pnpmFilterInstall(filter)` builds the `score.baseInstall` of a pnpm workspace package.
- `@ticket-gate/engine`: the mutation engine (`ticket-gate mutate`, `ticket-gate mutations check|select`), the `mutations` key of `defineGate`, `packHooksAll` for hooks every pack contributes to, and the `mutation-registry/` of this repository's own guards.
- `@ticket-gate/engine`: `ticket-gate mutate --rotate --ledger=<dir>` runs one budgeted rotation over the live registry from the exported rotation core (`mutations/rotate.mjs`: ledger read and compaction, rotation order, budget and deadline); the rotation guards are registered in `mutation-registry/`.
- `@ticket-gate/supabase-next`: `supabaseNext({ tools, mutations })` contributes the SQL mutation kind and the served-test harness through `mutationKinds` and `mutationHarnesses`; the `registry` hook is removed.
- `@ticket-gate/supabase-next`: `supabaseNext({ sql: { reset, preflight } })` replaces the lean reset command and the stack preflight of the SQL mutation session; an unknown `sql` key throws.

## 0.1.0-rc.1 - 2026-11-05

- `@ticket-gate/engine`: first release candidate of the CLI, the configuration API, the Stop and PreToolUse hooks, the receipt and ledger code, the review map and the follow-up register.
- `@ticket-gate/supabase-next`: first release candidate of the Supabase and Next.js pack (stack handling, SQL and end-to-end test selection, ratchets).
