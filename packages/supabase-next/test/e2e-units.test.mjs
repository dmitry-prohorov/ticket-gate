// The e2e unit planner: which mode a run takes, which units are known red, which are reused.
// Pure functions over plain data; the nightly helpers the pack calls are injected.
import assert from "node:assert/strict";
import { test } from "node:test";

import { enterScratchProject } from "../../engine/test/scratch-project.mjs";
import { bindTools } from "../tools.mjs";

// the pack reads the project root through the engine at import
enterScratchProject();
const { chooseE2eMode, knownRedOf, onDisk, planSpecs } = await import(
  "../e2e-units.mjs"
);
const { NIGHTLY_MAX_AGE_MS } = await import("../../engine/digest.mjs");

bindTools({
  nightly: {
    REACHED: (r) => r.reachedPlaywright === true,
    byRanAtDesc: (a, b) => Date.parse(b.ranAt) - Date.parse(a.ranAt),
  },
});

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
