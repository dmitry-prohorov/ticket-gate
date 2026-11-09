// Ported cases of the nightly-backed units step: the freshness window, known red, per-unit reuse,
// the result of a run, the ledgers, the --e2e flag and the dry-run mode line. Each test keeps the
// id of the case it was ported from and runs against a synthetic project (scratch-project.mjs for
// the in-process cases, a throwaway git project for the spawned ones). Nothing here names a
// consumer.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { bin, gateProject } from "./mutations/__tests__/gate-project.mjs";
import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";

const ENGINE = join(import.meta.dirname, "..");
const UNITS_URL = pathToFileURL(join(ENGINE, "selection", "units.mjs")).href;
const DEFINE_URL = pathToFileURL(join(ENGINE, "selection", "define.mjs")).href;

const leave = enterScratchProject();
const scratchDirs = [];
after(() => {
  leave();
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});
const { defineGate, step } = await import("../config.mjs");
const { planFor } = await import("../plan.mjs");
const { buildResults } = await import("../run.mjs");
const { NIGHTLY_MAX_AGE_MS } = await import("../digest.mjs");
const { FRESH_MS } = await import("../nightly/record.mjs");
const {
  SPEC_LEDGER_MAX,
  appendSpecLedger,
  fullMedianLine,
  ledgerLines,
  readLedger,
  specLedgerLines,
} = await import("../ledger.mjs");
const {
  affectedListLines,
  chooseE2eMode,
  finishE2e,
  knownRedLines,
  knownRedOf,
  parseE2eFlag,
  planSpecs,
  specResults,
} = await import("../selection/units.mjs");

const quiet = (fn) => {
  const write = process.stdout.write;
  const log = console.log;
  process.stdout.write = () => true;
  console.log = () => {};
  try {
    return fn();
  } finally {
    process.stdout.write = write;
    console.log = log;
  }
};
const byId = (list, id) => list.find((x) => x.id === id);
const passing = () => ({ status: 0, out: "3 passed\n" });
const SETUP = new Set(["seed.setup.ts"]);

test("P81 VE-2 b the freshness window of the nightly record and of the affected plan are the same number", () => {
  assert.equal(NIGHTLY_MAX_AGE_MS, FRESH_MS);
  // control: the shared number is 36 hours, not zero or unset
  assert.equal(FRESH_MS, 36 * 3_600_000);
});

const nrun = (sha, status, ranAt, redSpecs = [], extra = {}) => ({
  sha,
  status,
  ranAt,
  redSpecs,
  reachedPlaywright: true,
  ...extra,
});

test("P81 VE-5 known red walks the ancestors, skips a non-ancestor, lets the newest usable run decide and ignores an unreached run", () => {
  const ancestors = new Set(["old", "base"]);
  const isAncestor = (sha) => ancestors.has(sha);
  const known = (over) =>
    knownRedOf({
      runs: [],
      baseSha: "base",
      isAncestor,
      branch: "feat/x",
      selected: [],
      ...over,
    });
  const older = nrun("old", "red", "2026-10-29T00:00:00Z", [
    "b.spec.ts",
    "a.spec.ts",
  ]);
  // a newer red run on a commit that is not an ancestor of the base is skipped for the older ancestor
  const newer = nrun("later", "red", "2026-10-31T00:00:00Z", ["z.spec.ts"]);
  assert.deepEqual(known({ runs: [newer, older] }), ["a.spec.ts", "b.spec.ts"]);
  // a run at the base itself counts without asking isAncestor
  assert.deepEqual(
    known({
      runs: [nrun("base", "red", "2026-10-30T00:00:00Z", ["c.spec.ts"])],
      isAncestor: () => false,
    }),
    ["c.spec.ts"],
  );
  // the newest usable run decides: a green one after the red clears it
  assert.deepEqual(
    known({ runs: [older, nrun("base", "green", "2026-10-30T00:00:00Z")] }),
    [],
  );
  // a run that never reached the browser tests is no verdict
  assert.deepEqual(
    known({
      runs: [
        older,
        nrun("base", "red", "2026-10-30T00:00:00Z", ["c.spec.ts"], {
          reachedPlaywright: false,
        }),
      ],
    }),
    ["a.spec.ts", "b.spec.ts"],
  );
  assert.deepEqual(known({ runs: [] }), []);
  // a nightly-fix branch runs every red spec
  assert.deepEqual(known({ runs: [older], branch: "fix/nightly-x" }), []);
  // the branch's own selection is not known red
  assert.deepEqual(known({ runs: [older], selected: ["a.spec.ts"] }), [
    "b.spec.ts",
  ]);
});

