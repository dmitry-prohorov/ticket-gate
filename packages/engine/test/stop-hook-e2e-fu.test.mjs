// The Stop hook (`ticket-gate hook stop`) in a synthetic project, two families of verdicts:
// the follow-up files a contract's section 8.0 names, and the partial (affected) e2e result in a
// receipt. Each case spawns the hook and reads its verdict (null = approve, else the block).
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { inProject, stopHookProject } from "./stop-hook-project.mjs";

// --- follow-up files ---

const fuId = (n) => `FU${n}`;
const fuFile = (id, status, extra = "") =>
  `---\nid: ${id}\nstatus: ${status}\n` +
  (status === "open" ? "owner: someone\n" : "fixed-in: X-01 (abc).\n") +
  `---\nthing.${extra}\n`;

// Ticks X-01's DoD with a contract whose section 8.0 holds `line` and the follow-up files in
// `files` ({ 'FU1.md': text }); returns the hook's verdict.
function fuGate(line, files) {
  const r = stopHookProject();
  r.put("plans/contracts/X-01.md", `# X-01\n\n### 8.0 Closes\n\n${line}\n`);
  for (const [name, text] of Object.entries(files))
    r.put(`plans/follow-ups/${name}`, text);
  r.receipt();
  return r.gate();
}

const FU1 = fuId(1);
const FU1_FILE = `${FU1}.md`;

test("FG-2 a closes item whose file is still open blocks and names the close command", () => {
  const out = fuGate(`- **${FU1}** closes: x`, {
    [FU1_FILE]: fuFile(FU1, "open"),
  });
  assert.equal(out?.decision, "block");
  assert.match(
    out.reason,
    new RegExp(`${FU1} closes, but its file says status: open`),
  );
  assert.match(out.reason, /ticket-gate fu close/);
  assert.match(out.reason, /plans\/follow-ups\//);
});

test("FG-3 a closes item with no follow-up file blocks", () => {
  const out = fuGate(`- **${FU1}** closes: x`, {});
  assert.equal(out?.decision, "block");
  assert.match(
    out.reason,
    new RegExp(`plans/follow-ups/${FU1}\\.md does not exist`),
  );
});

test("FG-5 a partial item without the note, or with a done file, blocks", () => {
  const noNote = fuGate(`- **${FU1}** PARTIAL: x`, {
    [FU1_FILE]: fuFile(FU1, "open"),
  });
  assert.equal(noNote?.decision, "block");
  assert.match(noNote.reason, /no "PARTIAL: X-01 \.\.\." note/);
  const done = fuGate(`- **${FU1}** PARTIAL: x`, {
    [FU1_FILE]: fuFile(FU1, "done", " PARTIAL: X-01 did part."),
  });
  assert.equal(done?.decision, "block");
  assert.match(done.reason, /status: done \(PARTIAL items stay open\)/);
  // control: an open file carrying the note approves
  assert.equal(
    fuGate(`- **${FU1}** PARTIAL: x`, {
      [FU1_FILE]: fuFile(FU1, "open", " PARTIAL: X-01 did part."),
    }),
    null,
  );
});

// --- partial (affected) e2e result ---

const HOUR = 3600 * 1000;
const NOW = Date.parse("2030-01-02T12:00:00Z");
const nightly = (over = {}) => ({
  status: "green",
  ranAt: new Date(NOW - 2 * HOUR).toISOString(),
  checkedAt: new Date(NOW).toISOString(),
  ...over,
});
const SPEC_A = "e2e/a.spec.ts";
const SPEC_B = "e2e/b.spec.ts";
const E2E_REUSE =
  /reused e2e spec e2e\/b\.spec\.ts no longer matches its inputs: re-run `ticket-gate verify`/;
const ENGINE = join(import.meta.dirname, "..");

function e2eProject() {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  const base = r.git("rev-parse", "main").toString().trim();
  const specDigest = (file, inputs) =>
    inProject(
      r.dir,
      `import { specDigest } from ${JSON.stringify(pathToFileURL(join(ENGINE, "digest.mjs")).href)}; console.log(specDigest(${JSON.stringify(file)}, ${JSON.stringify(inputs)}, { base: ${JSON.stringify(base)} }));`,
    );
  const specReused = (over = {}) => ({
    file: SPEC_B,
    status: "reused",
    inputs: ["src/new.txt"],
    digest: specDigest(SPEC_B, ["src/new.txt"]),
    ...over,
  });
  const e2e = (over = {}) => ({
    id: "e2e",
    cmd: "run e2e",
    status: "pass",
    summary: "s",
    mode: "affected",
    selected: [SPEC_A, SPEC_B],
    specs: [{ file: SPEC_A, status: "pass" }, specReused()],
    knownRed: [],
    nightly: nightly(),
    ...over,
  });
  const e2eReceipt = (over = {}) =>
    r.receipt({
      base,
      results: [{ id: "check", cmd: "run check", status: "pass" }, e2e(over)],
    });
  return { ...r, base, specReused, e2eReceipt };
}

test("GE-2 a reused spec whose digest no longer matches blocks", () => {
  const { put, specReused, e2eReceipt, gate } = e2eProject();
  put(".env.local", "A=1\n");
  // control: a digest recorded on today's inputs approves
  e2eReceipt({ specs: [{ file: SPEC_A, status: "pass" }, specReused()] });
  assert.equal(gate(), null);
  // an env file changed after the run
  put(".env.local", "A=2\n");
  let out = gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, E2E_REUSE);
  // a forged digest
  put(".env.local", "A=1\n");
  e2eReceipt({
    specs: [
      { file: SPEC_A, status: "pass" },
      specReused({ digest: "f".repeat(64) }),
    ],
  });
  out = gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, E2E_REUSE);
  // a reused spec carrying no digest, or no inputs
  for (const missing of ["digest", "inputs"]) {
    e2eReceipt({
      specs: [
        { file: SPEC_A, status: "pass" },
        specReused({ [missing]: undefined }),
      ],
    });
    out = gate();
    assert.equal(out?.decision, "block", `missing ${missing}`);
    assert.match(out.reason, E2E_REUSE);
  }
});

