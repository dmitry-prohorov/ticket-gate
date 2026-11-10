// The nightly units planner: which mode a run takes, which units are known red, which are reused,
// and how nightlyUnits plans from a selection and the gate's nightly record.
// Pure functions over plain data; the one project-bound piece is the gate's nightly record.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { defineSelection } from "../../selection/define.mjs";
import { CONFIG_URL, enterScratchProject } from "../scratch-project.mjs";

// The scratch project's gate config has a minimal nightly; the scratch project is a git repo, so
// the nightly dir is <project>/.turbo/nightly, where the tests write the record. A missing
// latest.json is a missing record.
enterScratchProject(`import { defineGate, step } from '${CONFIG_URL}';
export default defineGate({
  steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })],
  nightly: {
    suites: [{ name: 'web', runner: { run: async () => ({}) }, limitS: 60 }],
    worktree: { dir: 'nightly-wt', install: ['node', '-e', '0'] },
  },
});
`);
execFileSync("git", ["init", "-q"], { cwd: process.cwd() });
const {
  affectedListLines,
  chooseE2eMode,
  finishE2e,
  knownRedOf,
  nightlyUnits,
  onDisk,
  planE2e,
  planSpecs,
  reachesHarness,
  recordOf,
  E2E_LIST,
} = await import("../../selection/units.mjs");
const { NIGHTLY_MAX_AGE_MS } = await import("../../digest.mjs");
const { nightlyDir } = await import("../../nightly/record.mjs");
const { GATE } = await import("../../project.mjs");

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const agoIso = (ms) => new Date(NOW - ms).toISOString();
const nightlyOf = (status, ageMs = HOUR) => ({
  sha: "n1",
  status,
  ranAt: agoIso(ageMs),
});
const AFFECTED = { mode: "affected", why: "affected: 1 areas", specs: ["u1"] };
const choose = (nightly, over = {}) =>
  chooseE2eMode({
    selection: AFFECTED,
    nightly,
    flag: "auto",
    nowMs: NOW,
    ...over,
  });

test("VE-3a a nightly older than the freshness window forces full; exactly at the window it is still fresh", () => {
  assert.deepEqual(choose(nightlyOf("green", NIGHTLY_MAX_AGE_MS + 1)), {
    mode: "full",
    why: "nightly stale",
  });
  assert.equal(choose(nightlyOf("green", NIGHTLY_MAX_AGE_MS)).mode, "affected");
  // an unparseable ranAt is stale, never an error
  assert.deepEqual(choose({ status: "green", ranAt: "garbage" }), {
    mode: "full",
    why: "nightly stale",
  });
});

test("VE-3b a nightly that is not green or amber forces full with its status; none at all says missing", () => {
  assert.deepEqual(choose(nightlyOf("red")), {
    mode: "full",
    why: "nightly red",
  });
  assert.deepEqual(choose(nightlyOf("error")), {
    mode: "full",
    why: "nightly error",
  });
  for (const none of [null, undefined])
    assert.deepEqual(choose(none), { mode: "full", why: "nightly missing" });
  // control: green and amber stay affected
  for (const status of ["green", "amber"])
    assert.deepEqual(choose(nightlyOf(status)), {
      mode: "affected",
      why: AFFECTED.why,
    });
});

test("VE-3c the full flag forces full even with a perfect nightly and an affected selection", () => {
  assert.deepEqual(choose(nightlyOf("green"), { flag: "full" }), {
    mode: "full",
    why: "--e2e=full",
  });
});

test("VE-4 a selection that is not affected forces full and carries its own reason", () => {
  for (const why of ["a trigger path changed", "selector: boom"])
    assert.deepEqual(
      choose(nightlyOf("green"), {
        selection: { mode: "full", why, specs: [] },
      }),
      { mode: "full", why },
    );
});

const nrun = (sha, status, ranAt, redSpecs = [], extra = {}) => ({
  sha,
  status,
  ranAt,
  redSpecs,
  reachedPlaywright: true,
  ...extra,
});
const known = (over) =>
  knownRedOf({
    runs: [],
    baseSha: "base",
    isAncestor: (sha) => ["old", "base"].includes(sha),
    branch: "feat/x",
    selected: [],
    ...over,
  });
