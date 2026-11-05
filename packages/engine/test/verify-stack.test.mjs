// The stack steps of a verify run over a synthetic project: the red-preflight stop, readiness after
// the seed, the early stop of the stack steps, the step watchdog, --timeout parsing and --precheck.
// The in-process cases chdir into a project whose config declares one stack; the spawned cases run
// the bin in a throwaway git project.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { bin, gateProject } from "./mutations/__tests__/gate-project.mjs";
import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";

const PRECHECKS = [
  { id: "first", cmd: "check-one", fix: "fix one" },
  { id: "second", cmd: "check-two", fix: "fix two" },
];

// One stack `st`. `seed` is planned only when a step that needs a fresh seed runs; `deps` is
// the command of the first step, so a spawned run can be made red before the stack steps.
const configSource = (
  deps = "true",
) => `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
const plain = (id, when, cmd = 'true') => step({ id, when, cmd, reuse: false });
const onStack = (id, when, extra = {}) =>
  step({ id, when, cmd: 'true', reuse: false, stack: 'st', ...extra });
export default defineGate({
  steps: [
    plain('deps', true, ${JSON.stringify(deps)}),
    plain('preflight', false),
    plain('check', true),
    plain('env', true),
    onStack('db', ['db/**']),
    onStack('integration', ['web/**']),
    onStack('seed', false),
    onStack('e2e', ['web/**']),
    onStack('mutation-registry', false, { option: 'registry' }),
  ],
  stacks: {
    st: {
      reset: { step: 'seed', before: ['e2e', 'mutation-registry'], satisfiedBy: ['db'] },
      health: {
        step: 'preflight',
        preflight: (ids) => 'echo up ' + ids.join(','),
        ready: (ids) => 'echo wait ' + ids.join(','),
      },
    },
  },
  stopOnRedBefore: 'seed',
  stackHint: (id) => 'echo ' + id,
  precheck: ${JSON.stringify(PRECHECKS)},
});
`;

const leave = enterScratchProject(configSource());
after(leave);
const { planSteps } = await import("../plan.mjs");
const { renderFailures } = await import("../failures.mjs");
const { parseTimeouts } = await import("../cli.mjs");
const { runPrecheck } = await import("../precheck.mjs");
const { STEP_IDS, buildResults, runInShell } = await import("../run.mjs");

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
const STACK = ["integration", "seed", "e2e"];
const WEB = ["web/x"];
// A runner that fails exactly the steps named in `red` and records every command it ran.
const redOn = (red) => {
  const ran = [];
  const fn = (step) => {
    ran.push(step.id);
    return { status: red.includes(step.id) ? 1 : 0, out: "error: red\n" };
  };
  fn.ran = ran;
  return fn;
};

test("VT-P2 a red preflight stops the gate: the runner never sees a later step, the receipt is red", () => {
  const plan = planSteps(WEB, []);
  const seen = [];
  const { results, ok, failures } = quiet(() =>
    buildResults(plan, (s) => {
      seen.push(s.id);
      return s.id === "preflight"
        ? { status: 1, out: "service db is Exited\n" }
        : { status: 0, out: "fine\n" };
    }),
  );
  assert.deepEqual(seen, ["deps", "preflight"]);
  assert.deepEqual(
    results.map((r) => `${r.id}:${r.status}`),
    ["deps:pass", "preflight:fail"],
  );
  assert.equal(ok, false);
  assert.deepEqual(
    failures.map((f) => f.id),
    ["preflight"],
  );
});

test("VT-R1 a readiness failure after seed turns seed red with the per-service lines; green keeps it a pass", () => {
  const plan = planSteps(WEB, []);
  const seedStep = byId(plan.steps, "seed");
  assert.equal(seedStep.ready, "echo wait e2e");
  const run = (readyStatus) => {
    const calls = [];
    const fn = (s, opts) => {
      calls.push({ cmd: s.cmd, limitS: opts?.limitS, append: s.append });
      if (s.cmd === seedStep.ready)
        return readyStatus === 0
          ? { status: 0, out: "stack ok for: e2e\n" }
          : {
              status: 1,
              out: "service auth is starting (health: starting) after 90 s\n",
            };
      return { status: 0, out: "3 passed\n" };
    };
    fn.calls = calls;
    return fn;
  };
  const redRun = run(1);
  const red = quiet(() => buildResults(plan, redRun));
  const seedRed = byId(red.results, "seed");
  assert.equal(seedRed.status, "fail");
  assert.match(seedRed.summary, /service auth is starting/);
  assert.equal(red.ok, false);
  // a readiness failure does not stop the gate (only a red preflight does)
  assert.equal(red.results.at(-1).id, "e2e");
  const readyCall = redRun.calls.find((c) => c.cmd === seedStep.ready);
  assert.equal(readyCall.limitS, 120);
  assert.equal(readyCall.append, true);
  const green = quiet(() => buildResults(plan, run(0)));
  assert.equal(byId(green.results, "seed").status, "pass");
  // a red step is never followed by its readiness run
  const none = [];
  quiet(() =>
    buildResults(plan, (s) => {
      none.push(s.cmd);
      return { status: s.id === "seed" ? 1 : 0, out: "" };
    }),
  );
  assert.ok(!none.includes(seedStep.ready));
});

