// One lock for the single local Supabase stack .
//
// The stack (db, edge runtime, :3000) holds one database that e2e resets and
// seeds. Two runs at once corrupt each other, so every run that resets it takes
// this lock: verify:ticket, mutate:check, profile:web and the nightly e2e.
//
// The lock is a directory `<main checkout>/.turbo/stack.lock` made by one
// atomic mkdir, with `owner.json` inside. A holder that dies leaves a lock
// naming a dead pid; the next taker removes it (takeover) and records
// `lastReleasedAt`, so nobody needs a signal handler (contract L-R1).
// Node built-ins only; no build step.

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_COMMANDS } from './config.mjs';
import { bothNames, envName } from './env-name.mjs';
import { ROOT } from './root.mjs';

export const OWNERS = [
  'verify:ticket',
  'mutate:check',
  'profile:web',
  'nightly',
];
export const STALE_EMPTY_MS = 10_000;
export const WAIT_S = 2700,
  POLL_S = 5,
  PRINT_S = 60;

/** The main checkout, also from inside a linked worktree. */
export function mainCheckout(cwd = ROOT) {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  return realpathSync(dirname(resolve(cwd, common)));
}

export function lockPath(cwd = ROOT, { env = process.env } = {}) {
  return (
    envName(env, 'STACK_LOCK_PATH') ?? join(mainCheckout(cwd), '.turbo', 'stack.lock')
  );
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export function readLock(path, { now = Date.now } = {}) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  void now;
  const o = readJson(join(path, 'owner.json'));
  if (o && typeof o.id === 'string' && Number.isInteger(o.pid)) return o;
  return {
    owner: 'unknown',
    pid: 0,
    id: '',
    startedAt: new Date(st.mtimeMs).toISOString(),
    cwd: '',
  };
}

export function readReleased(path) {
  return readJson(`${path}.released.json`);
}

function writeReleased(path, { owner, pid, stale, now = Date.now }) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    `${path}.released.json`,
    `${JSON.stringify({ v: 1, lastReleasedAt: new Date(now()).toISOString(), owner, pid, stale })}\n`,
  );
}

const emptyAndOld = (holder, now) =>
  holder.owner === 'unknown' &&
  now() - Date.parse(holder.startedAt) > STALE_EMPTY_MS;

export function reapStale(path, { now = Date.now, alive = isAlive } = {}) {
  const holder = readLock(path, { now });
  // An empty lock dir has no pid to test: it is stale only once it is old.
  if (holder?.owner === 'unknown')
    return emptyAndOld(holder, now) && reap(path, holder, now);
  if (holder === null || alive(holder.pid)) return false;
  return reap(path, holder, now);
}

