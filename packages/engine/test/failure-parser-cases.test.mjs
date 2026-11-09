// Ported cases of the failure summary (failures.mjs): what each recogniser reads out of a failed
// step's raw output, how the summary is rendered, and that a passing log yields nothing. Each test
// keeps the id of the case it was ported from. The output fixtures are the line shapes the real
// tools print, with synthetic package names and paths. failures.mjs resolves a few locations
// against the working directory, so the file runs inside a private throwaway project made by
// enterScratchProject (its own mkdtemp dir, removed afterwards).
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { enterScratchProject } from "./scratch-project.mjs";

const leave = enterScratchProject();
after(leave);

const { MAX_ENTRIES, cleanLines, parseFailures, renderFailures } =
  await import("../failures.mjs");

const VITEST = `
 RUN  v3.2.7 /repo/packages/lib

 ❯ src/a.test.ts (2 tests | 2 failed) 9ms
   × adds numbers 8ms
     → expected 2 to be 3 // Object.is equality
   × throws 0ms
     → boom

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/a.test.ts > adds numbers
AssertionError: expected 2 to be 3 // Object.is equality

- Expected
+ Received

- 3
+ 2

 ❯ src/a.test.ts:2:44

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  src/a.test.ts > throws
TypeError: boom
 ❯ node_modules/.pnpm/vitest/dist/runner.js:10:2
 ❯ src/a.test.ts:3:30

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  2 failed (2)
`;

const VITEST_DOUBLE = `
 FAIL  src/a.test.ts > adds numbers
 FAIL  src/a.test.ts > throws
${VITEST}`;

const TSC_PAREN = `bad.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`;
const TSC_COLON = `bad.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.

1 const x: number = 'a';
        ~


Found 1 error in bad.ts:1
`;

const ESLINT = `
/repo/lib/a.js
  1:1  error  Unexpected var, use let or const instead  no-var
  2:1  error  Unexpected 'debugger' statement           no-debugger

✖ 2 problems (2 errors, 0 warnings)
  1 error and 0 warnings potentially fixable with the \`--fix\` option.
`;

const PLAYWRIGHT = `
Running 1 test using 1 worker

  ✘  1 [chromium] › x.spec.ts:2:5 › adds up (8ms)


  1) [chromium] › x.spec.ts:2:5 › adds up ──────────────────────────────────────────────────────────

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2

      1 | import { test, expect } from '@playwright/test';
    > 2 | test('adds up', async () => { expect(1 + 1).toBe(3); });
        |                                             ^
      3 |
        at /tmp/pw/x.spec.ts:2:45

  1 failed
    [chromium] › x.spec.ts:2:5 › adds up ───────────────────────────────────────────────────────────
`;

const NODE_SPEC = `✔ good one (0.917895ms)
✖ bad one (1.796087ms)
✔ has error in name (0.135221ms)
ℹ tests 3
ℹ pass 2
ℹ fail 1

✖ failing tests:

test at t.test.mjs:4:1
✖ bad one (1.796087ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  1 !== 2
  
      at TestContext.<anonymous> (file:///tmp/nt/t.test.mjs:4:32)
      at Test.runInAsyncScope (node:async_hooks:227:14) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
  }
`;

const NODE_TAP = `TAP version 13
# Subtest: good one
ok 1 - good one
  ---
  duration_ms: 0.939965
  ...
# Subtest: bad one
not ok 2 - bad one
  ---
  duration_ms: 1.001317
  type: 'test'
  location: '/tmp/nt/t.test.mjs:4:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    1 !== 2
    
  code: 'ERR_ASSERTION'
  stack: |-
    TestContext.<anonymous> (file:///tmp/nt/t.test.mjs:4:32)
  ...
# Subtest: has error in name
ok 3 - has error in name
1..3
# fail 1
`;

