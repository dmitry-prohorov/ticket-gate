// Reuse of a green step result on identical inputs, and the step ledger, proved against a
// synthetic one-step project: only the newest ledger line on the step's digest decides, only a
// pass is reused, --fresh reuses nothing, and a ledger keeps a bounded number of lines.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";

const SYN = `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [step({ id: 'cov', when: true, cmd: 'run cov', reuse: { deny: [] } })],
});
`;

// plan.mjs and ledger.mjs load the project config at import.
const leave = enterScratchProject(SYN);
const { planFor } = await import("../plan.mjs");
const { defineGate, step } = await import("../config.mjs");
const { LEDGER_MAX, appendLedger, ledgerLines, newestLedgerLine, readLedger } =
  await import("../ledger.mjs");
const { receiptOk } = await import("../receipt.mjs");

const tmp = mkdtempSync(join(tmpdir(), "step-reuse-"));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  leave();
});

const CMD = "run cov";
const config = defineGate({
  steps: [step({ id: "cov", when: true, cmd: CMD, reuse: { deny: [] } })],
});
const digestOf = (id, cmd) => `digest:${id}:${cmd}`;
const line = (status, ranAt, over = {}) => ({
  id: "cov",
  cmd: CMD,
  digest: digestOf("cov", CMD),
  status,
  ranAt,
  summary: "ok",
  ms: 1,
  ...over,
});
const modeOf = (ledger, opts = {}) =>
  planFor(config, ["src/a.txt"], {
    exists: () => true,
    base: "HEAD",
    digestOf,
    ledger,
    ...opts,
  }).steps.find((s) => s.id === "cov").mode;

test("VR-2a only a passing ledger line is reused; a lone fail line runs the step", () => {
  assert.equal(modeOf([line("pass", "T1")]), "reuse");
  assert.equal(modeOf([line("fail", "T1")]), "run");
  assert.equal(modeOf([]), "run");
});

test("VR-2b the newest ledger line on the digest rules, not the oldest", () => {
  const older = line("pass", "T1");
  const newer = line("fail", "T2");
  assert.equal(modeOf([older, newer]), "run");
  assert.equal(modeOf([newer, older]), "reuse");
  const key = { id: "cov", cmd: CMD, digest: older.digest };
  assert.equal(newestLedgerLine([older, newer], key).ranAt, "T2");
  assert.equal(newestLedgerLine([newer, older], key).ranAt, "T1");
});

test("VR-5 --fresh runs the step despite a green ledger line", () => {
  const ledger = [line("pass", "T1")];
  assert.equal(modeOf(ledger), "reuse");
  assert.equal(modeOf(ledger, { fresh: true }), "run");
});

test("VR-7 receiptOk accepts pass, human and reused and rejects an unknown status", () => {
  assert.equal(
    receiptOk([{ status: "pass" }, { status: "human" }, { status: "reused" }]),
    true,
  );
  assert.equal(receiptOk([{ status: "pass" }, { status: "weird" }]), false);
  assert.equal(receiptOk([{ status: "pass" }, { status: "fail" }]), false);
  assert.equal(receiptOk([{ status: "skipped" }]), false);
});

test("VG-1 the 201st ledger append leaves the newest 200", () => {
  const file = join(tmp, "cap.jsonl");
  appendLedger(
    file,
    Array.from({ length: LEDGER_MAX }, (_, i) => ({ id: "x", n: i })),
  );
  appendLedger(file, [{ id: "x", n: LEDGER_MAX }]);
  const got = readLedger(file);
  assert.equal(got.length, LEDGER_MAX);
  assert.equal(got[0].n, 1);
  assert.equal(got.at(-1).n, LEDGER_MAX);
});

const result = (status, over = {}) => ({
  id: "cov",
  cmd: CMD,
  status,
  digest: "D",
  summary: "s",
  ms: 7,
  ...over,
});

test("VG-3 a failed step is ledgered as well as a pass; skipped, human and reused are not", () => {
  const results = [
    result("pass"),
    result("fail"),
    result("skipped"),
    result("human"),
    result("reused"),
  ];
  const lines = ledgerLines(results, { ranAt: "T", digestNow: () => "D" });
  assert.deepEqual(
    lines.map((l) => l.status),
    ["pass", "fail"],
  );
});

test("VG-4 a step whose digest moved during the run writes no ledger line", () => {
  const results = [
    result("pass", { id: "a", digest: "D1" }),
    result("pass", { id: "b", digest: "D2" }),
  ];
  const lines = ledgerLines(results, {
    ranAt: "T",
    digestNow: (id) => (id === "a" ? "D1" : "moved"),
  });
  assert.deepEqual(
    lines.map((l) => l.id),
    ["a"],
  );
});