const older = nrun("old", "red", "2026-10-29T00:00:00Z", ["b.spec", "a.spec"]);

test("VE-5a a nightly-fix branch has no known red units; any other branch gets the sorted red set of the nightly at its base", () => {
  assert.deepEqual(known({ runs: [older], branch: "fix/nightly-x" }), []);
  // control: the same runs on an ordinary branch are known red
  assert.deepEqual(known({ runs: [older] }), ["a.spec", "b.spec"]);
});

test("VE-5b a unit the branch selects is never known red", () => {
  assert.deepEqual(known({ runs: [older], selected: ["a.spec"] }), ["b.spec"]);
  assert.deepEqual(
    known({ runs: [older], selected: ["a.spec", "b.spec"] }),
    [],
  );
});

const line = (file, digest, status, ranAt = "T") => ({
  id: "e2e-spec",
  file,
  digest,
  status,
  ranAt,
});
const plan = (specLedger, over = {}) =>
  planSpecs({
    selected: ["u1"],
    inputs: new Map(),
    digestOf: (f) => `now:${f}`,
    specLedger,
    fresh: false,
    alwaysRun: new Set(),
    ...over,
  });

test("VE-7b only a pass line on the same digest is reused; a fail, a skip or a reused line is not", () => {
  assert.deepEqual(plan([line("u1", "now:u1", "pass")]).run, []);
  for (const status of ["fail", "skipped", "reused"])
    assert.deepEqual(plan([line("u1", "now:u1", status)]).run, ["u1"], status);
  // the newest line decides: a fail after an older pass re-runs
  assert.deepEqual(
    plan([
      line("u1", "now:u1", "pass", "T1"),
      line("u1", "now:u1", "fail", "T2"),
    ]).run,
    ["u1"],
  );
});

test("VE-8b a unit absent from the tree is dropped from the selection; with no listing the selection is kept", () => {
  assert.deepEqual(onDisk(["u1", "gone"], ["u1", "u2"]), ["u1"]);
  assert.deepEqual(onDisk(["a"], []), ["a"]);
});

// --- nightlyUnits over a project selection ---

const ROOT_DIR = process.cwd();
const put = (rel, text) => {
  mkdirSync(join(ROOT_DIR, rel, ".."), { recursive: true });
  writeFileSync(join(ROOT_DIR, rel), text);
};
put("e2e/home.spec.ts", "// areas: home\n");
put("e2e/other.spec.ts", "// areas: other\n");

const test1 = (file, title, over = {}) => ({
  title,
  file,
  tests: [{ status: "expected", results: [{ duration: 5 }], ...over }],
});
const LIST = {
  suites: [
    {
      title: "home.spec.ts",
      file: "home.spec.ts",
      specs: [test1("home.spec.ts", "opens")],
    },
    {
      title: "other.spec.ts",
      file: "other.spec.ts",
      specs: [test1("other.spec.ts", "other")],
    },
    {
      title: "smoke.spec.ts",
      file: "smoke.spec.ts",
      specs: [test1("smoke.spec.ts", "boots @smoke")],
    },
    {
      title: "setup.ts",
      file: "setup.ts",
      specs: [test1("setup.ts", "seeds")],
    },
    {
      title: "red.spec.ts",
      file: "red.spec.ts",
      specs: [test1("red.spec.ts", "is red @smoke")],
    },
  ],
};
const RUNNER = {
  name: "canned",
  command: "run tests",
  specPrefix: "",
  list: () => LIST,
  invertFlag: "--invert",
};
// Reaches the home area from src/a.txt and from every harness/ path.
const GRAPH = {
  name: "demo",
  graph: () => ({
    reach: (p) => ({
      areas: new Set(
        p === "src/a.txt" || p.startsWith("harness/") ? ["home"] : [],
      ),
      specs: new Set(),
    }),
  }),
};
const selectionOf = (outside = {}) =>
  defineSelection({
    root: ROOT_DIR,
    areas: ["home", "other"],
    specs: {
      dir: "e2e",
      match: /\.spec\.ts$/,
      header: /^\/\/ areas: (.+)$/,
      setup: new Set(["setup.ts"]),
    },
    outside: { prefixes: ["src/"], ...outside },
    graphs: [GRAPH],
    runner: RUNNER,
  });
