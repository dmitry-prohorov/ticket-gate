// Ported cases of the verify run: planning, summary, receipt, history, ledger, the stack steps
// and the gate config validation. Each test keeps the id of the case it was ported from and runs
// against a synthetic project (scratch-project.mjs for the in-process cases, a throwaway git
// project for the spawned ones). Nothing here names a consumer.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { bin, gateProject } from "./mutations/__tests__/gate-project.mjs";
import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";
import { stopHookProject } from "./stop-hook-project.mjs";

const ENGINE = join(import.meta.dirname, "..");

// One stack `st`; `seed` is planned only when a step that needs a fresh seed runs. A stack step's
// failure names `echo <id>`. The precheck is a function of the ticket ids the gate resolves.
const SCRATCH = `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
const plain = (id, when, cmd = 'true') => step({ id, when, cmd, reuse: false });
const onStack = (id, when, extra = {}) =>
  step({ id, when, cmd: 'true', reuse: false, stack: 'st', ...extra });
export default defineGate({
  steps: [
    plain('deps', true),
    plain('preflight', false),
    plain('check', true),
    plain('env', true),
    onStack('integration', ['web/**']),
    onStack('seed', false),
    onStack('e2e', ['web/**']),
  ],
  stacks: {
    st: {
      reset: { step: 'seed', before: ['e2e'], satisfiedBy: [] },
      health: { step: 'preflight', preflight: (ids) => 'echo up ' + ids.join(',') },
    },
  },
  stopOnRedBefore: 'seed',
  stackHint: (id) => 'echo ' + id,
  mutations: {},
  precheck: [
    (ctx) =>
      ctx.ids.flatMap((id) =>
        ['--dry-run', '--typecheck'].map((f) => ({
          id: id + ' ' + f,
          cmd: 'probe ' + id + ' ' + f,
          fix: 'fix ' + id,
        })),
      ),
  ],
});
`;

const leave = enterScratchProject(SCRATCH);
after(leave);
const { allTasksLines, defineGate, loadGateConfig, pick, step } = await import(
  "../config.mjs"
);
const { planFor, planSteps } = await import("../plan.mjs");
const { parseTimeouts } = await import("../cli.mjs");
const { runPrecheck } = await import("../precheck.mjs");
const { buildResults, runInShell } = await import("../run.mjs");
const { buildReceipt } = await import("../receipt.mjs");
const { renderSummary, formatMs } = await import("../summary.mjs");
const {
  appendHistory,
  appendLedger,
  ledgerLines,
  newestLedgerLine,
  readLedger,
  seedHistory,
} = await import("../ledger.mjs");
const { bindSetup } = await import("../mutations/project.mjs");
const { resolveSetup } = await import("../mutations/kinds.mjs");
const { registryDryLine, registryPlan } = await import(
  "../mutations/gate.mjs"
);

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
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
const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean);
const passing = () => ({ status: 0, out: "3 passed\n" });
const res = (cmd, summary, status = "pass") => ({ cmd, summary, status });
const greenReceipt = (n = 1, extra = {}) => ({
  treeHash: `hash-${n}`,
  ranAt: `run-${n}`,
  ok: true,
  results: [{ id: "a", status: "pass" }],
  ...extra,
});
const digestOf = (id, cmd) => `d:${id}:${cmd}`;
const passLine = (id, cmd, ranAt, over = {}) => ({
  id,
  cmd,
  digest: digestOf(id, cmd),
  status: "pass",
  ranAt,
  summary: "All files 100",
  ms: 5,
  ...over,
});
// A runner that fails exactly the steps named in `red` and records every step it ran.
const redOn = (red) => {
  const ran = [];
  const fn = (s) => {
    ran.push(s.id);
    return { status: red.includes(s.id) ? 1 : 0, out: "error: red\n" };
  };
  fn.ran = ran;
  return fn;
};
const runStep = (id, extra = {}) => ({
  id,
  cmd: `cmd-${id}`,
  why: `why-${id}`,
  mode: "run",
  summary: () => "ok",
  ...extra,
});

// A planner config with one stack: `seed` resets for `e2e` unless `db` runs the reset.
const stackGate = ({ reuse = false } = {}) => {
  const s = (id, when, extra = {}) =>
    step({ id, when, cmd: `run ${id}`, reuse, stack: "st", ...extra });
  return defineGate({
    steps: [
      step({ id: "preflight", when: false, cmd: "up", reuse: false }),
      s("db", ["db/**"], { cmd: "reset" }),
      s("seed", false, { cmd: "reset" }),
      s("integration", ["db/**"]),
      s("e2e", ["web/**"]),
      step({
        id: "mr",
        when: false,
        cmd: "run mr",
        reuse: false,
        stack: "st",
        option: "registry",
      }),
    ],
    stacks: {
      st: {
        reset: {
          step: "seed",
          before: ["e2e", "mr"],
          satisfiedBy: ["db"],
          note: {
            steps: ["e2e"],
            text: (by) => `seed: fresh (reset in ${by} step)`,
          },
        },
        health: {
          step: "preflight",
          preflight: (ids) => `up ${ids.join(",")}`,
          ready: (ids) => `wait ${ids.join(",")}`,
        },
      },
    },
  });
};
const plan = (config, paths, opts = {}) =>
  planFor(config, paths, { exists: () => true, base: "HEAD", ...opts });

