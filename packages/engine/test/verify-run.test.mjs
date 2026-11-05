// The verify run's bookkeeping: the receipt, the green-run history, the failure summary and the
// paste block. Pure parts run in process after a chdir into a throwaway project (the modules
// read the config at import); the red-run flows spawn the bin in a throwaway git project.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { bin, gateProject } from "./mutations/__tests__/gate-project.mjs";
import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";

const leave = enterScratchProject();
after(leave);
const { HISTORY_MAX, appendHistory, historyEntry, seedHistory } = await import(
  "../ledger.mjs"
);
const { buildReceipt } = await import("../receipt.mjs");
const { renderSummary } = await import("../summary.mjs");
const { buildResults } = await import("../run.mjs");

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "verify-run-"));
  dirs.push(d);
  return d;
};
const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean);
const greenReceipt = (n = 1, extra = {}) => ({
  treeHash: `hash-${n}`,
  ranAt: `run-${n}`,
  ok: true,
  results: [
    { id: "a", status: "pass" },
    { id: "b", status: "human" },
  ],
  ...extra,
});
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

// A project whose one step always fails, so `verify` ends red without any real tooling.
const RED = `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [step({ id: 'a', when: true, cmd: 'node -e "console.log(1234); process.exit(1)"', reuse: false })],
});
`;
const redProject = () => {
  const p = gateProject({ config: RED, registry: null });
  p.put("src/new.txt", "x\n");
  return p;
};

test("VH-2 a non-green receipt appends nothing and creates no file", () => {
  const file = join(tmp(), "h.jsonl");
  const bad = [
    greenReceipt(1, { ok: false }),
    greenReceipt(1, { results: [{ id: "a", status: "fail" }] }),
    greenReceipt(1, { results: [{ id: "a", status: "skipped" }] }),
  ];
  for (const r of bad) assert.equal(appendHistory(file, r), false);
  assert.equal(existsSync(file), false);
  assert.equal(
    appendHistory(file, greenReceipt(1, { treeHash: undefined })),
    false,
  );
  assert.equal(historyEntry(greenReceipt(1, { ok: false })), null);
  assert.deepEqual(historyEntry(greenReceipt(2)), {
    treeHash: "hash-2",
    ranAt: "run-2",
  });
});

test("VH-3 an oversize green receipt appends nothing", () => {
  const file = join(tmp(), "h.jsonl");
  assert.equal(appendHistory(file, greenReceipt(1, { oversize: true })), false);
  assert.equal(existsSync(file), false);
  assert.equal(appendHistory(file, greenReceipt(1, { oversize: false })), true);
});

test("VH-4 the 51st append leaves the newest 50", () => {
  const file = join(tmp(), "h.jsonl");
  for (let i = 1; i <= HISTORY_MAX + 1; i++)
    appendHistory(file, greenReceipt(i));
  const out = lines(file).map((l) => JSON.parse(l));
  assert.equal(HISTORY_MAX, 50);
  assert.equal(out.length, HISTORY_MAX);
  assert.equal(out[0].ranAt, "run-2");
  assert.equal(out.at(-1).ranAt, `run-${HISTORY_MAX + 1}`);
});

test("VH-6 a receipt with a skipped result is not green for the history, appended or seeded", () => {
  const dir = tmp();
  const skipped = greenReceipt(1, {
    results: [{ id: "a", status: "skipped" }],
  });
  assert.equal(historyEntry(skipped), null);
  assert.equal(appendHistory(join(dir, "a.jsonl"), skipped), false);
  const receipt = join(dir, "receipt.json");
  const seeded = join(dir, "s.jsonl");
  writeFileSync(receipt, JSON.stringify(skipped));
  assert.equal(seedHistory(seeded, receipt), false);
  assert.equal(seedHistory(seeded, join(dir, "missing.json")), false);
  writeFileSync(receipt, "not json");
  assert.equal(seedHistory(seeded, receipt), false);
  assert.equal(existsSync(seeded), false);
  assert.equal(existsSync(join(dir, "a.jsonl")), false);
});

test("VH-7 a red run seeds the previous green receipt into the history and appends nothing", () => {
  const p = redProject();
  mkdirSync(join(p.dir, ".turbo"), { recursive: true });
  writeFileSync(
    join(p.dir, ".turbo", "ticket-verify.json"),
    JSON.stringify(greenReceipt(9)),
  );
  const r = bin(p.dir, ["verify"]);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(
    lines(join(p.dir, ".turbo", "ticket-verify-history.jsonl")).map((l) =>
      JSON.parse(l),
    ),
    [{ treeHash: "hash-9", ranAt: "run-9" }],
  );
});

test("VT-1 the receipt records oversize only for the oversize level", () => {
  const base = { treeHash: "t", ranAt: "now", ok: true, results: [] };
  const big = buildReceipt({
    ...base,
    size: { lines: 1501, level: "oversize", warn: 800, oversize: 1500 },
  });
  assert.equal(big.oversize, true);
  assert.deepEqual(big.size, { lines: 1501, level: "oversize" });
  const warn = buildReceipt({ ...base, size: { lines: 900, level: "warn" } });
  assert.equal(warn.oversize, false);
  assert.deepEqual(warn.size, { lines: 900, level: "warn" });
});

test("VT-F1 buildResults returns failures only for failed steps, with their output", () => {
  const plan = {
    steps: [
      { id: "a", cmd: "cmd-a", why: "why-a", mode: "run", summary: () => "ok" },
      { id: "b", cmd: "cmd-b", why: "why-b", mode: "run", summary: () => "ok" },
    ],
    notSelected: [],
  };
  const outs = { a: "all good", b: "boom: 1 failed" };
  const { ok, failures } = quiet(() =>
    buildResults(plan, (s) => ({
      status: s.id === "b" ? 1 : 0,
      out: outs[s.id],
    })),
  );
  assert.deepEqual(failures, [
    { id: "b", cmd: "cmd-b", why: "why-b", out: "boom: 1 failed" },
  ]);
  assert.equal(ok, false);
  const green = quiet(() =>
    buildResults({ steps: [plan.steps[0]], notSelected: [] }, () => ({
      status: 0,
      out: "fine",
    })),
  );
  assert.deepEqual(green.failures, []);
  assert.equal(green.ok, true);
});

test("VT-F2 the paste block names the failures file only when given the path", () => {
  const res = (cmd, summary, status = "pass") => ({ cmd, summary, status });
  const rs = [res("a", "ok"), res("b", "1 failed", "fail")];
  const notRun = [{ id: "db" }];
  const today = renderSummary(rs, notRun);
  assert.deepEqual(today, ["a: ok", "b: 1 failed  [FAIL]", "Not selected: db"]);
  assert.deepEqual(renderSummary(rs, notRun, {}), today);
  assert.deepEqual(renderSummary(rs, notRun, { failures: null }), today);
  assert.deepEqual(
    renderSummary(rs, notRun, { failures: ".turbo/ticket-verify-failures.md" }),
    [...today, "Failures: .turbo/ticket-verify-failures.md"],
  );
});

test("VT-F4 a red run writes the failures file and names it in the paste block", () => {
  const p = redProject();
  const r = bin(p.dir, ["verify"]);
  assert.equal(r.status, 1, r.out);
  const file = join(p.dir, ".turbo", "ticket-verify-failures.md");
  assert.ok(existsSync(file), r.out);
  assert.match(readFileSync(file, "utf8"), /^## a:/m);
  assert.match(r.out, /^Failures: \.turbo\/ticket-verify-failures\.md$/m);
});
