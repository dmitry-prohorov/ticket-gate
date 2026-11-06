# @ticket-gate/supabase-next

The Supabase and Next.js pack for `@ticket-gate/engine`: stack start, health and reset handling, SQL and
end-to-end test selection, and ratchets for projects on that stack.

With `supabaseNext({ mutations })` it also contributes the SQL mutation kind and the served-test harness to the engine's
`mutate` and `mutations` commands (the `mutationKinds` and `mutationHarnesses` hooks).

`pnpmFilterInstall(filter)` (from `score.mjs`) builds the `score.baseInstall` of a pnpm workspace package for the engine's `score` gate.

The pack's `nightly` hook has `read()`, the nightly record `{ latest, history }` that the engine's `nightlyUnits` plans from.
The `e2e` hook and `e2eUnits()` of earlier release candidates are removed: the selection and the units slot live in the engine. The pack
exports building blocks for the engine's selection hooks (`selection/supabase-rules.mjs`, `selection/next-routes.mjs`,
`selection/workspace-exports.mjs`).

The pack also adds two CLI commands through the engine's `packCommands` hook, each only when its option is given to
`supabaseNext`. `stackPreflight: { webEnv: { file, missing }, anonKey: { file, name } }` adds `ticket-gate stack-preflight
--steps=<ids> [--wait=<sec>]`, which checks that the local Supabase stack answers before a step that needs it; its step ids are
the services of the gate's `stacks.supabase`. `dbSchema: { header, ... }` adds `ticket-gate db-schema [--dump=PATH]
[--cron=PATH] [--out=DIR]`, which writes the deterministic per-object schema snapshot of a dump; `out`, `tool`, `name`, `usage`,
`start` and `reset` default to `DB_SCHEMA_DEFAULTS` (`commands.mjs`) and can be overridden. A missing required key throws a
`TypeError` when the factory runs. The check modules are importable on their own: `checks/db-schema.mjs`,
`checks/stack-preflight.mjs`, `checks/stack.mjs`, `checks/kill-group.mjs` and `checks/env-keys.mjs`.

A pack is optional. The engine reaches it only through the `packs` key of a project's `gate.config.mjs`; the
project supplies the project-specific tools the pack calls. This package depends on the engine at the same exact
version.

```sh
npm install --save-exact --save-dev @ticket-gate/engine@0.1.0-rc.1 @ticket-gate/supabase-next@0.1.0-rc.1
```

What the gate does, how to configure it and how to release it are in the repository README:
https://github.com/dmitry-prohorov/ticket-gate#readme

Licence: Apache-2.0.
