# Changelog

## Unreleased

- `@ticket-gate/engine`: the mutation engine (`ticket-gate mutate`, `ticket-gate mutations check|select`), the `mutations` key of `defineGate`, `packHooksAll` for hooks every pack contributes to, and the `mutation-registry/` of this repository's own guards.
- `@ticket-gate/supabase-next`: `supabaseNext({ tools, mutations })` contributes the SQL mutation kind and the served-test harness through `mutationKinds` and `mutationHarnesses`; the `registry` hook is removed.

## 0.1.0-rc.1 - 2026-11-05

- `@ticket-gate/engine`: first release candidate of the CLI, the configuration API, the Stop and PreToolUse hooks, the receipt and ledger code, the review map and the follow-up register.
- `@ticket-gate/supabase-next`: first release candidate of the Supabase and Next.js pack (stack handling, SQL and end-to-end test selection, ratchets).
