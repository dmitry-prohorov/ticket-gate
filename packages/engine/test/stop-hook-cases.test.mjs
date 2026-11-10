// Ported cases of the Stop hook (`ticket-gate hook stop`) and the push guard
// (`ticket-gate hook pre-tool-use`), each in a synthetic project. A case spawns the hook and reads
// its verdict: null is an approval, anything else is the parsed block (or the exit status, for the
// fail-closed cases). Each test is bitten by an `INFRA-81a/Mn` registry entry named in
// PORTED-CASES.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { BIN, gateProject } from "./mutations/__tests__/gate-project.mjs";
import { CONFIG_URL } from "./scratch-project.mjs";
import { CONFIG, OPEN, PHASE, stopHookProject } from "./stop-hook-project.mjs";

const ENV = { PATH: process.env.PATH, HOME: process.env.HOME };
const OVERSIZE = { oversize: true, size: { lines: 1600, level: "oversize" } };
const CONTRACT = "plans/contracts/X-01.md";
const waiver = (...lines) =>
  `# X-01\n\n## 1. Scope\n\n${lines.join("\n")}\n\n## 2. Surface\n`;
const TWO = "## X-01 thing\n\n- [x] do it\n\n## X-02 other\n\n- [ ] more\n";

/** The raw Stop hook run: { status, stdout, stderr }. */
const stop = (p, input = "{}") =>
  spawnSync(process.execPath, [BIN, "hook", "stop"], {
    cwd: p.dir,
    env: ENV,
    input,
    encoding: "utf8",
  });

// --- the receipt against the tree ---

test("P81 untracked then committed a receipt written with a file untracked still approves after the file is committed", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt();
  assert.equal(r.gate(), null);
  r.git("add", "src/new.txt");
  r.git("commit", "-qm", "add");
  assert.equal(r.gate(), null);
});

test("P81 ok false a receipt with ok false blocks although every result passed", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({ ok: false });
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /did not verify every required step/);
});

test("P81 skipped result a receipt with a skipped result blocks and names it as SKIPPED even when ok is true", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({
    ok: true,
    results: [
      { id: "check", cmd: "run check", status: "pass" },
      { id: "coverage", cmd: "run coverage", status: "skipped", summary: "s" },
    ],
  });
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /\[SKIPPED\] run coverage/);
});

// --- the oversize waiver ---

test("P81 GT-2 an oversize-accepted line in section 1 approves", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt(OVERSIZE);
  assert.equal(r.gate()?.decision, "block", "control: no waiver blocks");
  r.put(
    CONTRACT,
    waiver("- oversize-accepted: one migration plus generated types"),
  );
  assert.equal(r.gate(), null);
});

test("P81 GT-3 an oversize-accepted line outside section 1 does not count", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt(OVERSIZE);
  r.put(
    CONTRACT,
    "# X-01\n\n## 1. Scope\n\nfiles\n\n## 2. Surface\n\noversize-accepted: because\n",
  );
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /Ticket\(s\) without a waiver: X-01/);
});

test("P81 GT-5 a receipt without the oversize field approves", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt();
  assert.equal(r.gate(), null);
});

test("P81 GT-M1 a move-only waiver with 0 unmatched lines approves", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({ ...OVERSIZE, moveProof: { unmatched: 0, base: "b" } });
  r.put(CONTRACT, waiver("- oversize-accepted: move-only"));
  assert.equal(r.gate(), null);
});

test("P81 GT-M4 a receipt with no moveProof never satisfies a move-only waiver", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt(OVERSIZE);
  r.put(CONTRACT, waiver("- oversize-accepted: move-only"));
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /receipt has none/);
});

test("P81 GT-M5 a moveProof of null never satisfies a move-only waiver", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({ ...OVERSIZE, moveProof: null });
  r.put(CONTRACT, waiver("- oversize-accepted: move-only"));
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /receipt has none/);
});

test("P81 GT-M6 a waiver that is not move-only ignores the move proof", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({ ...OVERSIZE, moveProof: { unmatched: 5, base: "b" } });
  r.put(CONTRACT, waiver("- oversize-accepted: one migration"));
  assert.equal(r.gate(), null);
});

