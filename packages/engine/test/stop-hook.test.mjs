// The Stop hook (`ticket-gate hook stop`) in a synthetic project: a DoD box ticked on the working
// tree, a receipt written by the project's own tree hash, an optional history file. Each case
// spawns the hook and reads its verdict (null = approve, else the block).
import assert from "node:assert/strict";
import { test } from "node:test";

import { PHASE, stopHookProject } from "./stop-hook-project.mjs";

const OVERSIZE = { oversize: true, size: { lines: 1600, level: "oversize" } };
const TWO = "## X-01 thing\n\n- [x] do it\n\n## X-02 other\n\n- [ ] more\n";
const waiver = (...lines) =>
  `# X-01\n\n## 1. Scope\n\n${lines.join("\n")}\n\n## 2. Surface\n`;
const fuId = (n) => `FU${n}`;
const fuFile = (n) =>
  `---\nid: ${fuId(n)}\nstatus: open\nowner: someone\n---\nthing.\n`;

test("GT-1 an oversize receipt with no waiver blocks and names the waiver line", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt(OVERSIZE);
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /oversize-accepted/);
  assert.match(out.reason, /1600/);
});

test("GT-M2 a move-only waiver with unmatched lines left blocks and names the move check", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({ ...OVERSIZE, moveProof: { unmatched: 1, base: "b" } });
  r.put("plans/contracts/X-01.md", waiver("- oversize-accepted: move-only"));
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /ticket-gate move-check/);
});

test("GT-M3 a move-only line among other waiver lines still binds", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({ ...OVERSIZE, moveProof: { unmatched: 1, base: "b" } });
  r.put(
    "plans/contracts/X-01.md",
    waiver("oversize-accepted: big", "- oversize-accepted: move-only (split)"),
  );
  assert.equal(r.gate()?.decision, "block");
});

test("GS-1 a tick committed on a tree in the history approves although the receipt is now stale", () => {
  const r = stopHookProject();
  r.history(r.commitWork());
  r.receipt();
  r.put("src/a.txt", "changed\n");
  assert.equal(r.gate(), null);
});

test("GS-3 a tick committed together with unverified code is not settled", () => {
  const r = stopHookProject();
  r.put("src/a.txt", "a\n");
  r.git("add", "src");
  r.git("commit", "-qm", "code");
  r.history(r.hashNow());
  r.receipt();
  r.put("src/b.txt", "b\n");
  r.git("add", "-A");
  r.git("commit", "-qm", "tick and more code");
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /stale/);
});

test("GS-6 the follow-up check sees only unsettled ticket ids", () => {
  const r = stopHookProject();
  r.put(
    "plans/contracts/X-01.md",
    `# X-01\n\n### 8.0 Closes\n\n- **${fuId(1)}** closes: thing\n`,
  );
  r.put(`plans/follow-ups/${fuId(1)}.md`, fuFile(1));
  r.history(r.commitWork(TWO));
  r.put(PHASE, TWO.replace("- [ ] more", "- [x] more"));
  r.receipt();
  assert.equal(r.gate(), null);
});

test("GS-7 the oversize check sees only unsettled ids and headless state", () => {
  const r = stopHookProject();
  r.history(r.commitWork(`- [x] headless\n\n${TWO}`));
  r.put(PHASE, `- [x] headless\n\n${TWO.replace("- [ ] more", "- [x] more")}`);
  r.put(
    "plans/contracts/X-02.md",
    "# X-02\n\n## 1. Scope\n\n- oversize-accepted: big\n",
  );
  r.receipt(OVERSIZE);
  assert.equal(r.gate(), null);
});

test("GS-8 a settled human tick still blocks", () => {
  const r = stopHookProject();
  r.history(r.commitWork("## X-01 thing\n\n- [x] do it (human)\n"));
  r.receipt();
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /human steps/);
});

test("GS-9 a corrupt history line does not fail settlement", () => {
  const r = stopHookProject();
  r.history("not json", r.commitWork());
  r.receipt();
  r.put("src/a.txt", "changed\n");
  assert.equal(r.gate(), null);
});

test("GS-10 a blame failure leaves the tick unsettled", () => {
  const r = stopHookProject();
  r.history(r.commitWork());
  r.receipt();
  r.put("plans/phase-8.md", "## X-03 other\n\n- [x] eight\n");
  r.put("src/a.txt", "changed\n");
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /^1 DoD checkbox\(es\)/);
  assert.match(out.reason, /phase-8\.md: eight/);
  assert.doesNotMatch(out.reason, /do it/);
});

const REUSE_MSG =
  /reused step coverage no longer matches its inputs \(an env file or a tool version changed\): re-run `ticket-gate verify`/;
const COVERAGE = "run coverage";

function reusedProject() {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.put(".env.local", "A=1\n");
  const base = r.git("rev-parse", "main").toString().trim();
  r.receipt({
    base,
    results: [
      { id: "check", cmd: "run check", status: "pass" },
      {
        id: "coverage",
        cmd: COVERAGE,
        status: "reused",
        summary: "reused from earlier",
        digest: r.digestOf("coverage", COVERAGE, base),
      },
    ],
  });
  return r;
}

test("GR-2 a gitignored env file changed after the run blocks with the reuse message", () => {
  const r = reusedProject();
  assert.equal(r.gate(), null); // control: untouched inputs approve
  r.put(".env.local", "A=2\n");
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, REUSE_MSG);
});

test("GR-3 an unknown result status blocks and names it", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({
    ok: true,
    results: [
      { id: "check", cmd: "run check", status: "pass" },
      { id: "e2e", cmd: "run e2e", status: "weird", summary: "s" },
    ],
  });
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /\[WEIRD\] run e2e/);
});
