# Getting started

This page takes a project from nothing to a working gate: an agent that cannot say "done" until the checks the change needs
have passed on the exact code it is leaving behind. It takes about ten minutes. A complete, tested project that ends where
this page ends is in [examples/basic](../examples/basic).

For the full list of config keys, see [configuration.md](configuration.md). For why the tool exists, see [why.md](why.md).

## How it fits together

```
 agent edits code ──► ticket-gate verify ──► .turbo/ticket-verify.json (the receipt)
                        │                         │
                        │ runs only the steps     │ bound to the tree hash,
                        │ the diff selects        │ green or red per step
                        ▼                         ▼
                   PR summary + review map   Stop hook: a ticked DoD box needs a
                                             green receipt for this exact tree
```

- **`gate.config.mjs`**, at the project root, describes your steps, your review rules and where your Definition of Done
  lives. The engine knows nothing about your stack.
- **`ticket-gate verify`** reads the diff against the base branch, runs the steps whose `when` matches, and writes a
  **receipt**. The receipt records the result of each step and the hash of the working tree it ran on.
- **The Stop hook** runs when the agent tries to finish. If a Definition of Done (DoD) checkbox was newly ticked on the
  branch, it requires a receipt that is green and still describes the current tree. Otherwise it blocks, and tells the
  agent what to run.
- **The PreToolUse hook** lets an agent push its feature branch and open a pull request. It denies force pushes, pushes
  to protected branches, merges and writing `gh api` calls.
- **The review map** puts every changed file in one tier (HUMAN, GATED or MACHINE), so the reviewer knows which files to
  read line by line.

## 1. Install

Node.js 22 or newer is required. Pin an exact version: the engine runs inside your agent's hooks, so a version range
would let unreviewed code run there.

```sh
npm install --save-exact --save-dev @ticket-gate/engine@0.1.0-rc.1
```

pnpm and yarn work the same way (`pnpm add -D -E ...`). Until the first release reaches npm, install from a checkout:
`npm install --save-exact --save-dev /path/to/ticket-gate/packages/engine`.

## 2. Write `gate.config.mjs`

Put it at the repository root. `ticket-gate` finds it by walking up from the working directory.

```js
import { defineGate, step } from '@ticket-gate/engine';

export default defineGate({
  base: 'main',
  steps: [
    step({ id: 'lint', when: ['src/**'], cmd: 'npm run lint', reuse: { deny: ['*.md'] } }),
    step({ id: 'test', when: ['src/**', 'test/**'], cmd: 'npm test', reuse: { deny: ['*.md'] } }),
  ],
  reviewMap: {
    rules: [
      { id: 'src', tier: 'GATED', reason: 'covered by tests', match: ({ path }) => path.startsWith('src/') },
      { id: 'tests', tier: 'MACHINE', reason: 'tests', match: ({ path }) => path.startsWith('test/') },
    ],
  },
  dod: {
    files: ['tickets/phase-*.md'],
    contract: 'tickets/{id}.md',
  },
});
```

The four keys you always set:

| Key | What it says |
|---|---|
| `steps` | What can be run, in order, and which changed paths select each one (`when`). |
| `reviewMap.rules` | Which tier a changed file belongs to. The first matching rule wins. A path no rule matches is HUMAN. |
| `dod.files` | The Markdown files that hold the DoD checkboxes. |
| `dod.contract` | Where a ticket's contract lives; `{id}` is replaced by the ticket id. |

`defineGate` validates the file when it loads. A mistake throws `gate.config: <key>: <what is wrong>`, which names the key
to fix.

## 3. Write a Definition of Done

The Stop hook reads checkboxes from the files `dod.files` matches. Each ticket is a `## <ID> <title>` heading with its
boxes below it:

```md
## T-1 Add sum()

- [ ] `sum(a, b)` returns the sum and throws a TypeError otherwise
- [ ] `ticket-gate verify` is green and its summary is in the pull request
- [ ] Release notes reviewed (human)
```

- A box counts as **newly ticked** when the same text was not already ticked at the merge base. Moving a ticked line does
  not count.
- A line containing `(human)` (configurable as `dod.human`) is a step only a person may tick. The hook blocks an agent
  that ticks one.
