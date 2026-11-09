// Ported cases of the stack lock (lock.mjs) and of the lock around a verify run: the owner
// record, the shared lock path of a worktree, the empty-dir window, nested takes, the reaping
// guard and its race, the wait message, and a waiting verify run. Each test keeps the id of the
// case it was ported from. Every lock lives under a private mkdtemp dir passed as the path (or
// as the path variable of a spawned run), so suites running at once never share one. A live
// holder is a spawned `sleep 60`, a dead pid an exited child. Nothing here names a consumer.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { bin, gateProject } from "./mutations/__tests__/gate-project.mjs";
import { CONFIG_URL } from "./scratch-project.mjs";
import {
  STALE_EMPTY_MS,
  gateLock,
  lockPath,
  readLock,
  readReleased,
  reapStale,
  release,
  tryTake,
} from "../lock.mjs";

const ENGINE = join(import.meta.dirname, "..");
const LOCK_URL = pathToFileURL(join(ENGINE, "lock.mjs")).href;
const OWNER_ENV = "TICKET_GATE_STACK_LOCK_OWNER";
const PATH_ENV = "TICKET_GATE_STACK_LOCK_PATH";
const dirs = [];
const kids = [];
after(() => {
  for (const k of kids) k.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tmp = (prefix = "lock-cases-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const newLock = () => join(tmp(), ".turbo", "stack.lock");
const livePid = () => {
  const c = spawn("sleep", ["60"], { stdio: "ignore" });
  kids.push(c);
  return c.pid;
};
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const take = (path, owner, extra = {}) =>
  tryTake(path, { owner, cwd: "/work/a", env: {}, ...extra });
const hold = (path, owner = "nightly") =>
  tryTake(path, { owner, cwd: "/work/holder", pid: livePid(), env: {} }).holder;

test("P81 S-1 owner.json has exactly v, id, owner, pid, cwd, startedAt", () => {
  const path = newLock();
  const T = Date.parse("2026-01-15T10:00:00.000Z");
  const pid = livePid();
  const got = tryTake(path, {
    owner: "nightly",
    cwd: "/work/a",
    pid,
    now: () => T,
    env: {},
  });
  assert.equal(got.ok, true);
  assert.ok(statSync(path).isDirectory(), "the lock is a directory");
  const disk = json(join(path, "owner.json"));
  assert.deepEqual(Object.keys(disk).sort(), [
    "cwd",
    "id",
    "owner",
    "pid",
    "startedAt",
    "v",
  ]);
  assert.deepEqual(disk, {
    v: 1,
    id: `nightly:${pid}:${T}`,
    owner: "nightly",
    pid,
    cwd: "/work/a",
    startedAt: "2026-01-15T10:00:00.000Z",
  });
  assert.equal(got.holder.id, disk.id);
});

test("P81 S-5 lockPath is one realpath from a worktree and its main checkout", () => {
  const root = tmp("lock-cases-git-");
  const main = join(root, "main");
  mkdirSync(main);
  const git = (cwd, ...a) =>
    spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        ...a,
      ],
      { cwd, encoding: "utf8" },
    );
  assert.equal(git(main, "init", "-q", "-b", "main").status, 0);
  assert.equal(git(main, "commit", "-q", "--allow-empty", "-m", "x").status, 0);
  const wt = join(root, "wt");
  assert.equal(git(main, "worktree", "add", "-q", "-b", "b", wt).status, 0);
  const expected = join(realpathSync(main), ".turbo", "stack.lock");
  assert.equal(lockPath(main, { env: {} }), expected);
  assert.equal(lockPath(wt, { env: {} }), expected);
  assert.equal(
    lockPath(wt, { env: { [PATH_ENV]: "/somewhere/else.lock" } }),
    "/somewhere/else.lock",
  );
});

test("P81 S-7 an empty lock dir is held under 10 s and stale after", () => {
  const path = newLock();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(path);
  const m = statSync(path).mtimeMs;
  const soon = () => m + 5_000;
  const later = () => m + 15_000;
  const h = readLock(path, { now: soon });
  assert.equal(h.owner, "unknown");
  assert.equal(h.pid, 0);
  assert.equal(h.id, "");
  assert.equal(reapStale(path, { now: soon }), false);
  assert.equal(existsSync(path), true);
  const refused = take(path, "nightly", { pid: process.pid, now: soon });
  assert.equal(refused.ok, false);
  assert.equal(refused.holder.owner, "unknown");
  assert.equal(existsSync(path), true, "the empty dir is still the lock");
  assert.equal(reapStale(path, { now: later }), true);
  assert.equal(existsSync(path), false);
  assert.equal(readReleased(path).stale, true);
});

test("P81 S-9 a nested take is nested, its release keeps the outer lock; an unknown owner throws", () => {
  const path = newLock();
  const outer = take(path, "nightly", { pid: livePid() });
  const nested = tryTake(path, {
    owner: "verify:ticket",
    cwd: "/work/b",
    pid: process.pid,
    env: { [OWNER_ENV]: outer.holder.id },
  });
  assert.equal(nested.ok, true);
  assert.equal(nested.nested, true);
  assert.equal(release(path, nested.holder), false);
  assert.equal(existsSync(path), true, "the outer lock survives");
  assert.equal(json(join(path, "owner.json")).id, outer.holder.id);
  assert.equal(readReleased(path), null);

  assert.throws(
    () => take(newLock(), "bogus"),
    /unknown stack lock owner: bogus/,
  );
});

test("P81 reapStale race a lock re-taken after the dead holder was read is not removed", () => {
  const path = newLock();
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "owner.json"),
    JSON.stringify({
      v: 1,
      id: "dead-id",
      owner: "nightly",
      pid: 99999,
      cwd: "/work/a",
      startedAt: new Date().toISOString(),
    }),
  );
  let b = null;
  let calls = 0;
  const alive = (pid) => {
    calls += 1;
    if (calls === 1) {
      b = tryTake(path, {
        owner: "verify:ticket",
        pid: 22222,
        cwd: "/work/b",
        env: {},
        alive: (p) => p === 22222,
      });
    }
    return pid === 22222;
  };
  const a = tryTake(path, {
    owner: "nightly",
    pid: 33333,
    cwd: "/work/a",
    env: {},
    alive,
  });
  assert.equal(b.ok, true);
  assert.equal(a.ok, false);
  assert.equal(a.holder.id, b.holder.id);
  assert.equal(json(join(path, "owner.json")).id, b.holder.id);
  assert.equal(release(path, b.holder), true);
});