const listSuite = (file, specs) => ({
  title: file,
  file,
  specs: specs.map(([title, tags = []]) => ({
    title,
    file,
    tags,
    tests: [{ projectName: "chromium" }],
  })),
});
const LIST = {
  suites: [
    listSuite("seed.setup.ts", [["snapshot the seed"]]),
    listSuite("a.spec.ts", [["opens"], ["saves"]]),
    listSuite("red.spec.ts", [["breaks"], ["red smoke @smoke"]]),
    listSuite("c.spec.ts", [["other"]]),
  ],
};

test("P81 VE-6 b known red lines list every test of a known red file, smoke tests included, and nothing of another file", () => {
  assert.deepEqual(knownRedLines(LIST, ["red.spec.ts"]), [
    "red.spec.ts › breaks",
    "red.spec.ts › red smoke @smoke",
  ]);
  assert.deepEqual(knownRedLines(LIST, ["a.spec.ts", "c.spec.ts"]), [
    "a.spec.ts › opens",
    "a.spec.ts › saves",
    "c.spec.ts › other",
  ]);
  assert.deepEqual(knownRedLines(LIST, []), []);
});

const AFFECTED = { mode: "affected", why: "affected: 1 areas, 1 specs" };
const NOW = Date.parse("2026-11-02T12:00:00Z");
const nightlyAt = (status, agoMs = 0) => ({
  sha: "n1",
  status,
  ranAt: new Date(NOW - agoMs).toISOString(),
});

test("P81 VE-3 a nightly that is stale, red, errored, missing, without a usable ranAt, or the --e2e=full flag each force the full suite and never throw", () => {
  const choose = (nightly, flag = "auto") =>
    chooseE2eMode({ selection: AFFECTED, nightly, flag, nowMs: NOW });
  // control: a fresh green nightly keeps the affected mode
  assert.deepEqual(choose(nightlyAt("green", 1000)), {
    mode: "affected",
    why: AFFECTED.why,
  });
  assert.deepEqual(choose(nightlyAt("green", NIGHTLY_MAX_AGE_MS + 1)), {
    mode: "full",
    why: "nightly stale",
  });
  assert.deepEqual(choose(nightlyAt("red")), {
    mode: "full",
    why: "nightly red",
  });
  assert.deepEqual(choose(nightlyAt("error")), {
    mode: "full",
    why: "nightly error",
  });
  for (const none of [null, undefined])
    assert.deepEqual(choose(none), { mode: "full", why: "nightly missing" });
  assert.deepEqual(choose({ ...nightlyAt("green"), ranAt: "garbage" }), {
    mode: "full",
    why: "nightly stale",
  });
  // a record with no ranAt at all has no age: stale, not fresh
  assert.deepEqual(choose({ status: "green" }), {
    mode: "full",
    why: "nightly stale",
  });
  // the flag beats a perfect nightly
  assert.deepEqual(choose(nightlyAt("green"), "full"), {
    mode: "full",
    why: "--e2e=full",
  });
});