- `dod.files` must match at least one file. If it matches none, the hook fails closed rather than read no DoD at all.

## 4. Connect the hooks to Claude Code

Add the hooks to `.claude/settings.json` in the project:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npx --no-install ticket-gate hook stop" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "npx --no-install ticket-gate hook stop" }] }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "npx --no-install ticket-gate hook pre-tool-use" }]
      }
    ]
  }
}
```

`--no-install` stops `npx` from downloading a package when the engine is missing. Both hooks fail closed on a missing or
broken `gate.config.mjs`: they block a ticked DoD box and deny every push instead of allowing them. They read the working
tree and the receipt, make no network call and collect no telemetry.

One gap remains. If the engine itself is not installed (a fresh clone before `npm install`), `npx` exits 1, and Claude
Code treats exit 1 as a non-blocking error. To close it, point the hooks at a small script of your own that exits 2 when
`node_modules/@ticket-gate/engine` is absent, and otherwise runs `ticket-gate hook <event>`.

Add `.turbo/` to `.gitignore`: the receipt, the ledger and the review map are written there, and they are local results.

## 5. Use it

```sh
npx ticket-gate verify --dry-run    # the plan and the review map; runs nothing
npx ticket-gate verify              # run the selected steps, write the receipt, print the PR summary
npx ticket-gate review-map          # only the review map
```

A typical agent loop:

1. The agent works on branch `t-1` and changes `src/sum.mjs`.
2. It runs `ticket-gate verify`. `lint` and `test` run, because `src/**` changed. The receipt is green.
3. It ticks the T-1 boxes and pastes the summary into the pull request.
4. It stops. The Stop hook finds the newly ticked boxes, sees a green receipt for the current tree, and approves.

If the agent edits a file after step 2, the tree hash no longer matches. The Stop hook then blocks with
`The verification receipt is stale` until `verify` runs again.

### Useful `verify` flags

| Flag | Effect |
|---|---|
| `--dry-run` | Print the plan (RUN, REUSE, SKIP or HUMAN for each step) and the review map. Runs nothing and writes no receipt. |
| `--base=REF` | Measure the diff against `REF` instead of `base`. |
| `--skip=id1,id2` | Skip these steps. A skipped step is recorded as `skipped: NOT verified`, so the receipt is not green. |
| `--fresh` | Ignore earlier results and run every selected step. |
| `--timeout=<id>:<sec>` | Raise one step's time limit for this run (repeatable). |
| `--keep-going` | Run the stack steps even after a red step before a `stopOnRedBefore` id. (Without `stopOnRedBefore`, every selected step runs anyway.) |
| `--review-map=full` | List every MACHINE path, not only the count. |
| `--precheck [--ticket=ID]` | A quick check without a stack. It writes nothing and is never a gate result. |

### Reuse

A step with `reuse: { deny: [...] }` can reuse an earlier green result when its inputs have the same digest. `deny` lists
paths that cannot affect the step (`'docs/'` is a prefix, `'*.md'` a suffix, `'a/**/*.x'` a suffix under a prefix). A
change to one of them does not force a rerun. `reuse: false` always reruns. The Stop hook recomputes every reused
result's digest, so a reuse cannot hide a change.

## 6. Run the same gate in CI

The receipt proves the gate passed on the developer's machine. To have a server confirm it, run the same command in your
pipeline:

```yaml
- run: npm ci
- run: npx ticket-gate verify --base=origin/${{ github.base_ref }}
```

Check out with enough history for the merge base (`fetch-depth: 0` with `actions/checkout`).

## Next steps

- Make review rules content-aware: `match` receives `{ path, added, removed, addedLines, depsChanged }`. The example
  sends any file that adds `eval(` to HUMAN. See [configuration.md](configuration.md#reviewmap).
- Add ratchets: metrics that may only improve (duplication, assertion counts, compiler bailouts). See
  [configuration.md](configuration.md#ratchets).
- Prove that your guards bite with the mutation registry, select end-to-end specs from the import graph, or schedule a
  nightly. These are covered in the [README](../README.md#the-mutation-registry) and the
  [engine README](../packages/engine/README.md).
