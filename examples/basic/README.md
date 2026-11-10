# Example: a small Node.js library behind ticket-gate

A complete project with a gate: one source file, its tests, a ticket with a Definition of Done, and the Claude Code hooks.
It is the smallest setup where every part of the gate does something. This repository's tests run it end to end
(`test/examples.test.mjs`), so the output below is what you get.

```
examples/basic/
├── gate.config.mjs          the gate: steps, review map, DoD, push guard
├── package.json             "test": "node --test"; @ticket-gate/engine pinned exactly
├── src/sum.mjs              the code under review
├── test/sum.test.mjs        its tests
├── tickets/phase-1.md       the DoD checkboxes, one "## <ID> <title>" section per ticket
├── tickets/T-1.md           ticket T-1's contract (dod.contract: tickets/{id}.md)
└── .claude/settings.json    runs the Stop and PreToolUse hooks in Claude Code
```

## Try it

Copy the folder out of this repository, make it a git repository with a `main` branch, and install:

```sh
cp -R examples/basic ~/tg-basic && cd ~/tg-basic
printf 'node_modules/\n.turbo/\n' > .gitignore
git init -b main && git add -A && git commit -m "start"
npm install
git checkout -b t-1
```

Before the first release reaches npm, install the engine from a checkout of this repository instead:
`npm install --save-dev --save-exact /path/to/ticket-gate/packages/engine`.

Make a change, the way an agent working on ticket T-1 would:

```sh
echo "export const double = (n) => sum(n, n);" >> src/sum.mjs
```

### 1. See what the change requires

`ticket-gate verify --dry-run` prints the plan and the review map without running anything:

```
Branch touches 1 path(s).

  RUN    node --check src/sum.mjs   (selected by when)
  RUN    npm test   (selected by when)

#### Review map (base c1146d5)

**HUMAN** - a person reads every line
- none

**GATED (core logic: mutation gate)** - a person reads only what a gate flags
- `src/sum.mjs` +1 -0 - src library code: covered by test
...
```

Change only `tickets/T-1.md` and both steps disappear: no `when` matches a Markdown file.

### 2. Verify

`npx ticket-gate verify` runs the selected steps in order, then writes the receipt to `.turbo/ticket-verify.json`
and prints a block to paste into the pull request:

````
--- paste into the PR body -------------------------------

```
node --check src/sum.mjs: passed (0m00s)
npm test: ℹ pass 2 (0m01s)
```

#### Review map (base c1146d5)
...
verify:ticket OK.
````

Run it again with no change and both steps show `REUSE`: their inputs have the same digest as the last green run.

### 3. Let the Stop hook judge "done"

Tick the first box under `## T-1` in `tickets/phase-1.md`. That is the agent saying the ticket is done. The Stop hook then
decides whether the agent may finish:

| State | Stop hook |
|---|---|
| No box newly ticked on the branch | approves without reading anything |
| Box ticked, no receipt | blocks: `No verification receipt exists.` |
| Box ticked, receipt green and written for this exact tree | approves |
| Box ticked, a file changed after `verify` | blocks: `The verification receipt is stale` |
| `Release notes reviewed (human)` ticked | blocks: a `(human)` bullet is never an agent's to tick |

You can call the hook by hand, the way Claude Code does:

```sh
echo '{}' | npx ticket-gate hook stop
# {"decision":"block","reason":"1 DoD checkbox(es) were ticked on this branch: ..."}
```

### 4. Let the push guard stop a merge

The PreToolUse hook reads the Bash command an agent is about to run:

```sh
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | npx ticket-gate hook pre-tool-use
# {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny", ...}}

echo '{"tool_name":"Bash","tool_input":{"command":"git push -u origin t-1"}}' | npx ticket-gate hook pre-tool-use
# (no output, exit 0: allowed)
```

## The config, line by line

See [`gate.config.mjs`](gate.config.mjs). Its comments explain each key. The full reference is
[docs/configuration.md](../../docs/configuration.md).

- **`steps`**: `lint` runs when `src/**` changes. `test` runs when the source, the tests or `package.json` change. Both
  may reuse an earlier green result, and a change to a `*.md` file never invalidates it.
- **`reviewMap.rules`**: a changed dependency, an added `eval(`, or the gate config itself goes to HUMAN. `src/` is GATED,
  because the tests cover it. Tests and Markdown are MACHINE. A path no rule matches is HUMAN.
- **`dod`**: the checkboxes live in `tickets/phase-*.md`, and each ticket's contract is `tickets/<ID>.md`.
- **`pushGuard`**: `main` and `master` can never be pushed to by an agent.