test("V-1a a red pre-stack step stops the stack steps", () => {
  const plan = planSteps(WEB, []);
  const run = redOn(["check"]);
  const r = quiet(() => buildResults(plan, run));
  assert.equal(r.stoppedBy, "check");
  assert.equal(r.ok, false);
  for (const id of STACK)
    assert.equal(run.ran.includes(id), false, `${id} must not run`);
  // The steps that need no stack still ran.
  assert.ok(run.ran.includes("env"));
  // A red deps stops preflight too: it exists only for stack steps.
  const deps = redOn(["deps"]);
  const d = quiet(() => buildResults(plan, deps));
  assert.equal(d.stoppedBy, "deps");
  assert.equal(deps.ran.includes("preflight"), false);
});

test("V-1b --keep-going runs every selected stack step", () => {
  const plan = planSteps(WEB, []);
  const run = redOn(["check"]);
  const r = quiet(() => buildResults(plan, run, { keepGoing: true }));
  for (const id of STACK) assert.ok(run.ran.includes(id), `${id} must run`);
  assert.equal(r.stoppedBy, null);
  assert.ok(r.results.every((x) => x.status !== "stopped"));
});

test("V-1c a stopped step is recorded stopped with the stopping step named, never skipped", () => {
  const plan = planSteps(WEB, []);
  const r = quiet(() => buildResults(plan, redOn(["check"])));
  for (const id of ["preflight", ...STACK]) {
    const res = byId(r.results, id);
    // preflight ran before check; only the steps after the red one are stopped
    if (id === "preflight") continue;
    assert.equal(res.status, "stopped", id);
    assert.equal(res.summary, "not run (stopped: check red)");
  }
  assert.ok(r.results.every((x) => x.status !== "skipped"));
  // a green run records nothing as stopped, and keeps the plan's step order
  const green = quiet(() => buildResults(plan, redOn([])));
  assert.deepEqual(
    green.results.map((x) => x.id),
    plan.steps.map((s) => s.id),
  );
  assert.ok(green.results.every((x) => x.status === "pass"));
  assert.equal(green.stoppedBy, null);
});

test("V-1d the failures file and receipt name the stop", () => {
  const p = gateProject({ config: configSource("exit 1"), registry: null });
  mkdirSync(join(p.dir, "web"));
  p.put("web/x", "x\n");
  const r = bin(p.dir, ["verify"]);
  assert.equal(r.status, 1, r.out);
  const file = readFileSync(
    join(p.dir, ".turbo", "ticket-verify-failures.md"),
    "utf8",
  );
  assert.equal(
    file.split("\n")[0],
    "# verify:ticket failures - stopped before the stack steps: deps red",
  );
  const receipt = JSON.parse(
    readFileSync(join(p.dir, ".turbo", "ticket-verify.json"), "utf8"),
  );
  assert.equal(receipt.ok, false);
  const stopped = receipt.results.filter((x) => x.status === "stopped");
  assert.ok(stopped.some((x) => x.id === "seed"));
  assert.ok(stopped.some((x) => x.id === "e2e"));
  // No stop: the first line is unchanged.
  const plain = renderFailures({
    treeHash: "h",
    ranAt: "t",
    failures: [{ id: "check", cmd: "c", why: "w", out: "x" }],
    stoppedBy: null,
  });
  assert.equal(plain.split("\n")[0], "# verify:ticket failures");
});

test("V-1e a red e2e does not stop mutation-registry: only a red step before seed stops the stack", () => {
  const plan = planSteps(WEB, [], { registry: { when: true } });
  const run = redOn(["e2e"]);
  const r = quiet(() => buildResults(plan, run));
  assert.ok(run.ran.includes("mutation-registry"));
  assert.equal(r.stoppedBy, null);
  assert.equal(byId(r.results, "mutation-registry").status, "pass");
});

test("V-2 --precheck writes no gate state and exits with the precheck result", () => {
  const p = gateProject({ config: configSource(), registry: null });
  p.put("web/x", "x\n");
  p.put(".turbo/ticket-verify-failures.md", "sentinel\n");
  const stateBefore = readdirSync(join(p.dir, ".turbo"));
  const r = bin(p.dir, ["verify", "--precheck"]);
  assert.match(r.out, /^precheck: \d+ ok, \d+ failed/m, r.out);
  assert.deepEqual(readdirSync(join(p.dir, ".turbo")), stateBefore);
  assert.equal(existsSync(join(p.dir, ".turbo", "ticket-verify.json")), false);
});

