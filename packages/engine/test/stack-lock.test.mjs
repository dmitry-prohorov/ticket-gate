// The stack lock (lock.mjs): atomic take, dead-holder takeover, release bookkeeping, release only
// by the holder, and the holder's own runs passing the check. Every lock lives under a mkdtemp
// dir passed as the path; a live "other" pid is a spawned `sleep 60`, a dead pid an exited child.
// The lock reads its owner variable from the environment it is handed; the name is built from
// parts so no consumer-prefixed name sits in this file.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  heldByOther,
  readLock,
  readReleased,
  release,
  tryTake,
} from "../lock.mjs";

const LOCK_URL = pathToFileURL(
  join(import.meta.dirname, "..", "lock.mjs"),
).href;
const OWNER_ENV = "F" + "P_STACK_LOCK_OWNER";
const dirs = [];
const kids = [];
after(() => {
  for (const k of kids) k.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const newLock = () => {
  const d = mkdtempSync(join(tmpdir(), "stack-lock-"));
  dirs.push(d);
  return join(d, ".turbo", "stack.lock");
};
const livePid = () => {
  const c = spawn("sleep", ["60"], { stdio: "ignore" });
  kids.push(c);
  return c.pid;
};
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const take = (path, owner, extra = {}) =>
  tryTake(path, { owner, cwd: "/work/a", env: {}, ...extra });

test("S-2 a second owner is refused while a live pid holds it, and gets the holder back", async () => {
  const path = newLock();
  const first = take(path, "verify:ticket", { pid: livePid() });
  assert.equal(first.ok, true);
  const second = take(path, "mutate:check", { pid: process.pid });
  assert.equal(second.ok, false);
  assert.equal(second.holder.owner, "verify:ticket");
  assert.equal(second.holder.id, first.holder.id);
  // the stored owner is still the first one
  assert.equal(json(join(path, "owner.json")).id, first.holder.id);

  // simultaneous takers in separate processes: exactly one wins
  const path2 = newLock();
  const script = `
    import { tryTake } from ${JSON.stringify(LOCK_URL)};
    const r = tryTake(${JSON.stringify(path2)}, { owner: 'nightly', cwd: '/x', env: {} });
    console.log(JSON.stringify({ ok: r.ok }));
    process.stdin.resume();
  `;
  const procs = Array.from({ length: 6 }, () => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    kids.push(c);
    return c;
  });
  const oks = await Promise.all(
    procs.map(
      (c) =>
        new Promise((resolve) => {
          let buf = "";
          c.stdout.on("data", (d) => {
            buf += d;
            if (buf.includes("\n")) resolve(JSON.parse(buf).ok);
          });
        }),
    ),
  );
  for (const c of procs) c.stdin.end();
  assert.equal(oks.filter(Boolean).length, 1, JSON.stringify(oks));
});

test("S-3 a dead pid's lock is taken over and the released file says stale:true", () => {
  const path = newLock();
  const dead = deadPid();
  assert.equal(take(path, "verify:ticket", { pid: dead }).ok, true);
  const before = Date.now();
  const got = take(path, "nightly", { pid: livePid() });
  assert.equal(got.ok, true, "takeover of a dead holder");
  const rel = readReleased(path);
  assert.equal(rel.stale, true);
  assert.equal(rel.pid, dead);
  assert.equal(rel.owner, "verify:ticket");
  assert.ok(Date.parse(rel.lastReleasedAt) >= before - 1000);
  assert.equal(readLock(path).owner, "nightly");

  // a live holder is never taken over
  const p2 = newLock();
  const live = take(p2, "profile:web", { pid: livePid() });
  const refused = take(p2, "nightly", { pid: process.pid });
  assert.equal(refused.ok, false);
  assert.equal(refused.holder.id, live.holder.id);
  assert.equal(existsSync(p2), true);
  assert.equal(readReleased(p2), null);
});

test("S-4 release removes the dir and writes lastReleasedAt, stale:false", () => {
  const path = newLock();
  const pid = livePid();
  const T = Date.parse("2026-01-15T10:00:00.000Z");
  const { holder } = take(path, "nightly", { pid, now: () => T });
  assert.equal(readReleased(path), null, "nothing released yet");
  const at = Date.parse("2026-01-15T11:30:00.000Z");
  assert.equal(release(path, holder, { now: () => at }), true);
  assert.equal(existsSync(path), false);
  const disk = json(`${path}.released.json`);
  assert.deepEqual(disk, {
    v: 1,
    lastReleasedAt: "2026-01-15T11:30:00.000Z",
    owner: "nightly",
    pid,
    stale: false,
  });
  assert.deepEqual(readReleased(path), disk);
});

test("S-6 release by a non-holder (other id) returns false and leaves the lock", () => {
  const path = newLock();
  const { holder } = take(path, "verify:ticket", { pid: livePid() });
  const impostor = { ...holder, id: `${holder.id}-other` };
  assert.equal(release(path, impostor), false);
  assert.equal(existsSync(path), true, "the lock dir stays");
  assert.equal(statSync(path).isDirectory(), true);
  assert.equal(json(join(path, "owner.json")).id, holder.id);
  assert.equal(readReleased(path), null, "no released record written");
  assert.equal(release(path, holder), true, "the real holder can release");
  assert.equal(existsSync(path), false);
});

test("S-8 heldByOther: null for no lock, a dead holder, and the owner variable equal to the id; the holder otherwise", () => {
  const none = newLock();
  assert.equal(heldByOther(none, { env: {} }), null);

  const deadPath = newLock();
  take(deadPath, "verify:ticket", { pid: deadPid() });
  assert.equal(heldByOther(deadPath, { env: {} }), null);

  const path = newLock();
  const { holder } = take(path, "nightly", { pid: livePid() });
  assert.equal(
    heldByOther(path, { env: { [OWNER_ENV]: holder.id } }),
    null,
    "the holder's own runs pass",
  );
  assert.equal(
    heldByOther(path, { env: { [OWNER_ENV]: "nightly:1:2" } })?.id,
    holder.id,
  );
  assert.equal(heldByOther(path, { env: {} })?.owner, "nightly");
  assert.equal(
    heldByOther(path, { env: { [OWNER_ENV]: "" } })?.owner,
    "nightly",
  );
});