test("P81 reaping guard a stale guard clears, a fresh one blocks, a reap leaves none", () => {
  const path = newLock();
  take(path, "verify:ticket", { pid: deadPid() });
  const guard = `${path}.reaping`;
  mkdirSync(guard);
  assert.equal(reapStale(path), false, "a fresh guard blocks");
  assert.equal(reapStale(path), false, "and keeps blocking");
  assert.equal(existsSync(path), true);

  const old = (Date.now() - 2 * STALE_EMPTY_MS) / 1000;
  utimesSync(guard, old, old);
  assert.equal(
    reapStale(path),
    false,
    "the stale guard is removed, this call still yields",
  );
  assert.equal(existsSync(guard), false);
  assert.equal(reapStale(path), true, "the next call reaps");
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(guard), false, "a reap removes its own guard");
});

test("P81 VL-4 no nightlyStatus the wait message names no nightly command unless configured", () => {
  const path = newLock();
  hold(path);
  let t = Date.parse("2026-01-15T01:00:00.000Z");
  const env = {
    TICKET_GATE_STACK_LOCK_WAIT_S: "2",
    TICKET_GATE_STACK_LOCK_POLL_S: "1",
    TICKET_GATE_STACK_LOCK_PRINT_S: "1",
  };
  const acquire = (commands) =>
    gateLock({
      path,
      env: { ...env },
      now: () => t,
      sleep: (ms) => {
        t += ms;
      },
      log: () => {},
      ...(commands ? { commands } : {}),
    }).acquire();
  const got = acquire();
  assert.equal(got.ok, false);
  assert.doesNotMatch(got.summary, /undefined|shows the nightly/);
  assert.match(
    got.summary,
    /Wait for it to finish, then rerun ticket-gate verify\./,
  );
  const set = acquire({ nightlyStatus: "make nightly" });
  assert.equal(set.ok, false);
  assert.match(set.summary, /\(make nightly shows the nightly\)/);
});

// One stack `st`; `preflight` is its health step, planned when a stack step is selected.
const STACK_CONFIG = `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
const plain = (id, when, cmd = 'true') => step({ id, when, cmd, reuse: false });
const onStack = (id, when) => step({ id, when, cmd: 'true', reuse: false, stack: 'st' });
export default defineGate({
  steps: [
    plain('deps', true),
    plain('preflight', false),
    plain('check', true),
    onStack('db', ['db/**']),
    onStack('integration', ['web/**']),
    onStack('seed', false),
    onStack('e2e', ['web/**']),
  ],
  stacks: {
    st: {
      reset: { step: 'seed', before: ['e2e'], satisfiedBy: ['db'] },
      health: {
        step: 'preflight',
        preflight: (ids) => 'echo up ' + ids.join(','),
        ready: (ids) => 'echo wait ' + ids.join(','),
      },
    },
  },
  stopOnRedBefore: 'seed',
  stackHint: (id) => 'echo ' + id,
});
`;