test("V-2b --precheck refuses another flag, naming it", () => {
  const p = gateProject({ config: configSource(), registry: null });
  const bad = bin(p.dir, ["verify", "--precheck", "--fresh"]);
  assert.equal(bad.status, 2, bad.out);
  assert.match(bad.out, /--fresh/);
});

test("V-3b a failed precheck exits non-zero and names the check and its fix", async () => {
  const io = (failing) => {
    const lines = [];
    return {
      lines,
      run: (cmd) => ({ code: failing.includes(cmd) ? 1 : 0, out: "bad\n" }),
      log: (l) => lines.push(l),
      branch: () => "feat",
      registry: () => new Map(),
      baseRegistry: () => new Map(),
    };
  };
  const red = io(["check-two"]);
  assert.equal(await runPrecheck({ base: "main" }, red), 1);
  assert.ok(red.lines.some((l) => l.startsWith("precheck first: ok")));
  assert.ok(
    red.lines.some(
      (l) => l.startsWith("precheck second: FAIL") && l.includes("fix two"),
    ),
  );
  const green = io([]);
  assert.equal(await runPrecheck({ base: "main" }, green), 0);
});

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("VT-T1a a step past its limit is timedOut and summarised TIMEOUT", () => {
  const logDir = tmp("stack-limit-");
  const step = {
    id: "t",
    cmd: "sleep 8",
    mode: "run",
    why: "w",
    summary: () => "ok",
  };
  const started = Date.now();
  const r = runInShell(step, { limitS: 1, logDir });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.status, 0);
  assert.ok(Date.now() - started < 6000, "the limit did not end the step");
  const { results, ok, failures } = quiet(() =>
    buildResults({ steps: [step], notSelected: [] }, () => r, {
      limits: { t: 1 },
    }),
  );
  assert.equal(results[0].summary, "TIMEOUT after 1 s (limit t: 1 s)");
  assert.equal(results[0].status, "fail");
  assert.equal(ok, false);
  assert.match(failures[0].out, /TIMEOUT after 1 s \(limit t: 1 s\)/);
  // a step that itself exits 124 is a plain failure, not a timeout
  const own = runInShell(
    { id: "own", cmd: "exit 124" },
    { limitS: 30, logDir },
  );
  assert.equal(own.status, 124);
  assert.equal(own.timedOut, false);
});

test("VT-T1b the watchdog kills the step's whole process group, not only its shell", async () => {
  const logDir = tmp("stack-group-");
  const pidFile = join(logDir, "pid");
  const step = {
    id: "g",
    cmd: `sleep 25 & echo $! > ${pidFile}; wait`,
    mode: "run",
  };
  const r = runInShell(step, { limitS: 2, logDir });
  assert.equal(r.timedOut, true);
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.ok(grandchild > 1, "the step never started its child");
  try {
    for (let i = 0; i < 60 && pidAlive(grandchild); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      pidAlive(grandchild),
      false,
      "the step group outlived its limit",
    );
  } finally {
    if (pidAlive(grandchild)) process.kill(grandchild, "SIGKILL");
  }
});

test("VT-T4 a malformed or unknown --timeout is an error naming it, and exits 2 before any step", () => {
  assert.ok(STEP_IDS.includes("e2e"));
  for (const [arg, named] of [
    ["--timeout=e2e:abc", "abc"],
    ["--timeout=e2e:0", "0"],
    ["--timeout=e2e:-5", "-5"],
    ["--timeout=e2e:1.5", "1.5"],
    ["--timeout=e2e", "e2e"],
    ["--timeout=nope:5", "nope"],
  ]) {
    const t = parseTimeouts([arg]);
    assert.ok(t.error?.includes(named), `${arg}: ${t.error}`);
    assert.equal(t.overridden.size, 0);
  }
  const good = parseTimeouts(["--timeout=e2e:5"]);
  assert.equal(good.error, null);
  assert.equal(good.limits.e2e, 5);
  // the spawned bin refuses before running anything and writes no receipt
  const p = gateProject({ config: configSource(), registry: null });
  p.put("web/x", "x\n");
  const r = bin(p.dir, ["verify", "--timeout=e2e:0"]);
  assert.equal(r.status, 2, r.out);
  assert.ok(r.out.includes('"0"'), r.out);
  assert.equal(existsSync(join(p.dir, ".turbo", "ticket-verify.json")), false);
  assert.doesNotMatch(r.out, /===/);
});