// --- settled ticks ---

const STALE =
  "1 DoD checkbox(es) were ticked on this branch:\n  plans/phase-9.md: do it\n\n" +
  "The verification receipt is stale: it was written at now, and the branch has changed since: " +
  "a changed, added, deleted or re-moded file outside plans. Committing or staging alone does not do this. " +
  "Whatever changed last was never verified.\n\nRe-run `ticket-gate verify` and update the summary lines in the PR body.";

test("P81 GS-2 with no history file the stale block keeps its exact text", () => {
  const r = stopHookProject();
  r.commitWork();
  r.receipt();
  r.put("src/a.txt", "changed\n");
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.equal(out.reason, STALE);
});

test("P81 GS-4 a tick left uncommitted is not settled by the history", () => {
  const r = stopHookProject();
  r.put("src/a.txt", "a\n");
  r.git("add", "src");
  r.git("commit", "-qm", "code");
  r.history(r.hashNow());
  r.receipt();
  r.put("src/a.txt", "changed\n");
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /stale/);
});

test("P81 GS-5 only the unsettled tick is counted and listed", () => {
  const r = stopHookProject();
  r.history(r.commitWork(TWO));
  r.receipt();
  r.put(PHASE, TWO.replace("- [ ] more", "- [x] more"));
  r.put("src/a.txt", "changed\n");
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /^1 DoD checkbox\(es\)/);
  assert.match(out.reason, /phase-9\.md: more/);
  assert.doesNotMatch(out.reason, /do it/);
});

test("P81 GS-11 a blocking gate run writes nothing under the repo", () => {
  const r = stopHookProject();
  r.commitWork(); // no history: the changed file makes the receipt stale, so the run blocks
  r.receipt();
  r.put("src/a.txt", "changed\n");
  const snap = () => {
    const out = {};
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === ".git") continue;
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else out[f] = `${statSync(f).mtimeMs}:${statSync(f).size}`;
      }
    };
    walk(r.dir);
    return out;
  };
  const before = snap();
  const out = r.gate();
  assert.equal(out?.decision, "block", "the run under test must block");
  assert.deepEqual(snap(), before);
});

// --- follow-up files ---

const fuFile = (id, status) =>
  `---\nid: ${id}\nstatus: ${status}\n` +
  (status === "open" ? "owner: someone\n" : "fixed-in: X-01 (abc).\n") +
  "---\nthing.\n";

// Ticks X-01's DoD with a contract whose section 8.0 holds `line` and the follow-up files in
// `files` ({ 'FU1.md': text }); returns the hook's verdict.
function fuGate(line, files) {
  const r = stopHookProject();
  r.put(CONTRACT, `# X-01\n\n### 8.0 Closes\n\n${line}\n`);
  for (const [name, text] of Object.entries(files))
    r.put(`plans/follow-ups/${name}`, text);
  r.receipt();
  return r.gate();
}

test("P81 FG-1 a closes item whose follow-up file is done approves", () => {
  assert.equal(
    fuGate("- **FU1** closes: x", { "FU1.md": fuFile("FU1", "done") }),
    null,
  );
});

test("P81 FG-6 an unparseable follow-up file blocks", () => {
  const out = fuGate("- **FU1** closes: x", { "FU1.md": "no front\n" });
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /its file does not parse/);
});

test("P81 FG-7 a suffixed id reads its hyphenated file", () => {
  assert.equal(
    fuGate("- **FU26 (X-01)** closes: x", {
      "FU26-X-01.md": fuFile("FU26 (X-01)", "done"),
    }),
    null,
  );
});

// --- reused results ---

const COVERAGE = "run coverage";
const REUSE_MSG =
  /reused step coverage no longer matches its inputs \(an env file or a tool version changed\): re-run `ticket-gate verify`/;

test("P81 GR-4 a receipt without digests or base approves", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({
    results: [
      { id: "check", cmd: "run check", status: "pass" },
      { id: "coverage", cmd: COVERAGE, status: "pass", summary: "s" },
      { id: "device", cmd: "run device", status: "human" },
    ],
  });
  assert.equal(r.gate(), null);
});