test("GE-3 a known-red spec inside the selection blocks; outside it approves, in full and affected", () => {
  const INSIDE =
    /knownRed spec e2e\/a\.spec\.ts is inside this branch's selection: it must run and pass/;
  for (const mode of ["full", "affected"]) {
    const { e2eReceipt, gate } = e2eProject();
    const base = {
      mode,
      selected: [SPEC_A],
      specs: [{ file: SPEC_A, status: "pass" }],
    };
    e2eReceipt({ ...base, knownRed: [SPEC_A] });
    const out = gate();
    assert.equal(out?.decision, "block", `${mode} inside`);
    assert.match(out.reason, INSIDE);
    e2eReceipt({ ...base, knownRed: [SPEC_B] });
    assert.equal(gate(), null, `${mode} outside`);
  }
});

test("GE-4 an e2e result with no mode is judged as a full run", () => {
  // a pass with no mode, specs or nightly approves
  const a = e2eProject();
  a.receipt({
    base: a.base,
    results: [
      { id: "check", cmd: "run check", status: "pass" },
      { id: "e2e", cmd: "run e2e", status: "pass", summary: "s" },
    ],
  });
  assert.equal(a.gate(), null);
  // a reused result without a digest blocks with the step reuse message
  const b = e2eProject();
  b.receipt({
    base: b.base,
    results: [
      { id: "check", cmd: "run check", status: "pass" },
      { id: "e2e", cmd: "run e2e", status: "reused", summary: "s" },
    ],
  });
  const out = b.gate();
  assert.equal(out?.decision, "block");
  assert.match(
    out.reason,
    /reused step e2e no longer matches its inputs \(an env file or a tool version changed\): re-run `ticket-gate verify`/,
  );
});

test("GE-5 an affected result with a red, error, missing or 37 h old nightly blocks", () => {
  const NIGHTLY_MSG =
    /e2e ran in affected mode without a fresh green or amber nightly: re-run `ticket-gate verify` \(it falls back to full\)/;
  const cases = {
    red: nightly({ status: "red" }),
    error: nightly({ status: "error" }),
    missing: null,
    "37 h old": nightly({ ranAt: new Date(NOW - 37 * HOUR).toISOString() }),
  };
  for (const [name, value] of Object.entries(cases)) {
    const { e2eReceipt, gate } = e2eProject();
    e2eReceipt({ nightly: value });
    const out = gate();
    assert.equal(out?.decision, "block", name);
    assert.match(out.reason, NIGHTLY_MSG, name);
  }
  // control: green and amber, fresh, approve
  for (const status of ["green", "amber"]) {
    const { e2eReceipt, gate } = e2eProject();
    e2eReceipt({ nightly: nightly({ status }) });
    assert.equal(gate(), null, status);
  }
});

test("GE-6 an affected result with a selected spec failed or absent from specs blocks", () => {
  const { specReused, e2eReceipt, gate } = e2eProject();
  const MSG = /affected e2e did not pass selected spec e2e\/a\.spec\.ts/;
  e2eReceipt({ specs: [{ file: SPEC_A, status: "fail" }, specReused()] });
  let out = gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, MSG);
  e2eReceipt({ specs: [specReused()] });
  out = gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, MSG);
});
