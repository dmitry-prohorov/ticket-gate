# Configuration reference

A project's gate is the default export of `gate.config.mjs` at the repository root:

```js
import { defineGate, step } from '@ticket-gate/engine';

export default defineGate({ /* keys below */ });
```

To keep the root tidy, `gate.config.mjs` can be one line that re-exports a config kept elsewhere, such as
`export { default } from './tools/gate/config.mjs';`. Paths inside the config stay relative to the project root.

`defineGate` validates the object and freezes it. An unknown key or a bad value throws
`gate.config: <key>: <what is wrong>`. The hooks load the file again and validate it again, so a plain object that skipped
`defineGate` is still checked. The hooks also require `steps` (non-empty), `reviewMap` and `dod`.

New to the tool? Start with [getting-started.md](getting-started.md) and [examples/basic](../examples/basic).
[examples/full](../examples/full) sets every key below in one working project.

| Key | Required | Section |
|---|---|---|
| `steps` | yes | [steps](#steps) |
| `reviewMap` | yes (for the hooks) | [reviewMap](#reviewmap) |
| `dod` | yes (for the hooks) | [dod](#dod) |
| `base` | no, default `main`, then `origin/main` | [base](#base) |
| `pushGuard` | no, default `{ protected: ['main', 'master'] }` | [pushGuard](#pushguard) |
| `stacks`, `stopOnRedBefore` | no | [stacks](#stacks) |
| `dataPaths`, `toolPrefixes` | no | [Inputs of a step](#inputs-of-a-step) |
| `followUps` | no | [followUps](#followups) |
| `ratchets` | no | [ratchets](#ratchets) |
| `precheck` | no | [precheck](#precheck) |
| `commands` | no | [commands](#commands) |
| `packs` | no | [packs](#packs) |
| `docs` | no | [docs](#docs) |
| `mutations`, `score`, `selection`, `nightly` | no | [Larger features](#larger-features) |
| `roles`, `skills`, `registryFile`, `stackHint` | no | [Other keys](#other-keys) |

## steps

An ordered array of steps. Build each one with `step({...})`, which fills in the defaults marked below.

```js
step({
  id: 'test',                         // unique; used by --skip, --timeout and the receipt
  when: ['src/**', 'test/**'],        // which changed paths select the step
  cmd: 'npm test',                    // run in a shell at the project root
  reuse: { deny: ['*.md', 'docs/'] }, // or false
  summary: { pick: [/^ℹ pass \d+/] }, // the line kept in the receipt and the PR summary
  limitS: 600,                        // seconds before the watchdog kills the step
})
```

| Field | Type | Default (from `step`) | Meaning |
|---|---|---|---|
| `id` | string | none | Unique step id. |
| `when` | `true`, `false`, glob list, or `(ctx) => boolean` | none | Selects the step. A glob list matches when any changed path matches one glob. `ctx` is `{ paths, base, exists(path), touched(prefix) }`. |
| `cmd` | string or `(ctx) => string` | none | The command. |
| `reuse` | `false` or `{ deny: string[] }` | none, always required on a non-human step | `false` always reruns. `{ deny }` reuses the last green result on the same input digest. `deny` lists paths that cannot affect the step: `'dir/'` is a prefix, `'*.md'` a suffix, `'a/**/*.x'` a suffix under a prefix, anything else an exact path. |
| `summary` | `(out) => string` or `{ pick: RegExp[] }` | the last non-empty output line, else `'passed'` | The one-line result. `pick` takes the last line matching the first pattern that matches anything. |
| `limitS` | positive integer | `600` | Time limit. `--timeout=<id>:<sec>` raises it for one run. |
| `why` / `notRun` | string | `'selected by when'` / `'not selected by when'` | Text printed in the plan. |
| `human` | truthy | none | A step a person runs. It is printed and recorded as `human`, never run. It takes no `reuse` and no `limitS`. |
| `stack` | a key of `stacks` | none | The step needs that stack. See [stacks](#stacks). |
| `units` | `{ select(ctx), cmd(units), reaches?(ctx) }` | none | Runs a selected subset, for example the affected end-to-end specs. See the README's [affected-spec selection](../README.md#affected-spec-selection). |

Glob syntax, everywhere a glob is accepted: `**` crosses directories (`a/**/b` also matches `a/b`), `*` and `?` stay
within one path segment, and `{a,b}` is an alternation.

How a step's mode is chosen, shown by `verify --dry-run`:

- **RUN**: selected, and no green result is reusable.
- **REUSE**: selected, `reuse` allows it, and the ledger has a pass on the same command and the same input digest.
- **SKIP**: selected but named in `--skip`. It is recorded as `skipped`, so the receipt is not green.
- **HUMAN**: a `human` step.

## reviewMap

Every path the branch changes goes into exactly one tier:

| Tier | Meaning |
|---|---|
| `HUMAN` | A person reads every line. |
| `GATED` | A person reads only what a gate flags. |
| `MACHINE` | The gates cover it. A person spot-checks at most. |

```js
reviewMap: {
  rules: [
    { id: 'deps', tier: 'HUMAN', reason: 'a dependency changed',
      match: ({ path, depsChanged }) => path === 'package.json' && depsChanged },
    { id: 'eval', tier: 'HUMAN', reason: 'adds eval',
      match: ({ addedLines }) => addedLines.some(({ text }) => text.includes('eval(')) },
    { id: 'src', tier: 'GATED', reason: 'covered by tests', match: ({ path }) => path.startsWith('src/') },
    { id: 'tests', tier: 'MACHINE', reason: 'tests', match: ({ path }) => path.startsWith('test/') },
  ],
  sizeExcluded: ['tests', 'docs/**'],
  humanLines: [{ match: 'migrations/**', line: 'run the migration on a copy of production first' }],
  warn: 800,
  oversize: 1500,
}
```

| Field | Default | Meaning |
|---|---|---|
| `rules` | `[]` | `{ id, tier, reason, match(file) }`. The rules are tried in order and the first match wins, so put HUMAN rules first. A path no rule matches is HUMAN. |
| `sizeExcluded` | `[]` | Rule ids, or globs (anything containing `/` or `*`), whose lines do not count toward the diff size. |
| `humanLines` | `[]` | `{ match: glob or RegExp, line }`: an extra instruction printed for the reviewer when a path matches. |
| `warn` | `800` | Changed lines above which `verify` prints a split warning. |
| `oversize` | `1500` | Changed lines above which the receipt is marked `oversize`, and the Stop hook blocks (see `dod.oversize`). |
| `splitHint` | none | A pointer printed beside the size warning. |

`match` receives the changed file:

| Field | Meaning |
|---|---|
| `path` | Repo-relative path. |
| `added`, `removed` | Line counts. |
| `addedLines` | `[{ line, text }]` for each added line. Use it for content rules. |
| `lines` | The file's lines, when the engine read them (untracked files). |
| `depsChanged` | For a `package.json`: whether a dependency section changed. |

`ticket-gate review-map [--base=REF] [--full]` prints the map on its own. Every run also writes it to
`.turbo/review-map.json`.

## dod

Where the Definition of Done lives. The Stop hook uses it.

```js
dod: {
  files: ['tickets/phase-*.md'],   // the Markdown files with the checkboxes
  contract: 'tickets/{id}.md',     // a ticket's contract; {id} is the ticket id
  human: '(human)',                // default; a ticked line containing it is a human step
  oversize: /^(?:- )?oversize-accepted: \S/, // default; the waiver line for an oversize diff
}
```

- A ticket is a `## <ID> <title>` heading. Each `- [x]` line below it belongs to that ticket.
- A box is **newly ticked** when its text was not ticked at the merge base. Only newly ticked boxes need a receipt.
- With a newly ticked box, the hook requires `.turbo/ticket-verify.json` to exist, to be green, and to have the current
  tree hash. Each reused result's digest must also still match.
- A tick committed on a tree that an earlier green `verify` run recorded is **settled** and needs no new receipt.
- An oversize receipt blocks unless section 1 of the ticket's contract has an `oversize-accepted: <reason>` line. A reason
  starting `move-only` also needs `ticket-gate move-check` to find no unmatched line.
- With `followUps` configured, section 8.0 of the contract (`- **FU12** closes ...` or `- **FU12** PARTIAL ...`) must
  agree with the follow-up files.

## base

The git ref the diff is measured against: `ticket-gate` uses the merge base of `base` and `HEAD`. If the ref does not
exist, it tries `main`, then `origin/main`, then `HEAD`. `--base=REF` overrides it for one run.

## pushGuard

```js
pushGuard: { protected: ['main', 'master', 'release'] }
```

The PreToolUse hook denies:

- a `git push` to a protected branch, or a bare `git push` while one is checked out;
- a force push (`-f`, `--force`, `--force-with-lease`, `--force-if-includes`, a `+refspec`), `--mirror`, `--all`,
  `--prune`, and a delete (`-d`, `--delete`, `:branch`);
- `gh pr merge`, `gh pr close`, `gh repo sync`, and a `gh api` call that writes (`-X POST`, `-f`, `--input`, ...);
- the MCP `git_push` tool.

The list must not be empty. Pushing a feature branch and opening or editing its pull request stay allowed.

## stacks

A stack is a service that some steps need running: a local database, a scratch org, a dev server.

```js
stacks: {
  db: {
    health: (stepIds) => 'pg_isready -h localhost', // planned as step `db:health` before the first db step
    reset: { step: 'db-reset', before: ['e2e'], satisfiedBy: ['migrate'] },
    services: { e2e: ['db', 'api'] },          // the services each step id needs
  },
},
steps: [
  step({ id: 'migrate', when: ['migrations/**'], cmd: 'npm run migrate', reuse: false, stack: 'db' }),
  step({ id: 'db-reset', when: false, cmd: 'npm run db:reset', reuse: false, stack: 'db' }),
  step({ id: 'e2e', when: ['src/**', 'e2e/**'], cmd: 'npx playwright test', reuse: false, stack: 'db' }),
],
stopOnRedBefore: ['migrate'],
```

- `health` can be a function of the step ids that will run, which returns a command, or the object
  `{ step, preflight(ids), ready?(ids) }` that names a step of its own.
- `reset.step` runs before any step in `reset.before`, unless a step in `reset.satisfiedBy` runs and resets the stack
  itself.
- `stopOnRedBefore`: a step id, or a list of them. A red step earlier in the order stops the stack steps from that id
  on, unless `--keep-going` is given.

## Inputs of a step

Reuse compares digests of each step's inputs. By default every changed path not in the step's `reuse.deny` is an input.

- `dataPaths: { 'fixtures/': ['e2e'] }`: a path under the prefix is an input of the listed steps only.
- `toolPrefixes: ['tools/']`: a path under the prefix is an input of every step, even when a `deny` entry matches it.

## followUps

```js
followUps: { dir: 'followups', pointer: 'see followups/README.md' }
```

A register of follow-ups, one Markdown file per item (`FU12.md`), with a front matter of `id`, `status` (`open` or `done`),
`severity`, `owner` and `fixed-in`. `ticket-gate fu list | show <id> | next | close <id> --by <TICKET> --sha <sha> | check`
reads and updates it. The Stop hook checks it against each contract's section 8.0.

## ratchets

A ratchet is a metric that may only improve. Each entry is a function the CLI calls:

```js
ratchets: {
  'max-lines': {
    group: 'check',                       // run by `ticket-gate ratchet --all`
    baseline: 'gate/max-lines.json',      // optional; passed to check
    check: async ({ root, args, update, baseline }) => ({ code: 0, lines: ['max-lines: ok'] }),
  },
},
```

`ticket-gate ratchet <name> [--update]` runs one ratchet. `ticket-gate ratchet --all` runs every ratchet with
`group: 'check'` and exits with the worst code. Ready-made checks are in `@ticket-gate/engine/checks/` (`assertions`,
`duplication`, `surface`, `docs-stale`) and in `@ticket-gate/react/compiler.mjs` (React Compiler bailouts). See the
[engine README](../packages/engine/README.md#assertions-ratchet).

## precheck

```js
precheck: [{ id: 'types', cmd: 'npx tsc --noEmit', fix: 'fix the type errors above' }]
```

`ticket-gate verify --precheck` runs these quick checks without a stack. Each item is `{ id, cmd, fix }` (`cmd` may be a
function of `{ base }`) or a function. The precheck writes no receipt.

## commands

The commands the engine's messages tell a reader to run. Set them when your project wraps the CLI, for example as an
npm script:

```js
commands: { verify: 'npm run verify', fu: 'npm run fu', moveCheck: 'npm run move-check' }
```

Known keys: `verify`, `fu`, `moveCheck`, `nightlyStatus`, `mutate`, `checkMutations`, `checkMutationsScript`,
`afterFatal`, `restoreHint`. Each value is a single-line command string.

## packs

```js
import { supabaseNext } from '@ticket-gate/supabase-next/index.mjs';

packs: [supabaseNext({ /* options */ })],
```

A pack is an object with a `name`, a `version`, and hooks that add commands (`packCommands`), mutation kinds, selection
graphs, test runners or nightly payloads. Items from the config come first, then each pack in order. A name given twice is
a config error that names both sources. See [@ticket-gate/supabase-next](../packages/supabase-next/README.md) and
[@ticket-gate/react](../packages/react/README.md).

## docs

```js
docs: { stamped: ['docs/guide'], ext: '.md', exclude: ['index.md'] }
```

`ticket-gate docs-stale` lists the pages under `stamped` whose sources changed since the page was last stamped.

## Larger features

Each of these is off until its key is set, and each is documented in the root README:

| Key | Commands | Docs |
|---|---|---|
| `mutations` | `mutate`, `mutations check`, `mutations select` | [The mutation registry](../README.md#the-mutation-registry) |
| `score` | `score` | [The score gate](../README.md#the-score-gate) |
| `selection` | `select`, `select check` | [Affected-spec selection](../README.md#affected-spec-selection) |
| `nightly` | `nightly run`, `nightly install`, `nightly status` | [Nightly](../packages/engine/README.md#nightly) |

## Other keys

| Key | Meaning |
|---|---|
| `roles` | `{ [role]: { owns: glob[], axis?: string } }`. Validated for your own tooling, such as assigning work to agents. The engine does not read it. |
| `skills` | `{ lock?: string, dir?: string }`. Validated for your own tooling. The engine does not read it. |
| `registryFile` | `(path) => boolean`: whether a path is mutation-registry data, for the review map. |
| `stackHint` | `(stepId) => string`: a command that diagnoses a failed stack step, printed with the failure. |

## Environment variables

| Variable | Effect |
|---|---|
| `TICKET_GATE_ROOT` | Use this directory as the project root, instead of searching for `gate.config.mjs`. |
| `TICKET_GATE_CONFIG_DIR` | Load `gate.config.mjs` from this directory, with the root unchanged. |

## Files the gate writes

All of them are under `.turbo/`, which belongs in `.gitignore`:

| File | What it holds |
|---|---|
| `ticket-verify.json` | The receipt: tree hash, base, `ok`, one result per step, size, move proof. |
| `ticket-verify-history.jsonl` | Tree hashes of earlier green runs. It settles committed ticks. |
| `ticket-verify-steps.jsonl` | The step ledger: the recent results that `reuse` can draw on. |
| `review-map.json` | The last review map. |