const TURBO = `
 Tasks:    3 successful, 4 total
Cached:    0 cached, 4 total
  Time:    18.814s
Failed:    @scope/a#test

 ERROR  run failed: command  exited (1)
`;
const TURBO_TWO = `${TURBO}
 Tasks:    9 successful, 10 total
`;

const ALPHA =
  "check:alpha FAILED (2):\n" +
  "  new drift: key `k.new` is used by one side only. Make both sides use it, or add a row to rules/alpha-baseline.json with a reason from notes/OPEN.md.\n" +
  "  stale baseline row: key `k.old` is no longer one-sided. Delete the row from rules/alpha-baseline.json.\n";
const BETA =
  'check:beta FAILED (1):\n  notes/OPEN.md: header has no "next free id" line; restore it so new ids can be checked.\n';
const LIB_EXPORTS = `Duplicate export names in two packages. Extract the shared code, or add it to ALLOWLIST.
  formatTitle: web=pkg-a/lib/a.ts mobile=pkg-b/lib/a.ts
stale allowlist entry \`oldName\`: remove it from ALLOWLIST (it no longer collides, so the ratchet is satisfied).
`;
const DUP = `check:dup: 1 new clone(s). Extract the shared code. Do not baseline it.
  NEW tsx 18 lines: pkg-a/a.tsx <-> pkg-b/a.tsx
check:dup: 1 baseline entry no longer match a clone. The copy was removed or changed.
  STALE k1 (12 lines): the clone is gone
`;
const COMPILER = `new bailout: pkg-a/components/A.tsx:12 A [Todo] reason text
stale: pkg-a/components/B.tsx:B (fixed - re-seed the baseline)
skipped: pkg-b/lib/useX.ts:3 useX is named like a component or hook but was not compiled
unreasoned: pkg-a/components/C.tsx:C
plugin 1.2.3 != baseline 1.0.0: re-seed with --update
check:compiler: 329 files, 363 compiled functions, 4 bailouts (1 debt, 3 allowed), 4 allowed skips
`;
const MUTATION = `mutation: FAIL packages/lib/src/dates.ts: 2 survivors on changed lines (see .turbo/mutation-survivors.md)
mutation: FAIL packages/lib/src/ids.ts: score 61 below base 70
`;

test("P81 FV-1 cleanLines strips ANSI and the task prefix, and drops empty lines", () => {
  const raw =
    "\x1b[31m@scope/a:test: \x1b[0m\x1b[1m FAIL  src/a.test.ts > x\x1b[0m\n\n   \n@scope/b:lint:   1:1  error  x  no-var\n";
  assert.deepEqual(cleanLines(raw), [
    "FAIL  src/a.test.ts > x",
    "1:1  error  x  no-var",
  ]);
  assert.deepEqual(cleanLines("@scope/a:test: \x1b[32mok\x1b[0m"), ["ok"]);
});

test("P81 FV-2 vitest: one entry per failing test with assertion and file:line", () => {
  for (const out of [VITEST, VITEST_DOUBLE]) {
    const f = parseFailures(out);
    assert.equal(f.length, 2, JSON.stringify(f));
    assert.deepEqual(f[0], {
      kind: "vitest",
      name: "adds numbers",
      message: "AssertionError: expected 2 to be 3 // Object.is equality",
      location: "src/a.test.ts:2:44",
    });
    assert.equal(f[1].message, "TypeError: boom");
    assert.equal(f[1].location, "src/a.test.ts:3:30");
  }
});

test("P81 FV-3 tsc: both formats give TS code, message, file:line:col", () => {
  for (const out of [TSC_PAREN, TSC_COLON]) {
    assert.deepEqual(parseFailures(out), [
      {
        kind: "tsc",
        name: "TS2322",
        message: "Type 'string' is not assignable to type 'number'.",
        location: "bad.ts:1:7",
      },
    ]);
  }
  const prefixed = `@scope/a:typecheck: src/x.ts(10,3): error TS2304: Cannot find name 'q'.`;
  assert.equal(parseFailures(prefixed)[0].location, "src/x.ts:10:3");
});