const STATE = {
  base: "b",
  versions: { node: "t" },
  packs: [],
  env: [],
  entries: [],
};
const nightlyRecord = (over = {}) => ({
  latest: { sha: "n1", status: "green", ranAt: agoIso(HOUR), ...over },
  history: [],
});
const planCtx = (over = {}) => ({
  paths: ["src/a.txt"],
  base: "basesha",
  run: { e2eFlag: "auto", nowMs: NOW, fresh: false, state: STATE },
  ...over,
});

test("NU-1 nightlyUnits plans affected on a fresh green record read from the gate's nightly dir; cmd is the runner command with --test-list <runFrom>/.turbo/e2e-selection.txt", async () => {
  mkdirSync(nightlyDir(), { recursive: true });
  writeFileSync(
    join(nightlyDir(), "latest.json"),
    JSON.stringify(nightlyRecord().latest),
  );
  const units = nightlyUnits({
    selection: selectionOf(),
    suite: "web",
    full: "run all",
    runFrom: "../..",
  });
  const sel = await units.select(planCtx());
  assert.equal(sel.mode, "affected");
  assert.equal(sel.why, "affected: 1 areas, 1 specs");
  assert.deepEqual(
    sel.units.map((u) => u.id),
    ["home.spec.ts", "@smoke+setup"],
  );
  assert.equal(
    units.cmd(sel.units, sel),
    "run tests --test-list ../../.turbo/e2e-selection.txt",
  );
  // the prepared list: the run spec, the smoke tests and the setup file, nothing else
  sel.prepare();
  assert.deepEqual(readFileSync(E2E_LIST, "utf8").trimEnd().split("\n"), [
    "home.spec.ts › opens",
    "smoke.spec.ts › boots @smoke",
    "setup.ts › seeds",
    "red.spec.ts › is red @smoke",
  ]);
  // control: the default runFrom is the working directory itself
  const dflt = nightlyUnits({
    selection: selectionOf(),
    suite: "web",
    full: "run all",
  });
  assert.match(
    (await dflt.select(planCtx())).cmd,
    /^run tests --test-list \.\/\.turbo\/e2e-selection\.txt$/,
  );
});

test("NU-2 no gate nightly key gives full with why nightly missing", async () => {
  const opts = { selection: selectionOf(), suite: "web", full: "run all", runFrom: "." };
  const run = { flag: "auto", nowMs: NOW, fresh: false, state: STATE };
  // the record is on disk (NU-1 wrote it); only the gate's nightly key decides whether it is read
  for (const gate of [{ steps: GATE.steps }, { ...GATE, nightly: undefined }]) {
    const plan = await planE2e(["src/a.txt"], "basesha", run, { ...opts, gate });
    assert.equal(plan.mode, "full");
    assert.equal(plan.why, "nightly missing");
    assert.equal(plan.cmd, "run all");
  }
});

test("NU-3 recordOf picks suites[suite] with the run's sha and ranAt; a v1 record is itself", () => {
  const v2 = {
    sha: "s1",
    ranAt: "2026-11-01T00:00:00Z",
    suites: { web: { status: "red", redSpecs: ["a.spec.ts"] } },
  };
  assert.deepEqual(recordOf(v2, "web"), {
    sha: "s1",
    ranAt: "2026-11-01T00:00:00Z",
    status: "red",
    redSpecs: ["a.spec.ts"],
  });
  const v1 = { sha: "s0", status: "green", ranAt: "2026-10-01T00:00:00Z" };
  assert.equal(recordOf(v1, "web"), v1);
});