test("P81 GR-5 a reused result without a digest, or a receipt without a base, blocks with the reuse message", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.put(".env.local", "A=1\n");
  const base = r.git("rev-parse", "main").toString().trim();
  const reused = (over = {}) => ({
    id: "coverage",
    cmd: COVERAGE,
    status: "reused",
    summary: "reused from earlier",
    digest: r.digestOf("coverage", COVERAGE, base),
    ...over,
  });
  const results = (over) => [
    { id: "check", cmd: "run check", status: "pass" },
    reused(over),
  ];
  r.receipt({ base, results: results() });
  assert.equal(r.gate(), null, "control: a full receipt approves");
  r.receipt({ base, results: results({ digest: undefined }) });
  let out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, REUSE_MSG);
  r.receipt({ base: undefined, results: results() });
  out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, REUSE_MSG);
});

test("P81 GR-6 a gate run that approves a reused receipt writes nothing in the repo", () => {
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
  const snap = () => {
    const out = {};
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === ".git") continue;
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else out[f] = `${statSync(f).mtimeMs}:${statSync(f).size}`;
      }
    };
    walk(r.dir);
    return out;
  };
  const before = snap();
  assert.equal(r.gate(), null, "control: the receipt approves");
  assert.deepEqual(snap(), before);
});

test("P81 GE-7 a result carrying an unknown mode blocks and names the step and the mode", () => {
  const r = stopHookProject();
  r.put("src/new.txt", "hello\n");
  r.receipt({
    results: [
      { id: "check", cmd: "run check", status: "pass" },
      {
        id: "suite",
        cmd: "run suite",
        status: "pass",
        summary: "s",
        mode: "fast",
      },
    ],
  });
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(
    out.reason,
    /unknown suite mode fast: re-run `ticket-gate verify`/,
  );
});

// --- fail closed ---

const THROWS = 'throw new Error("boom");\n';
const EMPTY = "export default {};\n";

test("P81 TG-FC-4 stop_hook_active approves even with a broken config", () => {
  const p = stopHookProject();
  p.put("gate.config.mjs", THROWS);
  const control = stop(p);
  assert.equal(control.status, 2, "control: without the flag it fails closed");
  const r = stop(p, '{"stop_hook_active": true}');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("P81 TG-FC-5 a config that fails validation and a newly ticked box exits 2", () => {
  const p = stopHookProject();
  p.put("gate.config.mjs", EMPTY);
  const r = stop(p);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /gate\.config\.mjs/);
  assert.equal(r.stdout, "");
});

test("P81 TG-FC-6 a tick in an untracked nested phase file is still read", () => {
  const config = CONFIG.replace("plans/phase-*.md", "plans/**/phase-*.md");
  assert.notEqual(config, CONFIG, "the fixture replace must hit");
  const p = stopHookProject({ config });
  p.put(PHASE, OPEN); // the committed state: no tick in the project's own phase file
  assert.equal(p.gate(), null, "control: no tick approves");
  p.put("plans/archive/phase-7.md", "## X-02 nested\n\n- [x] done\n");
  const out = p.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /plans\/archive\/phase-7\.md/);
});

// --- the push guard ---

const guardConfig = (names) =>
  `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};\n` +
  "export default defineGate({ steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })], " +
  "dod: { files: ['plans/*.md'], contract: 'plans/{id}.md' }, " +
  `pushGuard: { protected: ${JSON.stringify(names)} } });\n`;

function pushVerdict(config, command) {
  const p = gateProject({ registry: null, config });
  return spawnSync(process.execPath, [BIN, "hook", "pre-tool-use"], {
    cwd: p.dir,
    env: ENV,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
}

test("P81 BG-FC-2 b a config with protected: [] denies a push", () => {
  const push = "git push origin feat";
  const ok = pushVerdict(guardConfig(["trunk"]), push);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "", "control: a valid guard allows a feature push");
  const r = pushVerdict(guardConfig([]), push);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"permissionDecision":"deny"/);
  assert.match(r.stdout, /gate\.config\.mjs is unusable/);
  assert.match(r.stdout, /pushGuard\.protected/);
});