test("P81 FV-4 eslint: rule, message, file:line:col from the header line", () => {
  assert.deepEqual(parseFailures(ESLINT), [
    {
      kind: "eslint",
      name: "no-var",
      message: "Unexpected var, use let or const instead",
      location: "/repo/lib/a.js:1:1",
    },
    {
      kind: "eslint",
      name: "no-debugger",
      message: "Unexpected 'debugger' statement",
      location: "/repo/lib/a.js:2:1",
    },
  ]);
});

test("P81 FV-5 playwright: title, spec:line:col, first Error line", () => {
  assert.deepEqual(parseFailures(PLAYWRIGHT), [
    {
      kind: "playwright",
      name: "adds up",
      message: "Error: expect(received).toBe(expected) // Object.is equality",
      location: "x.spec.ts:2:5",
    },
  ]);
});

test("P81 FV-6 node:test: spec and TAP both give name, message, location", () => {
  for (const out of [NODE_SPEC, NODE_TAP]) {
    const f = parseFailures(out);
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0].kind, "node-test");
    assert.equal(f[0].name, "bad one");
    assert.match(f[0].message, /Expected values to be strictly equal/);
    assert.match(f[0].location, /t\.test\.mjs:4:1$/);
  }
});

test("P81 FV-7 check tools: each detail line is an entry named for its tool, kept whole", () => {
  const alpha = parseFailures(ALPHA);
  assert.equal(alpha.length, 2);
  assert.deepEqual(
    alpha.map((e) => e.name),
    ["check:alpha", "check:alpha"],
  );
  assert.match(
    alpha[0].message,
    /alpha-baseline\.json with a reason from notes\/OPEN\.md/,
  );
  assert.match(alpha[1].message, /^stale baseline row/);

  assert.deepEqual(
    parseFailures(BETA).map((e) => e.name),
    ["check:beta"],
  );
  assert.deepEqual(
    parseFailures(`${ALPHA}${BETA}`).map((e) => e.name),
    ["check:alpha", "check:alpha", "check:beta"],
  );

  const lib = parseFailures(LIB_EXPORTS);
  assert.deepEqual(
    lib.map((e) => e.name),
    ["check:lib-exports", "check:lib-exports", "check:lib-exports"],
  );
  assert.match(lib[1].message, /^formatTitle: web=.* mobile=/);
  assert.match(lib[2].message, /^stale allowlist entry/);

  const dup = parseFailures(DUP);
  assert.equal(dup.length, 4);
  assert.ok(dup.every((e) => e.name === "check:dup"));
  assert.match(dup[0].message, /^(check:dup: )?1 new clone/);
  assert.match(dup[1].message, /^NEW tsx 18 lines/);
  assert.match(dup[3].message, /^STALE k1/);

  const compiler = parseFailures(COMPILER);
  assert.equal(compiler.length, 5, JSON.stringify(compiler));
  assert.equal(compiler[0].location, "pkg-a/components/A.tsx:12");
  assert.ok(compiler.every((e) => e.name === "check:compiler"));
});

test("P81 FV-8 turbo: Failed tasks are listed and every Tasks line is kept", () => {
  const f = parseFailures(TURBO_TWO);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "turbo");
  assert.equal(f[0].name, "@scope/a#test");
  assert.match(f[0].message, /3 successful, 4 total/);
  assert.match(f[0].message, /9 successful, 10 total/);
  assert.equal(f[0].message.split(" | ").length, 2);
  const two = parseFailures(
    "Failed:    @scope/a#test, @scope/b#lint\nTasks:  1 successful, 3 total\n",
  );
  assert.deepEqual(
    two.map((e) => e.name),
    ["@scope/a#test", "@scope/b#lint"],
  );
});