test("NU-4 units.cmd falls back to the full command", () => {
  const units = nightlyUnits({
    selection: selectionOf(),
    suite: "web",
    full: "run all",
  });
  assert.equal(units.cmd([], {}), "run all");
  assert.equal(units.cmd([], { cmd: "run some" }), "run some");
  assert.throws(
    () => nightlyUnits({ suite: "web" }),
    /nightlyUnits: suite and full are required/,
  );
});

test("NU-8 finishShadow with a null plan returns null, even when the selection has no runner", async () => {
  const units = nightlyUnits({
    selection: defineSelection({
      specs: { dir: "e2e", match: /\.spec\.ts$/, header: /^\/\/ e2e-areas:/ },
      graphs: [{ name: "none", graph: () => ({ reach: () => ({ areas: [] }) }) }],
    }),
    suite: "web",
    full: "run all",
  });
  assert.equal(
    await units.nightly.finishShadow(null, [{ id: "e2e", status: "pass" }], {
      id: "e2e",
    }),
    null,
  );
});

test("NU-5 affectedListLines always lists the configured setup files and never a knownRed file", () => {
  const lines = affectedListLines(LIST, {
    run: ["home.spec.ts"],
    knownRed: ["red.spec.ts"],
    setup: new Set(["setup.ts"]),
  });
  assert.deepEqual(lines, [
    "home.spec.ts › opens",
    "smoke.spec.ts › boots @smoke",
    "setup.ts › seeds",
  ]);
  // control: with no setup file configured the setup test is not listed
  assert.ok(
    !affectedListLines(LIST, {
      run: ["home.spec.ts"],
      knownRed: [],
      setup: new Set(),
    }).includes("setup.ts › seeds"),
  );
});

test("NU-6 reachesHarness: a changed outside.reach path the graph reaches is true; a test file there is false", async () => {
  const selection = selectionOf({
    reach: ["harness/"],
    testFile: /\.test\.ts$/,
  });
  const reaches = (paths) => reachesHarness(paths, "basesha", { selection });
  assert.equal(await reaches(["harness/h.ts"]), true);
  assert.equal(await reaches(["harness/h.test.ts"]), false);
  assert.equal(await reaches(["docs/x.md"]), false);
});

test("NU-7 nightly.finish keeps today's summary text and receipt fields", () => {
  const { nightly } = nightlyUnits({
    selection: selectionOf(),
    suite: "web",
    full: "run all",
  });
  const ctx = {
    report: {
      suites: [
        {
          title: "x",
          specs: [
            test1("home.spec.ts", "opens"),
            test1("setup.ts", "seeds"),
          ],
        },
      ],
    },
    mode: "affected",
    why: "why",
    selected: ["home.spec.ts"],
    nightly: { sha: "n1", ranAt: "R", status: "green" },
    knownRed: [],
    run: ["home.spec.ts"],
    reused: [],
    digests: new Map([["home.spec.ts", "d1"]]),
    setup: new Set(["setup.ts"]),
    checkedAt: "C",
  };
  const done = nightly.finish({ id: "e2e", status: "pass", summary: "ok" }, ctx);
  assert.equal(
    done.summary,
    "affected (why): 1 run, 0 reused, 0 known red; ok",
  );
  assert.deepEqual(
    Object.keys(done).filter((k) => k !== "id"),
    ["status", "summary", "mode", "why", "selected", "specs", "nightly", "knownRed"],
  );
  assert.deepEqual(done.specs, [
    { file: "home.spec.ts", digest: "d1", status: "pass", ms: 5 },
  ]);
  assert.deepEqual(done.nightly, {
    sha: "n1",
    ranAt: "R",
    status: "green",
    checkedAt: "C",
  });
  // a failing spec turns a passing step into a failing one
  const bad = finishE2e(
    { status: "pass", summary: "ok" },
    {
      ...ctx,
      report: {
        suites: [{ title: "x", specs: [test1("home.spec.ts", "opens", { status: "unexpected" })] }],
      },
    },
  );
  assert.equal(bad.status, "fail");
  assert.match(bad.summary, /spec failed or absent from the report: home\.spec\.ts$/);
});
