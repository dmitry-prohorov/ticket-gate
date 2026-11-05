# Changelog

## Unreleased

- `@ticket-gate/engine`: the mutation engine (`ticket-gate mutate`, `ticket-gate mutations check|select`), the `mutations` key of `defineGate`, `packHooksAll` for hooks every pack contributes to, and the `mutation-registry/` of this repository's own guards.
- `@ticket-gate/engine`: `ticket-gate mutate --rotate --ledger=<dir>` runs one budgeted rotation over the live registry from the exported rotation core (`mutations/rotate.mjs`: ledger read and compaction, rotation order, budget and deadline); the rotation guards are registered in `mutation-registry/`.
- `@ticket-gate/supabase-next`: `supabaseNext({ tools, mutations })` contributes the SQL mutation kind and the served-test harness through `mutationKinds` and `mutationHarnesses`; the `registry` hook is removed.
- `@ticket-gate/supabase-next`: `supabaseNext({ sql: { reset, preflight } })` replaces the lean reset command and the stack preflight of the SQL mutation session; an unknown `sql` key throws.

## 0.1.0-rc.1 - 2026-11-05

- `@ticket-gate/engine`: first release candidate of the CLI, the configuration API, the Stop and PreToolUse hooks, the receipt and ledger code, the review map and the follow-up register.
- `@ticket-gate/supabase-next`: first release candidate of the Supabase and Next.js pack (stack handling, SQL and end-to-end test selection, ratchets).