test("P81 FV-9 mutation: FAIL lines are entries and the hint is rendered", () => {
  const f = parseFailures(MUTATION);
  assert.equal(f.length, 2);
  assert.deepEqual(f[0], {
    kind: "mutation",
    name: "packages/lib/src/dates.ts",
    message: "2 survivors on changed lines (see .turbo/mutation-survivors.md)",
    location: "packages/lib/src/dates.ts",
  });
  const md = renderFailures({
    treeHash: "h",
    ranAt: "t",
    failures: [
      {
        id: "mutation",
        cmd: "run mutation",
        why: "on red, the survivors in .turbo/mutation-survivors.md go to the test author",
        out: MUTATION,
      },
    ],
  });
  assert.match(
    md,
    /^Hint: on red, the survivors in \.turbo\/mutation-survivors\.md go to the test author$/m,
  );
  assert.match(md, /- \[mutation\] packages\/lib\/src\/ids\.ts: score 61/);
});

const GREEN = `
> pkg@1.0.0 check:parity /repo
check:parity: 50 one-sided key(s), 50 baselined, 19 template key(s) ignored.
check:follow-ups OK
check:dup: 33 gated clone(s), all in rules/duplication-baseline.json (2 allowed, 31 debt).
check:compiler: 329 files, 363 compiled functions, 2 bailouts (0 debt, 2 allowed), 4 allowed skips
Checking formatting...
All matched files use Prettier code style!
 Test Files  12 passed (12)
      Tests  120 passed (120)
 Tasks:    9 successful, 9 total
Cached:    0 cached, 9 total
✔ an execute-bit change moves the hash (173.563911ms)
✔ a test named with error in it (1ms)
ℹ tests 12
ℹ pass 12
ℹ fail 0
ℹ todo 0
0 failed
mutation: no logic file changed vs abc1234
mutation: 40 mutants, score 92 (base 90), 0 survivors on changed lines
`;

test("P81 FV-11 a passing check and mutation log parses to no entries", () => {
  assert.deepEqual(parseFailures(GREEN), []);
  assert.deepEqual(parseFailures(""), []);
});

test("P81 FV-12 b the summary has a header, one section per failed step in order, the hint, and is small", () => {
  const rows = Array.from(
    { length: 3 },
    (_, i) => `  ${i + 1}:1  error  Unexpected var number ${i}  no-var`,
  ).join("\n");
  const pad = Array.from(
    { length: 400 },
    (_, i) => `@scope/a:test:  ✓ src/mod${i}.test.ts (12 tests) ${i}ms`,
  ).join("\n");
  const check = `${pad}\n/repo/lib/a.js\n${rows}\n\n✖ 3 problems (3 errors, 0 warnings)\n${VITEST}\n${TSC_PAREN}\n${TURBO}`;
  const e2e = `${pad}\n${PLAYWRIGHT}`;
  const md = renderFailures({
    treeHash: "abc123",
    ranAt: "2026-01-01T00:00:00.000Z",
    failures: [
      { id: "check", cmd: "run check", why: "the unit gate", out: check },
      { id: "e2e", cmd: "run e2e", why: "rerun idle", out: e2e },
    ],
  });
  assert.ok(md.startsWith("# verify:ticket failures\n"));
  assert.match(md, /^treeHash: abc123 {3}ranAt: 2026-01-01T00:00:00\.000Z$/m);
  assert.deepEqual(
    [...md.matchAll(/^## (\S+): /gm)].map((m) => m[1]),
    ["check", "e2e"],
  );
  assert.match(md, /^Hint: the unit gate$/m);
  assert.match(md, /^Hint: rerun idle$/m);
  const checkSection = md.slice(md.indexOf("## check"), md.indexOf("## e2e"));
  const listed = checkSection.split("\n").filter((l) => l.startsWith("- ["));
  assert.ok(listed.length > 3 && listed.length <= MAX_ENTRIES, `${listed.length}`);
  assert.ok(
    Buffer.byteLength(md) <
      (Buffer.byteLength(check) + Buffer.byteLength(e2e)) / 4,
    `${Buffer.byteLength(md)} bytes`,
  );
});
