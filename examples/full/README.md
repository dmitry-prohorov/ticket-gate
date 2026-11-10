# Example: every engine feature in one project

A small shop (a cart, a catalog, two pages, a database) whose gate config ([`tools/gate/config.mjs`](tools/gate/config.mjs))
sets every key of `defineGate` with a value that works. It uses `@ticket-gate/engine` only; no pack is installed. Where a pack would add
something, a project-local pack ([`tools/gate/pack.mjs`](tools/gate/pack.mjs)) shows how.

Start with [examples/basic](../basic) if you have not set up a gate before. This repository's tests run this project end
to end (`test/examples.test.mjs`, EX-2), so every output below is real.

## What is where

The app is `src/`, `app/`, `test/`, `e2e/` and `db/`. The gate's code and data live in `tools/gate/`; only
`gate.config.mjs` stays at the root, because that is the file name the engine searches for. `tickets/`, `followups/`
and `docs/` are the team's own documents, which the gate reads.

```
examples/full/
├── gate.config.mjs               one line: re-exports tools/gate/config.mjs (the engine looks for this name)
├── package.json                  scripts: test, e2e, gate; engine, typescript and jscpd pinned
├── src/cart.mjs, src/catalog.mjs core logic (GATED: the mutation registry guards it)
├── app/checkout.mjs, app/catalog.mjs   pages (the roots of the e2e import graph)
├── test/*.test.mjs               unit tests
├── e2e/*.spec.mjs                end-to-end specs; line 1 names their areas
├── e2e/fixtures/cart.json        e2e input only (dataPaths)
├── db/migrations/*.sql           the "database" (HUMAN in the review map)
├── tools/gate/                   everything the gate needs, out of the app's way
│   ├── config.mjs                the gate: every defineGate key
│   ├── db.mjs                    a stand-in database stack: up | health | reset | migrate | status
│   ├── pack.mjs                  a local pack: a CLI command and a nightly payload
│   ├── nightly-suite.mjs         a nightly suite runner for node:test specs
│   ├── registry/src.json         the mutation registry (area: src)
│   ├── surface.json              what each gate tooling file is allowed to be
│   ├── jscpd.json                jscpd settings for the duplication ratchet
│   └── *.json                    ratchet baselines (module-size, surface, duplication, assertions)
├── docs/guide/pricing.md         a page stamped with its sources (docs-stale)
├── tickets/phase-1.md            DoD checkboxes for ticket T-2
├── tickets/T-2.md                T-2's contract: rows 1.1 and 1.2, section 8.0
├── followups/                    the follow-up register: README.md and FU1.md
└── .claude/settings.json         the Stop and PreToolUse hooks
```

## Feature map