test("P81 VL-2 a verify run with a live holder waits, then fails preflight naming it", () => {
  const p = gateProject({ config: STACK_CONFIG, registry: null });
  p.put("db/x.sql", "x\n");
  const path = newLock();
  hold(path, "nightly");
  const started = Date.now();
  const r = bin(p.dir, ["verify"], {
    [PATH_ENV]: path,
    [OWNER_ENV]: "",
    TICKET_GATE_STACK_LOCK_WAIT_S: "2",
    TICKET_GATE_STACK_LOCK_POLL_S: "1",
    TICKET_GATE_STACK_LOCK_PRINT_S: "1",
  });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 1, r.out);
  assert.ok(elapsed >= 2000, `waited the limit, elapsed ${elapsed} ms`);
  assert.match(r.out, /stack lock held by .*nightly running since.*waiting/);
  const receipt = json(join(p.dir, ".turbo", "ticket-verify.json"));
  const pre = receipt.results.find((x) => x.id === "preflight");
  assert.equal(pre?.status, "fail", r.out);
  assert.match(pre.summary, /nightly running since/);
  assert.equal(
    receipt.results.some((x) => x.id === "db"),
    false,
    "no stack step ran",
  );
  assert.equal(existsSync(path), true, "the holder keeps the lock");
});

test("P81 VL-5 a gate killed by SIGINT leaves a dead-pid lock; no signal handler in the verify modules", async () => {
  const skip = new Set(["serve.mjs", join("mutations", "cli.mjs")]);
  const files = readdirSync(ENGINE, { recursive: true }).filter(
    (f) =>
      f.endsWith(".mjs") &&
      !f.split("/").some((seg) => seg === "test" || seg === "node_modules") &&
      !skip.has(f),
  );
  assert.ok(files.includes("lock.mjs") && files.includes("run.mjs"));
  for (const f of files)
    assert.doesNotMatch(
      readFileSync(join(ENGINE, f), "utf8"),
      /process\.(on|once)\(\s*['"](SIGINT|SIGTERM)['"]/,
      f,
    );

  const path = newLock();
  const script = `
    import { gateLock } from ${JSON.stringify(LOCK_URL)};
    const r = gateLock({ path: ${JSON.stringify(path)} }).acquire();
    console.log('held ' + r.ok);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, [OWNER_ENV]: "" },
  });
  kids.push(child);
  await new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("held true")) resolve();
    });
    child.on("exit", () => reject(new Error(`child exited early: ${buf}`)));
  });
  assert.equal(existsSync(path), true);
  const killedAt = Date.now();
  const exit = new Promise((resolve) =>
    child.on("exit", (code, sig) => resolve({ code, sig })),
  );
  child.kill("SIGINT");
  const { sig } = await exit;
  assert.equal(sig, "SIGINT", "the gate dies on SIGINT, no handler defers it");
  assert.equal(existsSync(path), true, "the dead gate left its lock");

  const got = tryTake(path, { owner: "nightly", cwd: "/x", env: {} });
  assert.equal(got.ok, true, "a dead-pid lock is taken over");
  const rel = json(`${path}.released.json`);
  assert.equal(rel.stale, true);
  assert.equal(rel.owner, "verify:ticket");
  assert.ok(Date.parse(rel.lastReleasedAt) >= killedAt - 1000);
});

// ---- round 1 review: cases the public suite did not bite on ----

test("P81 VL-6 a refused mutate leaves the holder's lock and its owner.json id as they were", () => {
  const { dir } = gateProject();
  const path = join(dir, ".turbo", "stack.lock");
  const holder = hold(path, "verify:ticket");
  const before = readFileSync(join(path, "owner.json"), "utf8");
  // the child env is PATH and HOME only, so it carries no lock variable
  const r = bin(dir, ["mutate", "--registry", "--all"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /stack lock held: verify:ticket running since/);
  assert.equal(existsSync(path), true, "the holder's lock is still there");
  assert.equal(json(join(path, "owner.json")).id, holder.id);
  assert.equal(readFileSync(join(path, "owner.json"), "utf8"), before);
  assert.equal(readReleased(path), null);
});

test("P81 S-3 reapStale returns false for a live holder and keeps its lock, true for a dead one and removes it", () => {
  const live = newLock();
  const owner = hold(live);
  assert.equal(reapStale(live), false);
  assert.equal(existsSync(live), true);
  assert.equal(json(join(live, "owner.json")).id, owner.id);
  assert.equal(readReleased(live), null);

  const dead = newLock();
  const gone = tryTake(dead, {
    owner: "nightly",
    cwd: "/work/holder",
    pid: deadPid(),
    env: {},
  });
  assert.equal(gone.ok, true);
  assert.equal(reapStale(dead), true);
  assert.equal(existsSync(dead), false);
  assert.equal(readReleased(dead).stale, true);
  assert.equal(readReleased(dead).pid, gone.holder.pid);
  // nothing held: nothing to reap
  assert.equal(reapStale(newLock()), false);
});