test("P81 VE-6 a a test marked smoke only by a tag is listed for an affected run, and an untagged test of a file that did not run is not", () => {
  const list = {
    suites: [
      {
        title: "b.spec.ts",
        file: "b.spec.ts",
        specs: [
          {
            title: "boots",
            file: "b.spec.ts",
            tags: ["@smoke"],
            tests: [{ projectName: "chromium" }],
          },
          {
            title: "test tagged",
            file: "b.spec.ts",
            tests: [{ projectName: "chromium", tags: ["smoke"] }],
          },
          {
            title: "plain",
            file: "b.spec.ts",
            tags: ["@slow"],
            tests: [{ projectName: "chromium" }],
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    affectedListLines(list, { run: [], knownRed: [], setup: new Set() }),
    ["b.spec.ts › boots", "b.spec.ts › test tagged"],
  );
});

// A spec's digest here is a function of the file and of the state of its own inputs only, so the
// planner needs no git.
const ALL_SPECS = ["calendar.spec.ts", "settings.spec.ts", "timetable.spec.ts"];
const INPUTS = new Map([
  ["calendar.spec.ts", []],
  ["settings.spec.ts", ["src/settings.ts"]],
  ["timetable.spec.ts", ["src/timetable.ts"]],
]);
const digestFor = (state) => (file, inputs) =>
  `${file}|${inputs.map((p) => `${p}=${state[p]}`).join(",")}`;
const plannerFor = (state, specLedger, over = {}) =>
  planSpecs({
    selected: ["settings.spec.ts", "timetable.spec.ts"],
    inputs: INPUTS,
    digestOf: digestFor(state),
    specLedger,
    fresh: false,
    alwaysRun: new Set(),
    ...over,
  });
const STATE = { "src/settings.ts": "one", "src/timetable.ts": "one" };
const ledgerOf = (plan, ranAt, status = "pass") =>
  plan.run.map((file) => ({
    id: "e2e-spec",
    file,
    digest: plan.digests.get(file),
    status,
    ranAt,
    mode: "affected",
    ms: 10,
  }));

test("P81 VE-7 a second round re-runs the specs whose inputs moved and reuses the rest with the entry shape", () => {
  const one = plannerFor(STATE, []);
  assert.deepEqual(one.run, ["settings.spec.ts", "timetable.spec.ts"]);
  assert.deepEqual(one.reused, []);
  assert.deepEqual([...one.digests.keys()].sort(), ALL_SPECS);
  const ledger = ledgerOf(one, "T1");
  // round two: only the timetable input moved
  const two = plannerFor({ ...STATE, "src/timetable.ts": "two" }, ledger);
  assert.deepEqual(two.run, ["timetable.spec.ts"]);
  assert.deepEqual(two.reused, [
    {
      file: "settings.spec.ts",
      digest: one.digests.get("settings.spec.ts"),
      inputs: ["src/settings.ts"],
      reusedFrom: "T1",
    },
  ]);
  // nothing moved: both are reused
  assert.deepEqual(plannerFor(STATE, ledger).run, []);
  // a failing newest line on the digest re-runs although an older pass exists
  const failedAfter = [...ledger, ...ledgerOf(one, "T2", "fail")];
  assert.deepEqual(plannerFor(STATE, failedAfter).run, [
    "settings.spec.ts",
    "timetable.spec.ts",
  ]);
  // a pass recorded on another digest is no match
  const stale = ledger.map((l) => ({ ...l, digest: "other" }));
  assert.equal(plannerFor(STATE, stale).reused.length, 0);
});

test("P81 VE-8 an amber flaky spec and a fresh run are never reused", () => {
  const ledger = ledgerOf(plannerFor(STATE, []), "T1");
  assert.equal(plannerFor(STATE, ledger).reused.length, 2);
  const amber = plannerFor(STATE, ledger, {
    alwaysRun: new Set(["settings.spec.ts"]),
  });
  assert.deepEqual(amber.run, ["settings.spec.ts"]);
  assert.deepEqual(
    amber.reused.map((r) => r.file),
    ["timetable.spec.ts"],
  );
  const fresh = plannerFor(STATE, ledger, { fresh: true });
  assert.deepEqual(fresh.run, ["settings.spec.ts", "timetable.spec.ts"]);
  assert.deepEqual(fresh.reused, []);
});

test("P81 VE-8b an amber flaky spec that is not in the selection is never planned to run", () => {
  const planned = plannerFor(STATE, [], {
    selected: ["settings.spec.ts"],
    alwaysRun: new Set(["gone.spec.ts"]),
  });
  assert.deepEqual(planned.run, ["settings.spec.ts"]);
  assert.deepEqual(planned.reused, []);
});

test("P81 VE-9 the option the caller passes for a step reaches the planned step: its command and its prepare hook", () => {
  const config = defineGate({
    steps: [
      step({
        id: "suite",
        when: ["web/**"],
        cmd: "run all",
        reuse: false,
        option: "suite",
      }),
    ],
  });
  const prepare = () => {};
  const planned = (suite) =>
    byId(
      planFor(config, ["web/x"], {
        exists: () => true,
        base: "HEAD",
        ...(suite ? { suite } : {}),
      }).steps,
      "suite",
    );
  // control: no option leaves the step as the config states it
  assert.equal(planned().cmd, "run all");
  assert.equal(planned().prepare, undefined);
  const over = planned({
    when: true,
    mode: "affected",
    cmd: "run some",
    prepare,
  });
  assert.equal(over.cmd, "run some");
  assert.equal(over.prepare, prepare);
});

const min = (m) => m * 60 * 1000;
const e2eLine = (ms, ranAt, over = {}) => ({
  id: "e2e",
  cmd: "c",
  digest: "d",
  status: "pass",
  ranAt,
  ms,
  ...over,
});

test("P81 VE-10 a over 20 minutes the warning names the largest specs of the newest run, and without spec lines it names none", () => {
  const slow = [20, 21, 21, 22, 23].map((m, i) => e2eLine(min(m), `T${i}`));
  const specs = [
    { id: "e2e-spec", file: "big.spec.ts", ranAt: "T4", ms: min(5) },
    { id: "e2e-spec", file: "mid.spec.ts", ranAt: "T4", ms: min(2) },
    { id: "e2e-spec", file: "old.spec.ts", ranAt: "T0", ms: min(9) },
  ];
  const warned = fullMedianLine(slow, specs);
  assert.equal(warned.warn, true);
  assert.match(
    warned.line,
    /^e2e full median: .*21m.* over the last 5 full runs\n/,
  );
  assert.match(
    warned.line,
    /WARNING: over the 20 min budget \(D10\); largest specs: big\.spec\.ts .*5m.*, mid\.spec\.ts .*2m.*$/,
  );
  assert.doesNotMatch(warned.line, /old\.spec/);
  // no spec line of the newest run: the warning stands without a list
  const bare = fullMedianLine(slow, [specs[2]]);
  assert.equal(bare.warn, true);
  assert.match(bare.line, /WARNING: over the 20 min budget/);
  assert.doesNotMatch(bare.line, /largest specs/);
  assert.equal(fullMedianLine(slow, []).line.includes("largest specs"), false);
});

test("P81 VE-10 b only the newest five full runs count; a failed line and a line without ms are not runs", () => {
  // six runs: the median of the newest five is 25 min and warns; counting the oldest would not
  const six = [1, 1, 1, 25, 25, 25].map((m, i) => e2eLine(min(m), `T${i}`));
  const got = fullMedianLine(six, []);
  assert.equal(got.warn, true);
  assert.match(got.line, /over the last 5 full runs/);
  // the same six with the newest five calm: no warning although the oldest is slow
  const calm = [60, 19, 19, 19, 19, 19].map((m, i) => e2eLine(min(m), `T${i}`));
  assert.equal(fullMedianLine(calm, []).warn, false);
  // a fail or a line without ms is not a run
  assert.equal(
    fullMedianLine(
      [e2eLine(min(60), "T", { status: "fail" }), e2eLine(undefined, "T")],
      [],
    ),
    null,
  );
});

const reportOf = (files) => ({
  suites: Object.entries(files).map(([file, statuses]) => ({
    title: file,
    file,
    specs: statuses.map((status, i) => ({
      title: `t${i}`,
      file,
      tests: [{ status, results: [{ duration: 1000 }] }],
    })),
  })),
});

test("P81 VE-11 specResults fails an unexpected or absent spec and passes a flaky one; a throwing prepare is a failed step the runner never sees", () => {
  const digests = new Map([
    ["a.spec.ts", "da"],
    ["b.spec.ts", "db"],
    ["c.spec.ts", "dc"],
    ["gone.spec.ts", "dg"],
    ["r.spec.ts", "dr"],
  ]);
  const reused = [
    { file: "r.spec.ts", digest: "dr", inputs: ["p"], reusedFrom: "T1" },
  ];
  const report = reportOf({
    "seed.setup.ts": ["expected"],
    "a.spec.ts": ["expected", "unexpected"],
    "b.spec.ts": ["flaky", "skipped"],
    "c.spec.ts": ["expected"],
  });
  const affected = specResults(report, {
    mode: "affected",
    run: ["a.spec.ts", "b.spec.ts", "gone.spec.ts"],
    reused,
    digests,
    setup: SETUP,
  });
  assert.deepEqual(affected, [
    { file: "a.spec.ts", digest: "da", status: "fail", ms: 2000 },
    { file: "b.spec.ts", digest: "db", status: "pass", ms: 2000 },
    { file: "gone.spec.ts", digest: "dg", status: "fail" },
    {
      file: "r.spec.ts",
      digest: "dr",
      status: "reused",
      inputs: ["p"],
      reusedFrom: "T1",
    },
  ]);
  // full: every spec file of the report, the setup files excepted
  const full = specResults(report, {
    mode: "full",
    run: [],
    reused: [],
    digests,
    setup: SETUP,
  });
  assert.deepEqual(
    full.map((e) => `${e.file}:${e.status}`),
    ["a.spec.ts:fail", "b.spec.ts:pass", "c.spec.ts:pass"],
  );
  // the step: a pass turns into a fail, with the cause in the summary
  const done = finishE2e(
    { id: "e2e", cmd: "c", status: "pass", summary: "3 passed", ms: 5 },
    {
      report,
      mode: "affected",
      why: "affected: 1 areas, 1 specs",
      selected: ["a.spec.ts"],
      nightly: { sha: "n1", status: "green", ranAt: "R" },
      checkedAt: "C",
      knownRed: ["k.spec.ts"],
      run: ["a.spec.ts"],
      reused,
      digests,
      setup: SETUP,
    },
  );
  assert.equal(done.status, "fail");
  assert.match(
    done.summary,
    /^affected \(affected: 1 areas, 1 specs\): 1 run, 1 reused, 1 known red; 3 passed; spec failed or absent from the report: a\.spec\.ts$/,
  );
  assert.deepEqual(done.nightly, {
    sha: "n1",
    ranAt: "R",
    status: "green",
    checkedAt: "C",
  });
  // an all-green report keeps the pass; no nightly records null
  const green = finishE2e(
    { id: "e2e", cmd: "c", status: "pass", summary: "1 passed" },
    {
      report: reportOf({ "c.spec.ts": ["expected"] }),
      mode: "full",
      why: "--e2e=full",
      selected: [],
      nightly: null,
      checkedAt: "C",
      knownRed: [],
      run: [],
      reused: [],
      digests,
      setup: SETUP,
    },
  );
  assert.equal(green.status, "pass");
  assert.equal(green.nightly, null);
  // a prepare that throws is a failed step and the runner never sees it
  const config = defineGate({
    steps: [
      step({
        id: "e2e",
        when: ["web/**"],
        cmd: "run all",
        reuse: false,
        units: { select: () => ({}), cmd: (_u, sel) => sel.cmd },
      }),
    ],
  });
  const plan = planFor(config, ["web/x"], {
    exists: () => true,
    base: "HEAD",
    units: {
      e2e: {
        mode: "affected",
        why: "affected: 1 areas",
        units: [{ id: "u", inputs: [] }],
        cmd: "run some",
        prepare: () => {
          throw new Error("boom");
        },
      },
    },
  });
  const seen = [];
  const out = quiet(() =>
    buildResults(plan, (st) => {
      seen.push(st.id);
      return passing();
    }),
  );
  const red = byId(out.results, "e2e");
  assert.equal(red.status, "fail");
  assert.equal(red.summary, "e2e list: boom");
  assert.equal(seen.includes("e2e"), false);
  assert.equal(out.ok, false);
  assert.match(byId(out.failures, "e2e").out, /e2e list: boom/);
});

test("P81 VE-12 ledger lines carry the mode, a spec ledger line is skipped when its inputs moved during the run, and the spec ledger keeps its cap", () => {
  const lines = ledgerLines(
    [
      {
        id: "e2e",
        cmd: "c",
        digest: "d",
        status: "pass",
        mode: "affected",
        summary: "s",
        ms: 9,
      },
      {
        id: "check",
        cmd: "k",
        digest: "d",
        status: "pass",
        summary: "s",
        ms: 1,
      },
    ],
    { ranAt: "T", digestNow: () => "d" },
  );
  assert.equal(lines[0].mode, "affected");
  assert.equal("mode" in lines[1], false);
  const specs = [
    { file: "a.spec.ts", digest: "d1", status: "pass", ms: 5 },
    { file: "b.spec.ts", digest: "d2", status: "fail" },
    { file: "moved.spec.ts", digest: "d3", status: "pass", ms: 1 },
    { file: "r.spec.ts", digest: "d4", status: "reused", inputs: [] },
    { file: "nodigest.spec.ts", status: "pass" },
  ];
  const got = specLedgerLines(specs, {
    ranAt: "T",
    mode: "affected",
    ms: 77,
    digestNow: (f) =>
      f === "moved.spec.ts"
        ? "changed"
        : { "a.spec.ts": "d1", "b.spec.ts": "d2", "r.spec.ts": "d4" }[f],
  });
  assert.deepEqual(got, [
    {
      id: "e2e-spec",
      file: "a.spec.ts",
      digest: "d1",
      status: "pass",
      ranAt: "T",
      mode: "affected",
      ms: 5,
    },
    {
      id: "e2e-spec",
      file: "b.spec.ts",
      digest: "d2",
      status: "fail",
      ranAt: "T",
      mode: "affected",
      ms: 77,
    },
  ]);
  // the spec ledger keeps the newest SPEC_LEDGER_MAX lines
  const dir = mkdtempSync(join(tmpdir(), "gate-spec-ledger-"));
  scratchDirs.push(dir);
  const file = join(dir, "specs.jsonl");
  appendSpecLedger(
    file,
    Array.from({ length: SPEC_LEDGER_MAX }, (_, i) => ({ n: i })),
  );
  appendSpecLedger(file, [{ n: SPEC_LEDGER_MAX }]);
  const kept = readLedger(file);
  assert.equal(kept.length, SPEC_LEDGER_MAX);
  assert.equal(kept[0].n, 1);
  assert.equal(kept.at(-1).n, SPEC_LEDGER_MAX);
});

// A throwaway git project whose gate has a step carrying nightly units, for the spawned cases.
const unitsConfig =
  () => `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
import { nightlyUnits } from ${JSON.stringify(UNITS_URL)};
import { defineSelection } from ${JSON.stringify(DEFINE_URL)};
const selection = defineSelection({
  specs: { dir: 'e2e', match: /\\.spec\\.ts$/, header: /^\\/\\/ areas: (.+)$/ },
  graphs: [{ name: 'g', graph: () => ({ reach: () => ({ areas: new Set(), specs: new Set() }) }) }],
  runner: { name: 'canned', command: 'run tests', specPrefix: '', list: () => ({ suites: [] }), invertFlag: '--invert' },
});
export default defineGate({
  steps: [
    step({ id: 'a', when: true, cmd: 'echo ok-a', reuse: false }),
    step({
      id: 'suite',
      when: ['web/**'],
      cmd: 'run all',
      reuse: false,
      units: nightlyUnits({ selection, suite: 'web', full: 'run all' }),
    }),
  ],
});
`;
const unitsProject = () => {
  const p = gateProject({ config: unitsConfig(), registry: null });
  return p;
};

test("P81 VE-13 an unknown --e2e value exits 2 with the usage text and writes no receipt; --e2e=full is accepted in a dry run", () => {
  assert.deepEqual(parseE2eFlag([]), { flag: "auto" });
  assert.deepEqual(parseE2eFlag(["--e2e=full"]), { flag: "full" });
  for (const bad of ["--e2e=fast", "--e2e=", "--e2e"])
    assert.ok(parseE2eFlag([bad]).error, bad);
  const p = unitsProject();
  p.put("web/x", "x\n");
  const r = bin(p.dir, ["verify", "--e2e=fast"]);
  assert.equal(r.status, 2, r.out);
  assert.match(
    r.out,
    /verify:ticket: unknown --e2e value "fast"\. Only --e2e=full is valid\./,
  );
  assert.equal(existsSync(join(p.dir, ".turbo", "ticket-verify.json")), false);
  assert.doesNotMatch(r.out, /===/);
  const ok = bin(p.dir, ["verify", "--e2e=full", "--dry-run"]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(
    ok.out,
    /^e2e: full \(--e2e=full\); run all, reuse 0, known red 0$/m,
  );
});

test("P81 VE-14 a dry run prints the e2e mode line for a selected units step and none when the step is unselected", () => {
  const p = unitsProject();
  p.put("web/x", "x\n");
  const r = bin(p.dir, ["verify", "--dry-run"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^e2e: full \(.+\); run all, reuse 0, known red 0$/m);
  assert.match(r.out, /RUN {4}run all/);
  // a diff that selects no units step prints no e2e line
  const q = unitsProject();
  q.put("docs/x.md", "x\n");
  const none = bin(q.dir, ["verify", "--dry-run"]);
  assert.equal(none.status, 0, none.out);
  assert.doesNotMatch(none.out, /^e2e:/m);
  assert.doesNotMatch(none.out, /RUN {4}run all/);
});