| Feature | Config key | Try it |
|---|---|---|
| Steps chosen from the diff | `steps` (`when` as globs, as `true`/`false`, and as a function; `cmd` as a function; a `human` step) | `npx ticket-gate verify --dry-run` |
| Reusing a green result | `steps[].reuse`, `dataPaths`, `toolPrefixes` | run `verify` twice |
| A service some steps need | `stacks.db` (`health`, `reset`, `services`), `steps[].stack`, `stopOnRedBefore`, `stackHint` | `verify` with the db down, then up |
| Review tiers | `reviewMap` (path and content rules, `humanLines`, `sizeExcluded`, `warn`, `oversize`, `splitHint`), `registryFile` | `npx ticket-gate review-map` |
| Definition of Done | `dod` | tick a box in `tickets/phase-1.md` |
| Push guard | `pushGuard` (`main`, `release`) | see [The hooks](#the-hooks) |
| Follow-up register | `followUps` | `npx ticket-gate fu list`, `fu check`, `fu next` |
| Quick check | `precheck` | `npx ticket-gate verify --precheck` |
| Ratchets | `ratchets`: module size, surface, duplication, assertions | `npx ticket-gate ratchet --all` |
| Mutation registry | `mutations` | `npx ticket-gate mutate T-2`, `mutations check` |
| Affected e2e specs | `selection` | `npx ticket-gate select`, `select check` |
| Stale docs | `docs` | `npx ticket-gate docs-stale` |
| Mutation score | `score` (Stryker; TypeScript modules only) | `npx ticket-gate score --base=main` |
| Nightly | `nightly` (a suite, a worktree, a window, a scheduler) and the pack's payload | `npx ticket-gate nightly status`, `nightly install` |
| A pack | `packs` (`packCommands`, `nightlyPayloads`) | `npx ticket-gate db-status` |
| Message wording | `commands` | the "run …" hints name `npm run gate` |
| Your own tooling | `roles`, `skills` | validated; the engine does not read them |

## Set it up

```sh
cp -R examples/full ~/tg-shop && cd ~/tg-shop
printf 'node_modules/\n.turbo/\n' > .gitignore
npm install            # until the first release is on npm: npm install --save-exact -D /path/to/ticket-gate/packages/engine
git init -b main && git add -A && git commit -m "start"
```

The baselines in `tools/gate/` are already seeded. In your own project, seed each one once, on the main branch:
`ticket-gate ratchet module-size --update --seed`, `surface --update --seed`, `duplication --update` and
`assertions --update`.

## On main: every check is green

```
$ npx ticket-gate ratchet --all
module-size: 8 files measured, 0 baselined, none grew
ratchet module-size: ok
surface: OK 12 tracked files, 5 entries, 7 globs
ratchet surface: ok
duplication: 0 gated clone(s), all in tools/gate/duplication.json (0 allowed, 0 debt).
ratchet duplication: ok
assertions: 2 specs, 2 areas match the baseline
ratchet assertions: ok
ratchet --all: 4 ran, 0 failed

$ npx ticket-gate mutate --registry --all
T-2/M1 killed   1.1 the discount starts at exactly 10 items  node --test --test-name-pattern='^total takes 10% off' test/cart.test.mjs
T-2/M2 killed   1.2 an unknown sku is refused, not priced at zero  node --test --test-name-pattern='^priceOf refuses' test/catalog.test.mjs
mutate:check registry: 2/2 killed, 0 survived, 0 error

$ npx ticket-gate verify --precheck
precheck syntax: ok
precheck unit: ok
precheck: 2 ok, 0 failed (1s). Not a gate result: run npm run gate.
```

`mutate` applies each registry entry's patch (`find` → `replace`), runs the entry's test, expects it to fail, and
restores the file. A guard whose test still passes is a survivor, and the command exits 1.

## Work a ticket: T-2

The agent adds a function to the cart and a migration:

```sh
git checkout -b t-2
printf '\nexport const itemCount = (lines) => lines.reduce((n, l) => n + l.qty, 0);\n' >> src/cart.mjs
echo "alter table orders add column discount_cents integer;" > db/migrations/002_discount.sql
git add -A && git commit -m "T-2"
```

### The plan

```
$ npx ticket-gate verify --dry-run
Branch touches 2 path(s).

  RUN    node --check src/cart.mjs   (selected by when)
  RUN    npm test   (selected by when)
  RUN    npx --no-install ticket-gate ratchet --all   (selected by when)
  RUN    node tools/gate/db.mjs health   (the db stack must be healthy before its steps run)
  RUN    node tools/gate/db.mjs migrate   (selected by when)
  RUN    npm run e2e   (selected by when)
  HUMAN  deploy the branch to staging and click through the checkout   (selected by when)
mutation-registry: 1 selected (T-2/M1), 0 Playwright-backed deferred to the nightly

**HUMAN** - a person reads every line
- `db/migrations/002_discount.sql` +1 -0 - H1 database migration

**GATED (core logic: mutation gate)** - a person reads only what a gate flags
- `src/cart.mjs` +3 -0 - G1 core logic: the mutation registry

Human steps:
- apply it to a copy of production first: node tools/gate/db.mjs migrate
```

- `syntax` checks only the changed `.mjs` files, because its `cmd` is a function of the diff.
- `db:health` is planned because a `db` step runs. `db-reset` is not, because `migrate` is in its `satisfiedBy`.
- `e2e` runs because its `when` function sees `src/` touched.
- `staging` is a human step: it is listed in the receipt, and never run.
- The registry selects `T-2/M1`, the guard on the file that changed.

### Which end-to-end specs the change reaches

```
$ npx ticket-gate select
affected: affected: 1 areas, 1 specs
  checkout.spec.mjs
```

`src/cart.mjs` is imported by `app/checkout.mjs`, the root of area `checkout`. `catalog.spec.mjs` is not reached.
A change under `e2e/fixtures/` or to `package.json` (`selection.triggers`) selects every spec.

### Verify, with the database down

```
$ npx ticket-gate verify
...
node tools/gate/db.mjs health: failed (0m00s)  [FAIL]
node tools/gate/db.mjs migrate: not run (stopped: db:health red)  [STOPPED]
npm run e2e: not run (stopped: db:health red)  [STOPPED]
verify:ticket FAILED (failures: .turbo/ticket-verify-failures.md). Do not tick a DoD checkbox until this is green.
```

### Verify, with the database up

```
$ node tools/gate/db.mjs up && npx ticket-gate verify
node --check src/cart.mjs: passed (0m00s)
npm test: ℹ pass 5 (reused from 2026-11-10T06:59:58.726Z)  [REUSED]
npx --no-install ticket-gate ratchet --all: ratchet --all: 4 ran, 0 failed (0m01s)
node tools/gate/db.mjs health: db: healthy (0m00s)
node tools/gate/db.mjs migrate: db: migrated, 2 new migration(s) (0m00s)
npm run e2e: ℹ pass 2 (0m01s)
deploy the branch to staging and click through the checkout: passed  [HUMAN]
Not selected: db-reset
...
verify:ticket OK.
```

`npm test` was reused: it passed on the first run, and none of its inputs changed since.

### The rest of the ticket

```
$ npx ticket-gate docs-stale
pricing.md: STALE since main
    src/cart.mjs | 3 +++

$ npx ticket-gate mutate T-2
mutate:check T-2: 2/2 killed, 0 survived, 0 error

$ npx ticket-gate move-check
src/cart.mjs:12  export const itemCount = (lines) => lines.reduce((n, l) => n + l.qty, 0);
unmatched: 3

$ npx ticket-gate score --base=main
mutation: no TypeScript module in src/ changed vs 90b7fcd
```

- `docs-stale` lists `pricing.md` because one of its `guide-sources` changed after `checked-at`.
- `move-check` proves a move-only diff; this one adds code, so lines stay unmatched.
- `score` is configured for Stryker, but it mutates TypeScript modules only. In this `.mjs` project it always prints
  `score.noTargets`.

## The hooks

| Agent does | Hook says |
|---|---|
| Ticks `total() takes 10% off ...` after editing a file since the last `verify` | Stop: `The verification receipt is stale` |
| Runs `npm run gate` again, then stops | Stop: approves |
| Ticks `The discount banner is checked on staging (human)` | Stop: a `(human)` bullet is never an agent's to tick |
| `git push origin HEAD:release` | PreToolUse: deny, `release` is in `pushGuard.protected` |
| `git push -u origin t-2` | PreToolUse: allows |

With `followUps` set, the Stop hook also reads section 8.0 of `tickets/T-2.md`. A `- **FU1** closes ...` line there
requires `followups/FU1.md` to be `status: done`. T-2 declines FU1, so nothing is required.

## The nightly and the pack

```
$ npx ticket-gate db-status          # a command from tools/gate/pack.mjs (packCommands)
db: never started

$ npx ticket-gate nightly status
no nightly runs on record (ticket-gate nightly run --now)
move-to-ci 1: max wall 0.0 h, busy nights 0 of last 7 (not met; move at over 4 h or 2 nights)
move-to-ci 2: forced-full share n/a (no gate e2e runs in 14 days), queued branches 0 (not met; ...)

$ npx ticket-gate nightly install
add to your crontab: 0 1 * * * cd <repo> && npx ticket-gate nightly run
```

`nightly run` needs a git remote (`nightly.remote`, default `origin/main`). It checks out a fresh worktree, runs
`npm ci`, and runs the pack's `db` payload preflight: it skips the night when the database is down. It then resets the
database, runs the `e2e` suite through `tools/gate/nightly-suite.mjs`, resets the database again, and records the night.
`nightly status` exits 3 until a night is on record.

For Playwright suites, the engine ships `playwrightSuite` (`nightly/suites.mjs`) and the `playwright` selection runner
(`runners/playwright.mjs`). With those, `nightlyUnits` (`selection/units.mjs`) can give the `e2e` step an affected run
planned from the last night:

```js
import { playwright } from '@ticket-gate/engine/runners/playwright.mjs';
import { nightlyUnits } from '@ticket-gate/engine/selection/units.mjs';

selection.runner = playwright({ cmd: ['npx', 'playwright', 'test'], specPrefix: 'e2e/' });
step({ id: 'e2e', /* ... */ units: nightlyUnits({ selection, suite: 'e2e', full: 'npx playwright test' }) });
```

This example runs its specs with `node --test`, so it leaves `units` out.