// Reapers are serialized by an atomic mkdir of `${path}.reaping`, and the lock
// is re-read inside it: between readLock and the rename another taker may have
// reaped the dead holder and taken the lock, and a bare rename would take that
// live lock away from it.
function reap(path, holder, now) {
  const guard = `${path}.reaping`;
  try {
    mkdirSync(guard);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // A reaper that died inside the guard must not block reaping forever.
    try {
      if (now() - statSync(guard).mtimeMs > STALE_EMPTY_MS)
        rmSync(guard, { recursive: true, force: true });
    } catch {
      // already gone
    }
    return false;
  }
  try {
    const onDisk = readLock(path, { now });
    if (onDisk === null || onDisk.id !== holder.id) return false;
    if (onDisk.id === '' && !emptyAndOld(onDisk, now)) return false;
    const gone = `${path}.stale-${process.pid}-${now()}`;
    renameSync(path, gone);
    rmSync(gone, { recursive: true, force: true });
    writeReleased(path, {
      owner: holder.owner,
      pid: holder.pid,
      stale: true,
      now,
    });
    return true;
  } catch {
    return false; // lost a race on the rename
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

export function tryTake(
  path,
  {
    owner,
    cwd = process.cwd(),
    pid = process.pid,
    now = Date.now,
    alive = isAlive,
    env = process.env,
  },
) {
  if (!OWNERS.includes(owner))
    throw new Error(`unknown stack lock owner: ${owner}`);
  reapStale(path, { now, alive });
  const current = readLock(path, { now });
  if (
    current !== null &&
    current.id !== '' &&
    envName(env, 'STACK_LOCK_OWNER') === current.id &&
    alive(current.pid)
  )
    return { ok: true, holder: { ...current, nested: true }, nested: true };
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (e) {
    if (e.code === 'EEXIST')
      return { ok: false, holder: readLock(path, { now }) };
    throw e;
  }
  const startedAtMs = now();
  const holder = {
    v: 1,
    id: `${owner}:${pid}:${startedAtMs}`,
    owner,
    pid,
    cwd,
    startedAt: new Date(startedAtMs).toISOString(),
  };
  writeFileSync(join(path, 'owner.json'), `${JSON.stringify(holder)}\n`);
  return { ok: true, holder };
}

export function release(path, holder, { now = Date.now } = {}) {
  if (holder.nested === true) return false;
  const onDisk = readLock(path, { now });
  if (onDisk?.id !== holder.id) return false;
  rmSync(path, { recursive: true, force: true });
  // prettier-ignore
  writeReleased(path, { owner: holder.owner, pid: holder.pid, stale: false, now });
  return true;
}

/** The live holder that is not the caller's own tree, else null. */
export function heldByOther(
  path,
  { env = process.env, alive = isAlive, now = Date.now } = {},
) {
  const holder = readLock(path, { now });
  if (holder === null) return null;
  if (holder.owner === 'unknown')
    return emptyAndOld(holder, now) ? null : holder;
  if (envName(env, 'STACK_LOCK_OWNER') === holder.id) return null;
  return alive(holder.pid) ? holder : null;
}

export function holderLine(holder) {
  return `${holder.owner} running since ${holder.startedAt} (pid ${holder.pid}, ${holder.cwd})`;
}

export function refuseIfHeld(path = lockPath(), opts) {
  const h = heldByOther(path, opts);
  if (h !== null)
    throw new Error(
      `stack lock held: ${holderLine(h)}. Wait for it, or stop it; TICKET_GATE_STACK_LOCK_OWNER lets the holder's own runs pass.`,
    );
}

/** Take the lock or exit 1 naming the holder; release on exit. */
export function takeOrExit(
  owner,
  { path = lockPath(), exit = process.exit, log = console.error } = {},
) {
  const got = tryTake(path, { owner });
  if (!got.ok) {
    log(`${owner}: stack lock held: ${holderLine(got.holder)}`);
    exit(1);
    return got.holder;
  }
  Object.assign(process.env, bothNames('STACK_LOCK_OWNER', got.holder.id));
  process.on('exit', () => release(path, got.holder));
  return got.holder;
}

/** Blocks the calling thread; no signal handler, so Ctrl-C kills a waiting gate at once (L-R1). */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const envS = (env, name, dflt) => {
  const n = Number.parseInt(envName(env, name) ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : dflt;
};

/**
 * The stack lock around the stack steps. `acquire` waits for any
 * holder up to TICKET_GATE_STACK_LOCK_WAIT_S (45 min), then fails the preflight step with
 * a summary naming the holder. `release` is safe to call twice.
 */
export function gateLock({
  path = lockPath(),
  env = process.env,
  now = Date.now,
  sleep = sleepSync,
  log = console.log,
  alive = isAlive,
  commands: given,
} = {}) {
  const commands = { ...DEFAULT_COMMANDS, ...given };
  let held = null;
  const waiter = join(`${path}.waiters`, `${process.pid}.json`);
  const dropWaiter = () => rmSync(waiter, { force: true });
  return {
    acquire() {
      const waitS = envS(env, 'STACK_LOCK_WAIT_S', WAIT_S);
      const pollS = envS(env, 'STACK_LOCK_POLL_S', POLL_S);
      const printS = envS(env, 'STACK_LOCK_PRINT_S', PRINT_S);
      const take = () =>
        tryTake(path, { owner: 'verify:ticket', now, alive, env });
      const taken = (got) => {
        dropWaiter();
        held = got.holder;
        Object.assign(env, bothNames('STACK_LOCK_OWNER', got.holder.id));
        return { ok: true };
      };
      let got = take();
      if (got.ok) return taken(got);
      const started = now();
      let lastPrint = -Infinity;
      mkdirSync(dirname(waiter), { recursive: true });
      writeFileSync(
        waiter,
        `${JSON.stringify({ v: 1, owner: 'verify:ticket', pid: process.pid, cwd: process.cwd(), since: new Date(started).toISOString() })}\n`,
      );
      const fail = (holder) => {
        dropWaiter();
        const min = Math.round((now() - started) / 60000);
        const who = holder ? holderLine(holder) : 'unknown holder';
        return {
          ok: false,
          summary: `stack lock: ${who}; waited ${min} min. Wait for it to finish${commands.nightlyStatus ? ` (${commands.nightlyStatus} shows the nightly)` : ''}, then rerun ${commands.verify}.`,
        };
      };
      for (;;) {
        const { holder } = got;
        if (now() - started >= waitS * 1000) return fail(holder);
        if (now() - lastPrint >= printS * 1000) {
          lastPrint = now();
          const min = Math.floor((now() - started) / 60000);
          log(
            `stack lock held by ${holderLine(holder ?? {})}; waiting (${min} of ${waitS / 60} min)`,
          );
        }
        sleep(pollS * 1000);
        got = take();
        if (got.ok) return taken(got);
      }
    },
    release() {
      dropWaiter();
      if (held) release(path, held, { now });
      held = null;
    },
  };
}
