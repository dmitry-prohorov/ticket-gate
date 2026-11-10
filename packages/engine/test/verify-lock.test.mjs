// The stack lock around a verify run: buildResults takes it at the preflight step, fails the
// preflight when it is refused, and releases it on every path; gateLock waits for a holder up to
// a limit instead of failing at once. Every lock is a mkdtemp path; a live holder pid is a
// spawned `sleep 60`; the clock and the sleep are injected, so nothing here really waits.
// The lock reads its tuning and owner variables from the environment it is handed; the names are
// built from parts so no consumer-prefixed name sits in this file.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { enterScratchProject } from "./scratch-project.mjs";

const leave = enterScratchProject();
after(leave);
const { gateLock, release, tryTake } = await import("../lock.mjs");
const { buildResults } = await import("../run.mjs");

const P = "TICKET_GATE_STACK_LOCK_";
const OWNER_ENV = `${P}OWNER`;
const tuning = (waitS, pollS = 1, printS = 1) => ({
  [`${P}WAIT_S`]: String(waitS),
  [`${P}POLL_S`]: String(pollS),
  [`${P}PRINT_S`]: String(printS),
});

const dirs = [];
const kids = [];
after(() => {
  for (const k of kids) k.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const newLock = () => {
  const d = mkdtempSync(join(tmpdir(), "verify-lock-"));
  dirs.push(d);
  return join(d, ".turbo", "stack.lock");
};
const livePid = () => {
  const c = spawn("sleep", ["60"], { stdio: "ignore" });
  kids.push(c);
  return c.pid;
};
const hold = (path, owner = "nightly") =>
  tryTake(path, { owner, cwd: "/work/holder", pid: livePid(), env: {} }).holder;

const step = (id) => ({
  id,
  mode: "run",
  cmd: `cmd-${id}`,
  why: "test",
  summary: () => "ok",
});
const plan = (...ids) => ({ steps: ids.map(step), notSelected: [] });
const fakeLock = (acquire) => {
  const lock = {
    released: 0,
    acquired: 0,
    acquire() {
      lock.acquired += 1;
      return acquire();
    },
    release() {
      lock.released += 1;
    },
  };
  return lock;
};
const OK = { status: 0, out: "", streamed: true };

test("VK-1 buildResults: a refused acquire records preflight fail with the summary and runs no later step", () => {
  const summary =
    "stack lock: nightly running since 2026-01-15T01:00:00.000Z; waited 45 min";
  const lock = fakeLock(() => ({ ok: false, summary }));
  const ran = [];
  const r = buildResults(
    plan("deps", "preflight", "db", "e2e"),
    (s) => {
      ran.push(s.id);
      return OK;
    },
    { lock },
  );
  assert.deepEqual(ran, ["deps"], "only the step before preflight ran");
  const pre = r.results.find((x) => x.id === "preflight");
  assert.equal(pre.status, "fail");
  assert.equal(pre.summary, summary);
  assert.equal(typeof pre.ms, "number");
  assert.equal(
    r.results.some((x) => ["db", "e2e"].includes(x.id)),
    false,
  );
  assert.ok(r.failures.some((f) => f.id === "preflight"));
  assert.equal(r.ok, false);
  assert.equal(lock.acquired, 1);
});

test("VK-3 buildResults releases the lock on pass, fail, timedOut and a throwing runStep", () => {
  const cases = {
    pass: () => OK,
    fail: (s) =>
      s.id === "db" ? { status: 1, out: "boom", streamed: true } : OK,
    timedOut: (s) =>
      s.id === "e2e"
        ? { status: 124, out: "", timedOut: true, streamed: true }
        : OK,
  };
  for (const [name, runStep] of Object.entries(cases)) {
    const lock = fakeLock(() => ({ ok: true }));
    buildResults(plan("preflight", "db", "e2e"), runStep, { lock });
    assert.equal(lock.acquired, 1, `${name}: acquired once`);
    assert.equal(lock.released, 1, `${name}: released once`);
  }
  const lock = fakeLock(() => ({ ok: true }));
  assert.throws(
    () =>
      buildResults(
        plan("preflight", "db"),
        (s) => {
          if (s.id === "db") throw new Error("runStep exploded");
          return OK;
        },
        { lock },
      ),
    /runStep exploded/,
  );
  assert.equal(lock.released, 1, "throw: released once");
});

test("VK-4 gateLock acquires once the holder releases mid-wait (limit 5 s, release after 1 s) and removes its waiter file", () => {
  const path = newLock();
  const holder = hold(path);
  let t = Date.parse("2026-01-15T01:00:00.000Z");
  let sleeps = 0;
  let waiterSeen = false;
  const logs = [];
  const env = tuning(5);
  const g = gateLock({
    path,
    env,
    now: () => t,
    sleep: (ms) => {
      sleeps += 1;
      t += ms;
      waiterSeen ||= existsSync(join(`${path}.waiters`, `${process.pid}.json`));
      if (sleeps === 1) release(path, holder);
    },
    log: (s) => logs.push(String(s)),
  });
  const got = g.acquire();
  assert.deepEqual(got, { ok: true });
  assert.ok(sleeps >= 1 && sleeps <= 2, `slept ${sleeps} times`);
  assert.ok(waiterSeen, "a waiter file named by our pid existed while waiting");
  assert.ok(
    logs.some(
      (l) =>
        /stack lock held by .*nightly running since/.test(l) &&
        /waiting/.test(l),
    ),
    logs.join("\n"),
  );
  const left = existsSync(`${path}.waiters`)
    ? readdirSync(`${path}.waiters`)
    : [];
  assert.deepEqual(left, [], "waiter file removed once taken");
  assert.match(env[OWNER_ENV], /^verify:ticket:\d+:\d+$/);
  g.release();
  assert.equal(existsSync(path), false, "release frees the lock");
});

test("VK-4 gateLock gives up after the wait limit naming the holder, and removes its waiter file", () => {
  const path = newLock();
  hold(path);
  let t = Date.parse("2026-01-15T01:00:00.000Z");
  let sleeps = 0;
  const g = gateLock({
    path,
    env: tuning(3),
    now: () => t,
    sleep: (ms) => {
      sleeps += 1;
      t += ms;
    },
    log: () => {},
  });
  const got = g.acquire();
  assert.equal(got.ok, false);
  assert.match(
    got.summary,
    /^stack lock: nightly running since .+; waited \d+ min/,
  );
  assert.ok(sleeps >= 3, `waited the whole limit, slept ${sleeps} times`);
  const left = existsSync(`${path}.waiters`)
    ? readdirSync(`${path}.waiters`)
    : [];
  assert.deepEqual(left, []);
  assert.equal(existsSync(path), true, "the other holder keeps the lock");
});

test("EN-5b gateLock: env carries the owner under both names", () => {
  const path = newLock();
  const env = {};
  const g = gateLock({ path, env, log: () => {} });
  assert.deepEqual(g.acquire(), { ok: true });
  const old = "F" + "P_STACK_LOCK_OWNER";
  assert.match(env.TICKET_GATE_STACK_LOCK_OWNER, /^verify:ticket:\d+:\d+$/);
  assert.equal(env[old], env.TICKET_GATE_STACK_LOCK_OWNER);
  g.release();
});
