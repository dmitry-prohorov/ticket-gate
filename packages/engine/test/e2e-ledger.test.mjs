// The e2e ledger rules, proved against a synthetic project: a unit digest covers its inputs and
// tooling, a full-only step is never reused from an affected or known-red run, and the full-run
// median warns above its budget.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";

const SYN = `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [
    step({ id: 'e2e', when: true, cmd: 'run e2e', option: 'e2e', reuse: { deny: ['docs/'], fullOnly: true } }),
  ],
  toolPrefixes: ['tools/'],
});
`;

// digest.mjs and plan.mjs read the config at import, so they load after the chdir.
enterScratchProject(SYN);
const { specDigest } = await import("../digest.mjs");
const { planFor } = await import("../plan.mjs");
const { fullMedianLine, FULL_MEDIAN_WARN_MS } = await import("../ledger.mjs");
const { formatMs } = await import("../summary.mjs");
const { defineGate, step } = await import("../config.mjs");

const state = (entries) => ({
  base: "b".repeat(40),
  versions: { node: "v0" },
  env: [],
  entries,
});
const digest = (inputs, entries) =>
  specDigest("u1", inputs, { state: state(entries) });

test("VE-7a a unit digest covers its own inputs and tooling paths, and nothing else", () => {
  const none = digest([], []);
  // its input moves it
  assert.notEqual(digest(["src/a.txt"], [["src/a.txt", "A"]]), none);
  // a tooling path moves it although it is no input
  assert.notEqual(digest([], [["tools/helper.mjs", "A"]]), none);
  // control: a path that is neither does not
  assert.equal(digest([], [["src/b.txt", "A"]]), none);
  assert.equal(
    digest(["src/a.txt"], [["src/b.txt", "A"]]),
    digest(["src/a.txt"], []),
  );
});

const config = defineGate({
  steps: [
    step({
      id: "e2e",
      when: true,
      cmd: "run e2e",
      option: "e2e",
      reuse: { deny: ["docs/"], fullOnly: true },
    }),
  ],
});
const planE2e = (ledger, e2e) =>
  planFor(config, ["web/x"], {
    exists: () => true,
    base: "HEAD",
    digestOf: () => "d",
    ledger,
    ...(e2e ? { e2e } : {}),
  }).steps.find((s) => s.id === "e2e");
const pass = (over = {}) => ({
  id: "e2e",
  cmd: "run e2e",
  digest: "d",
  status: "pass",
  ranAt: "T1",
  ...over,
});

test("VE-9 a full-only step is not reused from an affected line, an affected plan or a known-red plan; a mode-less line counts as full", () => {
  // a line from before modes existed has no mode and counts as full
  assert.equal(planE2e([pass()]).mode, "reuse");
  assert.equal(planE2e([pass({ mode: "full" })]).mode, "reuse");
  assert.equal(planE2e([pass({ mode: "affected" })]).mode, "run");
  assert.equal(planE2e([pass()], { mode: "affected" }).mode, "run");
  assert.equal(
    planE2e([pass()], { mode: "full", knownRedCount: 1 }).mode,
    "run",
  );
  // control: a full plan with nothing known red reuses
  assert.equal(
    planE2e([pass()], { mode: "full", knownRedCount: 0 }).mode,
    "reuse",
  );
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

test("VE-10a the median of the last five full runs warns above 20 min, naming the largest units, and not at or below it", () => {
  assert.equal(FULL_MEDIAN_WARN_MS, min(20));
  assert.equal(fullMedianLine([], []), null);
  const calm = [19, 19, 19, 19, 19].map((m, i) => e2eLine(min(m), `T${i}`));
  const ok = fullMedianLine(calm, []);
  assert.equal(ok.warn, false);
  assert.equal(
    ok.line,
    `e2e full median: ${formatMs(min(19))} over the last 5 full runs`,
  );
  // exactly the budget is not over it
  assert.equal(fullMedianLine([e2eLine(min(20), "T0")], []).warn, false);
  const slow = [20, 21, 21, 22, 23].map((m, i) => e2eLine(min(m), `T${i}`));
  const units = [
    { id: "e2e-spec", file: "big", ranAt: "T4", ms: min(5) },
    { id: "e2e-spec", file: "old", ranAt: "T0", ms: min(9) },
  ];
  const warned = fullMedianLine(slow, units);
  assert.equal(warned.warn, true);
  assert.ok(
    warned.line.startsWith(
      `e2e full median: ${formatMs(min(21))} over the last 5 full runs\n`,
    ),
  );
  assert.match(warned.line, /WARNING: over the 20 min budget/);
  assert.ok(warned.line.includes(`big ${formatMs(min(5))}`));
  assert.ok(!warned.line.includes("old"));
});

test("VE-10b the median counts full runs only, a line without a mode as full", () => {
  // five modeless 19 min runs and three slow affected ones: the affected lines are not runs
  const lines = [
    ...[19, 19, 19, 19, 19].map((m, i) => e2eLine(min(m), `T${i}`)),
    ...["T7", "T8", "T9"].map((t) => e2eLine(min(90), t, { mode: "affected" })),
  ];
  const got = fullMedianLine(lines, []);
  assert.equal(got.warn, false);
  assert.equal(
    got.line,
    `e2e full median: ${formatMs(min(19))} over the last 5 full runs`,
  );
  // only affected lines: no full run at all
  assert.equal(
    fullMedianLine([e2eLine(min(60), "T", { mode: "affected" })], []),
    null,
  );
  // an explicit full line counts
  assert.equal(
    fullMedianLine([e2eLine(min(60), "T", { mode: "full" })], []).warn,
    true,
  );
});
