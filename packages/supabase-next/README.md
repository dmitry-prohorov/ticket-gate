# @ticket-gate/supabase-next

The Supabase and Next.js pack for `@ticket-gate/engine`: stack start, health and reset handling, SQL and
end-to-end test selection, and ratchets for projects on that stack.

With `supabaseNext({ mutations })` it also contributes the SQL mutation kind and the served-test harness to the engine's
`mutate` and `mutations` commands (the `mutationKinds` and `mutationHarnesses` hooks).

`pnpmFilterInstall(filter)` (from `score.mjs`) builds the `score.baseInstall` of a pnpm workspace package for the engine's `score` gate.

`supabaseNext({ nightlyStack: { preflight, reset } })` contributes the Supabase stack as a payload of the engine's nightly through the `nightlyPayloads` hook (`nightly/stack-payload.mjs`): docker must be up, the stack running; it is reset before the suites and again after them. `preflight` and `reset` are argv arrays.
The `nightly` hook (with its `read()`), the `e2e` hook and `e2eUnits()` of earlier release candidates are removed; the engine reads the nightly record from the gate's `nightly` key: the selection and the units slot live in the engine. The pack
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

## Checks

Each check module takes every project value as an option and returns `{ code, out, err }` (or the checker) without printing
or exiting, so a project can bind it in its own CLI:

```js
import { supabaseStack } from '<pack>/checks/stack.mjs';            // ({ services, cmd, waits, reset }) -> stack descriptor
import { stackPreflight } from '<pack>/checks/stack-preflight.mjs'; // ({ services, root, cli, webEnv, anonKey, usage }) -> checker
import { dbSchema } from '<pack>/checks/db-schema.mjs';             // ({ root, out, header, tool, name, usage, start, reset }) -> { run, buildSnapshot, renderCron }
import { checkEnvExampleKeys } from '<pack>/checks/env-keys.mjs';   // ({ root, targets, label, fix }) -> { code, out, err }
import { killGroup, safeKillGroup } from '<pack>/checks/kill-group.mjs'; // (pid, signal): signal a whole process group
```

`<pack>` is this package's name.

A pack is optional. The engine reaches it only through the `packs` key of a project's `gate.config.mjs`; the
project supplies the project-specific tools the pack calls. This package depends on the engine at the same exact
version.

```sh
npm install --save-exact --save-dev @ticket-gate/engine@0.1.0-rc.1 @ticket-gate/supabase-next@0.1.0-rc.1
```

What the gate does, how to configure it and how to release it are in the repository README:
https://github.com/dmitry-prohorov/ticket-gate#readme

- Getting started: https://github.com/dmitry-prohorov/ticket-gate/blob/main/docs/getting-started.md
- Configuration reference: https://github.com/dmitry-prohorov/ticket-gate/blob/main/docs/configuration.md
- A complete example project: https://github.com/dmitry-prohorov/ticket-gate/tree/main/examples/basic

Licence: Apache-2.0.