// A project for the spawned cases: `a` always runs, `web` only for a web/ path; a web/ file is
// MACHINE in the review map.
const spawnConfig = (aCmd = "echo ok-a") => `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [
    step({ id: 'a', when: true, cmd: ${JSON.stringify(aCmd)}, reuse: { deny: [] } }),
    step({ id: 'web', when: ['web/**'], cmd: 'echo ok-web', reuse: false }),
  ],
  reviewMap: {
    rules: [{ id: 'M1', tier: 'MACHINE', reason: 'web files', match: (f) => f.path.startsWith('web/') }],
    sizeExcluded: [],
  },
});
`;
const spawnProject = (aCmd) => {
  const p = gateProject({ config: spawnConfig(aCmd), registry: null });
  return p;
};

test("P81 VT-P3d b a stack reset note appends its text naming the step that did the reset", () => {
  const config = stackGate();
  const alone = byId(plan(config, ["web/x"]).steps, "e2e");
  assert.match(
    alone.summary("3 passed"),
    /3 passed; seed: fresh \(reset in seed step\)$/,
  );
  const withDb = byId(plan(config, ["db/m.sql", "web/x"]).steps, "e2e");
  assert.match(
    withDb.summary("3 passed"),
    /3 passed; seed: fresh \(reset in db step\)$/,
  );
  // a step the note does not list keeps its own summary
  const db = byId(plan(config, ["db/m.sql", "web/x"]).steps, "db");
  assert.equal(db.summary("3 passed"), "3 passed");
});

test("P81 --skip human step a skipped human step keeps mode human", () => {
  const config = defineGate({
    steps: [
      step({ id: "check", when: true, cmd: "run check", reuse: false }),
      step({ id: "manual", when: true, cmd: "do it by hand", human: "by hand" }),
    ],
  });
  const got = plan(config, ["src/x"], { skip: ["manual"] });
  assert.equal(byId(got.steps, "manual").mode, "human");
  assert.deepEqual(got.notSelected, []);
  const { results, ok } = quiet(() => buildResults(got, passing));
  assert.equal(byId(results, "manual").status, "human");
  assert.equal(ok, true);
});

