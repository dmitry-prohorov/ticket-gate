# @ticket-gate/supabase-next

The Supabase and Next.js pack for `@ticket-gate/engine`: stack start, health and reset handling, SQL and
end-to-end test selection, and ratchets for projects on that stack.

With `supabaseNext({ mutations })` it also contributes the SQL mutation kind and the served-test harness to the engine's
`mutate` and `mutations` commands (the `mutationKinds` and `mutationHarnesses` hooks).

A pack is optional. The engine reaches it only through the `packs` key of a project's `gate.config.mjs`; the
project supplies the project-specific tools the pack calls. This package depends on the engine at the same exact
version.

```sh
npm install --save-exact --save-dev @ticket-gate/engine@0.1.0-rc.1 @ticket-gate/supabase-next@0.1.0-rc.1
```

What the gate does, how to configure it and how to release it are in the repository README:
https://github.com/dmitry-prohorov/ticket-gate#readme

Licence: Apache-2.0.
