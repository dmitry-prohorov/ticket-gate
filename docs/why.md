# Why ticket-gate exists

This page explains the problem ticket-gate solves, why it is written instead of assembled from existing tools, and why
it lives in its own public repository. For installation and commands, see the [README](../README.md).

## The problem: "done" is a claim, not a fact

When AI agents write most of the code and a person reviews it, the expensive failure is not a wrong line. It is an agent
saying "done" when:

- half of the checks the change needed never ran;
- a test passes but would still pass with the guarded code deleted;
- a definition-of-done checkbox is ticked while a test is red;
- the person reviewing has to read every file because nothing says which files are already covered by a gate.

ticket-gate turns "done" into something a machine checks. The person reviews two things: the ticket's contract before
work starts, and the files the review map marks as needing a human.

## What it does

| Part | What it does |
|---|---|
| `verify` | Reads the diff and runs only the steps it requires, in order. A database migration brings a schema reset and a check that generated files are current. A changed end-to-end area brings that area's browser tests. The run ends in a receipt bound to the exact tree hash, and the summary is ready to paste into a pull request. |
| Stop hook | Blocks the agent from finishing a session when it ticked a done-checkbox and the receipt is missing, stale or red. |
| Push-guard hook | Lets the agent push a feature branch and open a pull request. Denies a force push, a push to a protected branch, a merge, a branch deletion and a writing API call. Merging is always a person's decision. |
| Fail closed | If the engine is missing, crashes or has no config, the hook shim denies instead of allowing. The shim has no dependencies, so it works on a fresh clone before `npm install`. |
| Review map | Puts every changed file in exactly one tier: HUMAN (a person reads every line), GATED (a gate such as mutation testing covers it), MACHINE (generated, tests, docs). Rules are project config and can match on content, not only on path: a privilege keyword or a lint suppression added anywhere puts a file in HUMAN. |
| Mutation registry | Each entry says "break this guard, and this named test must fail". This covers source patches and SQL functions, policies and triggers in a live database. Entries are versioned, retired with a reason, and a known gap is recorded as `unguarded` instead of being hidden. |
| Ratchets | Metrics that may only improve: duplication across packages, end-to-end assertion counts, module size, compiler bailouts. A new clone is extracted, not added to the baseline. |
| Follow-up register | One file per follow-up, with an id, a status and an owner, checked for consistency. |

## Why not existing tools

Most individual parts have off-the-shelf equivalents, and ticket-gate uses them where they fit. It wraps jscpd for
duplication, Stryker for mutation scoring, and the project's own test runners. Before moving each piece into this
repository, we checked whether a ready tool could replace it instead:

| Piece | Candidate | Verdict | Why |
|---|---|---|---|
| Module-size ratchet | ESLint `max-lines` + bulk suppressions | Keep ours | A suppression records one count per file, so a file already over the limit can keep growing. Ours fails when it grows. |
| React Compiler bailout ratchet | React Compiler lint rules + bulk suppressions | Keep ours | The lint rules do not see functions the compiler skips. One real bailout is reported only by a rule that is outside the recommended preset. Suppressions carry no reason. The plugin bundles its own compiler version, not the pinned one. |
| Seed isolation of end-to-end files | ESLint `no-restricted-imports` + `no-restricted-syntax` | Replace | Both halves fit lint rules. The only loss is a seed id inside a comment. |
| End-to-end test selection | Playwright `--only-changed` | Keep ours | It follows only what test files import, so it cannot see app code served through `webServer`. It also fails on a shallow clone. |
| Agent cost and cache report | ccusage | Keep ours | It shows totals per session, but no per-subagent rows and no split by cache lifetime. |
| Mutation score gate | Stryker incremental mode | Keep ours, on top of Stryker | Comparing each mutant to the base branch, failing on a survivor on a changed line, and requiring a reason for a disable are not Stryker features. |
| Duplication ratchet | jscpd | Keep ours, on top of jscpd | The cross-package rule and the baseline that can only shrink are ours. |

What has no ready equivalent is the part that defines the tool: the receipt and the Stop hook, the review map, the
mutation registry with SQL entries, and step selection that also manages a local database stack.

Similar tools exist for single concerns: Nx and Turborepo affected runs, Betterer, Danger.js, CODEOWNERS, husky and
lefthook, branch protection. They work on push or on a pull request. ticket-gate works at the moment an agent claims it is
finished, and it encodes the rules of a review process as code that cannot be skipped.

## Why a CI pipeline does not replace it

A CI server gives a place to run checks and an authoritative result that cannot be faked locally. It does not decide
which checks a diff needs, what counts as done, or which files a person must read. That logic would have to be written
anyway and called from the pipeline. An agent also needs the answer before it pushes, not minutes after. The intended
setup has two layers: the same engine runs locally as the agent's gate, and in CI as a required check.

## Why a separate, public repository

The gate started as scripts inside one application repository. They grew one rule at a time, each after a real case of
an agent working around the previous rules. Moving them out does three things:

1. **Separates the engine from the project.** The engine knows nothing about any stack. A project describes its steps,
   review rules and ratchets in `gate.config.mjs`. Stack-specific behaviour lives in packs (`@ticket-gate/supabase-next`
   today). The aim is that a consuming project keeps only config and data, not gate code.
2. **Makes reuse testable.** "Reusable" is a hypothesis until a second project uses it. The next consumer is planned on a
   different stack and a different git host, which is what forced the host-neutral work listed in [TODO](../TODO.md).
3. **Keeps the code that runs inside agent hooks reviewable.** The packages have no runtime dependencies, make no network
   calls and are pinned to exact versions, so nothing runs in a hook that was not reviewed. A public repository with
   its own tests, its own mutation registry and a scrub against private material makes that inspectable.

## Known limits

- **One consumer so far.** The design has been shaped by one project. The pack boundary will move once a second stack
  uses it.
- **Local trust.** Without CI, a receipt proves the gate passed on the developer's machine, not on a server.
- **Regex guards are not a sandbox.** The push guard stops a well-meaning agent, not an adversary. A raw HTTP call or a
  shell alias can get around it. A server-side branch policy is the real lock, and the hook is the early stop.
- **GitHub only for now.** The push guard recognises `git` and `gh` commands. Azure DevOps support is designed but
  deferred (see [TODO](../TODO.md)).
- **Maintenance cost.** A gate this strict is a real codebase with its own tests and its own mutation registry.