test("P81 unknown --skip an unknown skip id exits 2 naming the ids, writes no receipt and starts no step", () => {
  const p = spawnProject();
  p.put("src/new.txt", "x\n");
  const r = bin(p.dir, ["verify", "--skip=e22"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /unknown --skip id\(s\): e22/);
  assert.match(r.out, /Valid ids: a, web/);
  assert.equal(existsSync(join(p.dir, ".turbo", "ticket-verify.json")), false);
  assert.doesNotMatch(r.out, /===/);
});

test("P81 dry-run NOT SELECTED a dry run prints NOT SELECTED for a skip the diff does not select", () => {
  const p = spawnProject();
  p.put("src/new.txt", "x\n");
  const r = bin(p.dir, ["verify", "--dry-run", "--skip=web"]);
  assert.equal(r.status, 0, r.out);
  assert.match(
    r.out,
    /NOT SELECTED --skip=web \(the diff does not select it\)/,
  );
  // control: a skip of a selected step is not reported as unselected
  const sel = bin(p.dir, ["verify", "--dry-run", "--skip=a"]);
  assert.doesNotMatch(sel.out, /NOT SELECTED/);
  assert.match(sel.out, /^\s*SKIP\s+echo ok-a/m);
});

test("P81 VT-2 a dry run prints the review map and the size and writes the map JSON", () => {
  const p = spawnProject();
  p.put("web/x", "x\n");
  const r = bin(p.dir, ["verify", "--dry-run"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^Human review: \d+ files, \d+ lines\./m);
  assert.match(r.out, /^Size: \d+ changed lines/m);
  const map = JSON.parse(
    readFileSync(join(p.dir, ".turbo", "review-map.json"), "utf8"),
  );
  assert.equal(map.files[0].path, "web/x");
  assert.equal(map.files[0].tier, "MACHINE");
});

test("P81 VT-S1 six unselected steps print one Not selected line after the run lines", () => {
  const ids = "db, perf, coverage, bundle, types, mutation".split(", ");
  const got = renderSummary(
    [res("a", "1 ok"), res("b", "2 ok"), res("c", "3 ok")],
    ids.map((id) => ({ id, cmd: `cmd-${id}`, notRun: "x" })),
  );
  assert.deepEqual(got, [
    "a: 1 ok",
    "b: 2 ok",
    "c: 3 ok",
    "Not selected: db, perf, coverage, bundle, types, mutation",
  ]);
  assert.ok(!got.some((l) => l.includes("not run:")));
});

test("P81 VT-S2 human, skipped and failed steps each keep their own marker line", () => {
  assert.deepEqual(
    renderSummary(
      [
        res("manual", "human step: not run by the gate", "human"),
        res("perf", "skipped by --skip", "skipped"),
        res("check", "1 failed", "fail"),
      ],
      [],
    ),
    [
      "manual: human step: not run by the gate  [HUMAN]",
      "perf: skipped by --skip  [SKIPPED]",
      "check: 1 failed  [FAIL]",
    ],
  );
});

test("P81 VT-S3 summary no unselected steps prints no Not selected line", () => {
  assert.deepEqual(renderSummary([res("a", "ok")], []), ["a: ok"]);
});

test("P81 VT-S4 a dry run lists the MACHINE paths only with --review-map=full", () => {
  const p = spawnProject();
  p.put("web/x", "x\n");
  const json = () =>
    JSON.parse(readFileSync(join(p.dir, ".turbo", "review-map.json"), "utf8"));
  const plain = bin(p.dir, ["verify", "--dry-run"]);
  assert.equal(plain.status, 0, plain.out);
  assert.ok(!plain.out.includes("web/x"));
  assert.match(plain.out, /^Machine: 1 files, 1 lines \(full list: /m);
  assert.ok(json().files.some((x) => x.path === "web/x"));
  const full = bin(p.dir, ["verify", "--dry-run", "--review-map=full"]);
  assert.equal(full.status, 0, full.out);
  assert.ok(full.out.includes("web/x"));
  assert.ok(json().files.some((x) => x.path === "web/x"));
});

test("P81 VT-S5 an unknown --review-map value exits 2 and writes no receipt", () => {
  const p = spawnProject();
  p.put("web/x", "x\n");
  const r = bin(p.dir, ["verify", "--review-map=all"]);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /--review-map/);
  assert.equal(existsSync(join(p.dir, ".turbo", "ticket-verify.json")), false);
});

test("P81 VT-F1 b a result has exactly the keys id, cmd, status, summary and ms; a skip row has no ms", () => {
  const got = quiet(() =>
    buildResults(
      {
        steps: [runStep("a"), runStep("b"), runStep("c", { mode: "skip" })],
        notSelected: [],
      },
      passing,
    ),
  );
  for (const r of got.results.filter((x) => x.status !== "skipped")) {
    assert.deepEqual(Object.keys(r), ["id", "cmd", "status", "summary", "ms"]);
    assert.ok(Number.isInteger(r.ms) && r.ms >= 0, String(r.ms));
  }
  assert.deepEqual(Object.keys(got.results[2]), [
    "id",
    "cmd",
    "status",
    "summary",
  ]);
});

test("P81 VT-F3 buildReceipt has exactly the receipt keys in order and trims the size block", () => {
  const r = buildReceipt({
    treeHash: "h",
    ranAt: "t",
    ok: false,
    results: [],
    size: { lines: 3, level: "ok", extra: 1 },
    base: "b",
  });
  assert.deepEqual(Object.keys(r), [
    "treeHash",
    "ranAt",
    "base",
    "ok",
    "results",
    "size",
    "oversize",
    "shadow",
    "moveProof",
  ]);
  assert.deepEqual(r.size, { lines: 3, level: "ok" });
});

test("P81 VH-5 seedHistory seeds a missing history once from a green receipt, a second call writes nothing", () => {
  const d = tmp("p81-vh5-");
  const receipt = join(d, "receipt.json");
  const file = join(d, "h.jsonl");
  writeFileSync(receipt, JSON.stringify(greenReceipt(3)));
  assert.equal(seedHistory(file, receipt), true);
  assert.deepEqual(
    lines(file).map((l) => JSON.parse(l)),
    [{ treeHash: "hash-3", ranAt: "run-3" }],
  );
  writeFileSync(receipt, JSON.stringify(greenReceipt(4)));
  assert.equal(seedHistory(file, receipt), false);
  assert.deepEqual(
    lines(file).map((l) => JSON.parse(l).treeHash),
    ["hash-3"],
  );
});

test("P81 VH-8 appendHistory keeps the valid lines past a corrupt one and appends", () => {
  const file = join(tmp("p81-vh8-"), "h.jsonl");
  writeFileSync(
    file,
    `${JSON.stringify({ treeHash: "a", ranAt: "1" })}\nnot json\n`,
  );
  assert.equal(appendHistory(file, greenReceipt(2)), true);
  assert.deepEqual(
    lines(file).map((l) => JSON.parse(l).treeHash),
    ["a", "hash-2"],
  );
});

test("P81 runInShell noise a step returns its status and its stdout and stderr, no job-control line", () => {
  const logDir = tmp("p81-noise-");
  const r = runInShell(
    { id: "n", cmd: "echo out; echo err >&2; exit 3" },
    { logDir },
  );
  assert.equal(r.status, 3);
  assert.match(r.out, /out/);
  assert.match(r.out, /err/);
  assert.doesNotMatch(r.out, /Exit 3/);
});

test("P81 gate killed by signal a gate killed by SIGTERM takes its running step with it", async () => {
  const p = gateProject({ registry: null });
  const logDir = tmp("p81-orphan-");
  const pidFile = join(logDir, "pid");
  const runUrl = pathToFileURL(join(ENGINE, "run.mjs")).href;
  const gate = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(runUrl)});
       m.runInShell({ id: 'o', cmd: 'sleep 120 & echo $! > ${pidFile}; wait' }, { logDir: ${JSON.stringify(logDir)} });`,
    ],
    { cwd: p.dir, stdio: "ignore" },
  );
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && !existsSync(pidFile); i++) await wait(100);
  const stepPid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(stepPid > 1, "the step never started");
  try {
    assert.ok(alive(stepPid), "the step started");
    gate.kill("SIGTERM");
    for (let i = 0; i < 80 && alive(stepPid); i++) await wait(100);
    assert.equal(alive(stepPid), false, "the step outlived the gate");
  } finally {
    if (alive(stepPid)) process.kill(stepPid, "SIGKILL");
  }
});

// ---- reuse and the step ledger ----

const reuseGate = () =>
  defineGate({
    steps: [
      step({ id: "check", when: true, cmd: "run check", reuse: false }),
      step({ id: "coverage", when: true, cmd: "run coverage", reuse: { deny: [] } }),
      step({ id: "perf", when: true, cmd: "run perf", reuse: { deny: [] } }),
      step({ id: "manual", when: true, cmd: "do it by hand", human: "by hand" }),
    ],
  });
const COVERAGE = "run coverage";
const planWith = (ledger, skip = []) =>
  plan(reuseGate(), ["src/x.ts"], { digestOf, ledger, skip });

test("P81 VR-1 a green line on the same digest gives a reused result and the step is never run", () => {
  const got = planWith([passLine("coverage", COVERAGE, "T1")]);
  assert.equal(byId(got.steps, "coverage").mode, "reuse");
  const ran = [];
  const { results, ok } = quiet(() =>
    buildResults(got, (s) => {
      ran.push(s.id);
      return passing();
    }),
  );
  assert.equal(ran.includes("coverage"), false);
  assert.ok(ran.includes("check"));
  const r = byId(results, "coverage");
  assert.deepEqual(r, {
    id: "coverage",
    cmd: COVERAGE,
    status: "reused",
    summary: "All files 100 (reused from T1)",
    digest: digestOf("coverage", COVERAGE),
    reusedFrom: "T1",
  });
  assert.equal("ms" in r, false);
  assert.equal(ok, true);
  assert.match(
    renderSummary([r], []).join("\n"),
    /\(reused from T1\)  \[REUSED\]$/,
  );
});

test("P81 VR-4 b every stack step reused plans no reset and no preflight", () => {
  const config = stackGate({ reuse: { deny: [] } });
  const ledger = [passLine("e2e", "run e2e", "T1")];
  const ids = (p) => p.steps.map((s) => s.id);
  const reused = plan(config, ["web/x"], { digestOf, ledger });
  assert.equal(byId(reused.steps, "e2e").mode, "reuse");
  assert.deepEqual(ids(reused), ["e2e"]);
  // control: with nothing to reuse the same diff plans the preflight and the reset
  const fresh = plan(config, ["web/x"], { digestOf, ledger: [] });
  assert.deepEqual(ids(fresh), ["preflight", "seed", "e2e"]);
});

test("P81 VR-6 --skip beats a green ledger line: the step is skipped and the receipt is not ok", () => {
  const got = planWith([passLine("coverage", COVERAGE, "T1")], ["coverage"]);
  assert.equal(byId(got.steps, "coverage").mode, "skip");
  const { results, ok } = quiet(() => buildResults(got, passing));
  assert.equal(byId(results, "coverage").status, "skipped");
  assert.equal(ok, false);
});

test("P81 VR-8 a dry run prints REUSE with the reused-from time for a step green on the same inputs", () => {
  const p = spawnProject();
  p.put("src/new.txt", "x\n");
  const first = bin(p.dir, ["verify"]);
  assert.equal(first.status, 0, first.out);
  const ledger = readLedger(join(p.dir, ".turbo", "ticket-verify-steps.jsonl"));
  const line = ledger.find((l) => l.id === "a");
  assert.equal(line?.status, "pass", first.out);
  const dry = bin(p.dir, ["verify", "--dry-run"]);
  assert.equal(dry.status, 0, dry.out);
  const row = dry.out.split("\n").find((l) => l.includes("echo ok-a"));
  assert.match(row, /^ {2}REUSE {2}echo ok-a/, dry.out);
  assert.ok(row.includes(`(reused from ${line.ranAt})`), row);
  // control: --fresh runs it again
  const fresh = bin(p.dir, ["verify", "--dry-run", "--fresh"]);
  assert.match(fresh.out, /^\s*RUN\s+echo ok-a/m);
});

test("P81 VR-9 every non-human result carries its digest, a human result carries none", () => {
  const got = planWith([passLine("coverage", COVERAGE, "T1")], ["perf"]);
  const { results } = quiet(() => buildResults(got, passing));
  const statuses = new Set(results.map((r) => r.status));
  for (const s of ["pass", "skipped", "reused", "human"])
    assert.ok(statuses.has(s), s);
  for (const r of results) {
    if (r.status === "human") assert.equal("digest" in r, false, r.id);
    else assert.equal(r.digest, digestOf(r.id, r.cmd), r.id);
  }
});

test("P81 VL-2 a corrupt ledger line is skipped, the newest valid line rules and an append keeps the valid ones", () => {
  const file = join(tmp("p81-vl2-"), "steps.jsonl");
  const ok = passLine("coverage", COVERAGE, "T1");
  writeFileSync(
    file,
    [
      JSON.stringify(ok),
      "not json",
      "",
      "[1]",
      "7",
      JSON.stringify({ ...ok, status: "fail", ranAt: "T2" }),
      "{broken",
    ].join("\n"),
  );
  const got = readLedger(file);
  assert.equal(got.length, 2);
  const key = { id: "coverage", cmd: COVERAGE, digest: ok.digest };
  assert.equal(newestLedgerLine(got, key).ranAt, "T2");
  assert.deepEqual(readLedger(join(tmp("p81-vl2b-"), "missing.jsonl")), []);
  appendLedger(file, [ok]);
  assert.equal(readLedger(file).length, 3);
});

test("P81 VL-3 b a ledger line has exactly id, cmd, digest, status, ranAt, summary and ms; a TIMEOUT fail is recorded", () => {
  const r = (status, over = {}) => ({
    id: "coverage",
    cmd: "c",
    status,
    digest: "D",
    summary: "s",
    ms: 7,
    ...over,
  });
  const results = [
    r("pass"),
    r("fail", { summary: "TIMEOUT after 600 s (limit coverage: 600 s)" }),
    r("skipped"),
    r("human"),
    r("reused"),
  ];
  const got = ledgerLines(results, { ranAt: "T", digestNow: () => "D" });
  assert.deepEqual(
    got.map((l) => l.status),
    ["pass", "fail"],
  );
  assert.match(got[1].summary, /^TIMEOUT/);
  assert.deepEqual(Object.keys(got[0]), [
    "id",
    "cmd",
    "digest",
    "status",
    "ranAt",
    "summary",
    "ms",
  ]);
  assert.equal(got[0].ranAt, "T");
});

test("P81 VL-6 a red verify appends a fail line to the ledger and writes nothing outside .turbo", () => {
  const p = spawnProject("echo broken >&2; exit 1");
  p.put("src/new.txt", "x\n");
  const r = bin(p.dir, ["verify"]);
  assert.equal(r.status, 1, r.out);
  const got = readLedger(join(p.dir, ".turbo", "ticket-verify-steps.jsonl"));
  const line = got.find((l) => l.id === "a");
  assert.equal(line?.status, "fail", r.out);
  assert.match(line.digest, /^[0-9a-f]{64}$/);
  const status = execFileSync("git", ["status", "--porcelain", "-uall"], {
    cwd: p.dir,
    encoding: "utf8",
  });
  assert.equal(status, "?? src/new.txt\n");
});

// ---- the stack steps ----

test("P81 VT-R1 b a stack step gets ready for the stack steps that run after it, none when none follow", () => {
  const config = stackGate();
  const both = plan(config, ["db/m.sql", "web/x"]);
  assert.equal(byId(both.steps, "db").ready, "wait integration,e2e");
  assert.equal(byId(plan(config, ["web/x"]).steps, "seed").ready, "wait e2e");
  // a skipped step is not waited for; with nothing after db there is no ready command
  const nothing = plan(config, ["db/m.sql"], { skip: ["integration"] });
  assert.equal(byId(nothing.steps, "db").ready, undefined);
});

test("P81 VT-T1b a stack step that times out names the stack check in its failure entry", () => {
  const timedOut = () => ({ status: 124, out: "", timedOut: true });
  const stack = quiet(() =>
    buildResults(
      { steps: [runStep("e2e")], notSelected: [] },
      timedOut,
      { limits: { e2e: 7 } },
    ),
  );
  assert.match(stack.failures[0].out, /TIMEOUT after 7 s \(limit e2e: 7 s\)/);
  assert.match(stack.failures[0].out, /Check the stack with: echo e2e/);
  // control: a step off the stack is told to rerun itself
  const plainStep = quiet(() =>
    buildResults(
      { steps: [runStep("check")], notSelected: [] },
      timedOut,
      { limits: { check: 7 } },
    ),
  );
  assert.match(plainStep.failures[0].out, /Rerun this step alone: cmd-check/);
  assert.doesNotMatch(plainStep.failures[0].out, /Check the stack with/);
});

test("P81 VT-T5 a step that ends before its limit leaves no orphan timer", () => {
  const logDir = tmp("p81-t5-");
  // a limit no other run shares, so the pgrep below sees only this step's timer
  const limitS = 40000 + (process.pid % 20000);
  const r = runInShell(
    { id: "x", cmd: "true" },
    { limitS, logDir: join(logDir, "logs") },
  );
  assert.equal(r.status, 0);
  let found = "";
  for (let i = 0; i < 10; i += 1) {
    found = spawnSync("pgrep", ["-f", `sleep ${limitS}`], {
      encoding: "utf8",
    }).stdout.trim();
    if (found === "") break;
    spawnSync("sleep", ["0.1"]);
  }
  assert.equal(found, "", `orphan sleep pids: ${found}`);
});

test("P81 VT-T3 b only a step whose limit was overridden carries limitS in its result", () => {
  const t = parseTimeouts(["--timeout=e2e:5", "--skip=x"]);
  assert.equal(t.error, null);
  assert.equal(t.limits.e2e, 5);
  assert.deepEqual([...t.overridden], ["e2e"]);
  assert.equal(parseTimeouts([]).overridden.size, 0);
  const { results } = quiet(() =>
    buildResults(
      { steps: [runStep("e2e"), runStep("check")], notSelected: [] },
      passing,
      t,
    ),
  );
  assert.equal(results[0].limitS, 5);
  assert.equal("limitS" in results[1], false);
});

test("P81 VT-L1 runInShell logs under the given dir, returns the same text and marks the output streamed; append keeps the log", () => {
  const logDir = tmp("p81-log-");
  const r = runInShell(
    { id: "x", cmd: "echo hello; echo err >&2" },
    { logDir },
  );
  const log = readFileSync(join(logDir, "x.log"), "utf8");
  assert.match(log, /hello/);
  assert.match(log, /err/);
  assert.match(r.out, /hello/);
  assert.match(r.out, /err/);
  assert.equal(r.streamed, true);
  assert.equal(r.status, 0);
  const again = runInShell(
    { id: "x", cmd: "echo second", append: true },
    { logDir },
  );
  assert.match(again.out, /second/);
  assert.doesNotMatch(again.out, /hello/);
  assert.match(
    readFileSync(join(logDir, "x.log"), "utf8"),
    /hello[\s\S]*second/,
  );
});

test("P81 VT-L2 streamed output is not written a second time by buildResults", () => {
  const wrote = [];
  const w = process.stdout.write;
  const log = console.log;
  process.stdout.write = (c) => (wrote.push(String(c)), true);
  console.log = () => {};
  try {
    buildResults({ steps: [runStep("a")], notSelected: [] }, () => ({
      status: 0,
      out: "ONCE\n",
      streamed: true,
    }));
    buildResults({ steps: [runStep("a")], notSelected: [] }, () => ({
      status: 0,
      out: "TWICE\n",
    }));
  } finally {
    process.stdout.write = w;
    console.log = log;
  }
  assert.ok(!wrote.some((c) => c.includes("ONCE")));
  assert.ok(wrote.some((c) => c.includes("TWICE")));
});

test("P81 VT-D1 renderSummary appends the duration before the status marker, and none without ms", () => {
  assert.equal(formatMs(65000), "(1m05s)");
  assert.equal(formatMs(4400), "(0m04s)");
  assert.equal(formatMs(59600), "(1m00s)");
  assert.deepEqual(
    renderSummary(
      [
        { ...res("a", "ok"), ms: 65000 },
        { ...res("b", "bad", "fail"), ms: 3000 },
      ],
      [],
    ),
    ["a: ok (1m05s)", "b: bad (0m03s)  [FAIL]"],
  );
  assert.deepEqual(renderSummary([res("a", "ok")], []), ["a: ok"]);
});

test("P81 V-1f a stopped stack keeps its reused and skipped steps", () => {
  const got = planSteps(["web/x"], []);
  const steps = got.steps.map((s) => {
    if (s.id === "e2e")
      return { ...s, mode: "reuse", reusedFrom: "abc", reusedSummary: "ok" };
    if (s.id === "integration") return { ...s, mode: "skip" };
    return s;
  });
  const run = redOn(["check"]);
  const r = quiet(() => buildResults({ ...got, steps }, run));
  assert.equal(r.stoppedBy, "check");
  assert.equal(byId(r.results, "e2e").status, "reused");
  assert.equal(byId(r.results, "integration").status, "skipped");
  assert.equal(byId(r.results, "seed").status, "stopped");
  assert.equal(run.ran.includes("e2e"), false);
  assert.equal(run.ran.includes("integration"), false);
});

test("P81 V-2 b a newly ticked box with no receipt blocks at the Stop hook", () => {
  const r = stopHookProject();
  const out = r.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /No verification receipt exists/);
  assert.match(out.reason, /do it/);
  // control: the same tick with a receipt for this tree approves
  r.receipt();
  assert.equal(r.gate(), null);
});

const precheckWorld = ({ branch, reg, baseReg, baseThrows = false }) => {
  const cmds = [];
  const io = {
    run: (cmd) => {
      cmds.push(cmd);
      return { code: 0, out: "" };
    },
    log: () => {},
    branch: () => branch,
    registry: () => new Map(Object.entries(reg)),
    baseRegistry: () => {
      if (baseThrows) throw new Error("no base registry");
      return new Map(Object.entries(baseReg ?? {}));
    },
  };
  return { io, probes: () => cmds.filter((c) => /^probe \S+ --/.test(c)) };
};
const live = { entry: {} };

test("P81 V-3d precheck picks the ticket ids that get per-ticket checks: branch, added keys, unreadable base, --ticket, retired", async () => {
  const both = (id) => [`probe ${id} --dry-run`, `probe ${id} --typecheck`];
  // (a) the branch ticket, when live, gets both checks
  const a = precheckWorld({
    branch: "chore/AAA-01-thing",
    reg: { "AAA-01/M1": live, "OTHER-1/M1": live },
    baseReg: { "AAA-01/M1": live, "OTHER-1/M1": live },
  });
  await runPrecheck({ base: "b", ticket: undefined }, a.io);
  assert.deepEqual(a.probes(), both("AAA-01"));
  // (b) a ticket whose keys are new against the base is added, even off a ticket branch
  const b = precheckWorld({
    branch: "feat",
    reg: { "NEW-1/M1": live, "OLD-1/M1": live },
    baseReg: { "OLD-1/M1": live },
  });
  await runPrecheck({ base: "b", ticket: undefined }, b.io);
  assert.deepEqual(b.probes(), both("NEW-1"));
  // (b2) an unreadable base counts every key as new
  const b2 = precheckWorld({
    branch: "feat",
    reg: { "OLD-1/M1": live },
    baseThrows: true,
  });
  await runPrecheck({ base: "b", ticket: undefined }, b2.io);
  assert.deepEqual(b2.probes(), both("OLD-1"));
  // (c) --ticket wins over the branch and the added keys
  const c = precheckWorld({
    branch: "chore/AAA-01-thing",
    reg: { "AAA-01/M1": live, "BBB-2/M1": live, "NEW-1/M1": live },
    baseReg: { "AAA-01/M1": live, "BBB-2/M1": live },
  });
  await runPrecheck({ base: "b", ticket: "BBB-2" }, c.io);
  assert.deepEqual(c.probes(), both("BBB-2"));
  // (d) an id with no live entry, unknown or retired, gets no per-ticket check
  const d = precheckWorld({
    branch: "chore/GONE-9-thing",
    reg: { "RET-1/M1": { entry: { retired: true } } },
    baseReg: {},
  });
  await runPrecheck({ base: "b", ticket: undefined }, d.io);
  assert.deepEqual(d.probes(), []);
  const d2 = precheckWorld({ branch: "feat", reg: {}, baseReg: {} });
  await runPrecheck({ base: "b", ticket: "NOPE-1" }, d2.io);
  assert.deepEqual(d2.probes(), []);
});

// ---- the mutation-registry step ----

test("P81 VT-MR6b registryPlan defers the Playwright-backed keys: they neither select the step nor count", () => {
  // A harness that claims a Playwright test command and defers it to a slower run.
  bindSetup(
    resolveSetup({
      packs: [
        {
          name: "synthetic",
          mutationHarnesses: [
            {
              claims: (e) => /playwright/.test(e.test ?? ""),
              defer: { label: "Playwright-backed", to: "the nightly" },
            },
          ],
        },
      ],
    }),
  );
  const entries = () =>
    new Map([
      ["T/M1", { entry: { kind: "patch", test: "x exec playwright test a" } }],
      ["T/M2", { entry: { kind: "patch", test: "node --test x.test.mjs" } }],
    ]);
  const sel =
    (...keys) =>
    () =>
      keys.map((key) => ({ key, rules: ["guard"] }));
  const both = registryPlan("b", sel("T/M1", "T/M2"), entries);
  assert.deepEqual(
    [both.when, both.keys, both.deferred],
    [true, ["T/M2"], ["T/M1"]],
  );
  const pw = registryPlan("b", sel("T/M1"), entries);
  assert.deepEqual([pw.when, pw.keys, pw.deferred], [false, [], ["T/M1"]]);
  assert.match(
    registryDryLine(both),
    /1 selected \(T\/M2\), 1 Playwright-backed deferred to the nightly/,
  );
});

// ---- the gate config ----

const stepOf = (id, extra = {}) => ({
  id,
  when: true,
  cmd: `run ${id}`,
  why: "why",
  notRun: "not run",
  summary: () => "ok",
  limitS: 10,
  reuse: { deny: [] },
  ...extra,
});
const baseConfig = (over = {}) => ({
  steps: [stepOf("check"), stepOf("db", { stack: "pg" })],
  stacks: {
    pg: { health: { step: "db", preflight: () => "a", ready: () => "b" } },
  },
  stopOnRedBefore: "db",
  dataPaths: { "data/": ["db"] },
  ...over,
});
const throws = (cfg, re) => assert.throws(() => defineGate(cfg), re);

test("P81 GC-8 defineGate freezes the config, its steps, its data paths and its deny lists", () => {
  const g = defineGate(baseConfig());
  assert.ok(Object.isFrozen(g), "config");
  assert.ok(Object.isFrozen(g.steps[0]), "step");
  assert.ok(Object.isFrozen(g.dataPaths), "dataPaths");
  assert.ok(Object.isFrozen(g.steps[0].reuse.deny), "deny list");
});

test("P81 pick, allTasksLines allTasksLines joins every Tasks line and pick takes the last match", () => {
  assert.equal(pick("a\nb1\nb2", [/b/]), "b2");
  assert.equal(pick("a", [/z/]), null);
  assert.equal(allTasksLines("Tasks: 1\nx\nTasks: 2"), "Tasks: 1 | Tasks: 2");
  assert.equal(allTasksLines("x"), null);
});

test("P81 GC-P3 planned steps carry no limitS, reuse, stack or option key", () => {
  const config = stackGate({ reuse: { deny: [] } });
  const { steps, notRun } = plan(config, ["db/m.sql", "web/x"], {
    registry: { when: true, count: 1 },
  });
  assert.ok(steps.length > 3 && notRun.length > 0);
  for (const s of [...steps, ...notRun])
    for (const key of ["limitS", "reuse", "stack", "option"])
      assert.equal(key in s, false, `${s.id} carries ${key}`);
});

const rule = (id, extra = {}) => ({
  id,
  tier: "HUMAN",
  reason: "r",
  match: () => false,
  ...extra,
});
const reviewMapOf = (over = {}) => ({
  rules: [rule("H0"), rule("M1", { tier: "MACHINE" })],
  sizeExcluded: ["M1"],
  warn: 800,
  oversize: 1500,
  ...over,
});
const dodOf = (over = {}) => ({
  files: ["plans/phase-*.md"],
  contract: "plans/contracts/{id}.md",
  human: "(human)",
  oversize: /^oversize-accepted: \S/,
  ...over,
});

test("P81 INFRA-43 GC-1 reviewMap rejects a duplicate rule id, a bad tier or match, an unknown size exclusion and a warn at or above oversize", () => {
  assert.doesNotThrow(() =>
    defineGate(baseConfig({ reviewMap: reviewMapOf() })),
  );
  const bad = (over, re) =>
    throws(baseConfig({ reviewMap: reviewMapOf(over) }), re);
  bad({ rules: [rule("H0"), rule("H0")] }, /reviewMap\.rules.*duplicate rule id/);
  bad({ rules: [rule("H0", { tier: "WHATEVER" })] }, /reviewMap\.rules.*tier/);
  bad({ rules: [rule("H0", { match: "x" })] }, /reviewMap\.rules.*match/);
  bad({ sizeExcluded: ["ZZ"] }, /reviewMap\.sizeExcluded.*"ZZ"/);
  bad({ warn: 1500 }, /reviewMap\.warn.*below/);
  bad({ warn: 2000 }, /reviewMap\.warn.*below/);
});

test("P81 INFRA-43 GC-2 dod needs a contract path with {id} and an oversize RegExp", () => {
  assert.doesNotThrow(() => defineGate(baseConfig({ dod: dodOf() })));
  const bad = (over, re) => throws(baseConfig({ dod: dodOf(over) }), re);
  bad({ files: [] }, /dod\.files/);
  bad({ files: [3] }, /dod\.files/);
  bad({ contract: "plans/contract.md" }, /dod\.contract.*\{id\}/);
  bad({ oversize: "oversize" }, /dod\.oversize.*RegExp/);
});

test("P81 INFRA-43 GC-3 pushGuard refuses an empty list and a protected name with a metacharacter", () => {
  const ok = (names) =>
    defineGate(baseConfig({ pushGuard: { protected: names } })).pushGuard;
  assert.deepEqual(ok(["main", "release/v1.0"]).protected, [
    "main",
    "release/v1.0",
  ]);
  const bad = (pushGuard) => throws(baseConfig({ pushGuard }), /pushGuard/);
  bad({});
  bad({ protected: [] });
  bad({ protected: [3] });
  bad({ protected: ["ma in"] });
  bad({ protected: ["a|b"] });
});

test("P81 INFRA-43 GC-4 stack services reject an unknown step id, an empty list and an empty name", () => {
  const withServices = (services) =>
    baseConfig({
      stacks: {
        pg: {
          health: { step: "db", preflight: () => "a", ready: () => "b" },
          services,
        },
      },
    });
  assert.doesNotThrow(() =>
    defineGate(withServices({ db: ["db"], check: ["x"] })),
  );
  throws(withServices({ nope: ["db"] }), /services\.nope.*unknown step id/);
  throws(withServices({ db: [] }), /services\.db.*non-empty/);
  throws(withServices({ db: [""] }), /services\.db.*non-empty/);
});

test("P81 INFRA-43 GC-5 loadGateConfig rejects an invalid, a missing and a throwing config, and validates a plain object again", async () => {
  const project = (source) => {
    const root = tmp("p81-gc5-");
    if (source !== null) writeFileSync(join(root, "gate.config.mjs"), source);
    return root;
  };
  await assert.rejects(
    () => loadGateConfig(project("export default {};\n")),
    /gate\.config: /,
  );
  await assert.rejects(() => loadGateConfig(project(null)), /gate\.config\.mjs/);
  await assert.rejects(
    () => loadGateConfig(project('throw new Error("boom");\n')),
    /boom/,
  );
  // a plain object that never went through defineGate is checked again
  const plain = (names) => `export default {
  steps: [{ id: 'a', when: true, cmd: 'x', why: 'w', notRun: 'n', summary: () => 'ok', limitS: 5, reuse: false }],
  reviewMap: { rules: [], sizeExcluded: [], warn: 800, oversize: 1500 },
  dod: { files: ['plans/*.md'], contract: 'plans/{id}.md', human: '(human)', oversize: /^x/ },
  pushGuard: { protected: ${JSON.stringify(names)} },
};
`;
  await assert.rejects(
    () => loadGateConfig(project(plain([]))),
    /gate\.config: pushGuard/,
  );
  const good = await loadGateConfig(project(plain(["main", "release/v1.0"])));
  assert.equal(good.pushGuard.protected.length, 2);
  assert.ok(Object.isFrozen(good));
});
