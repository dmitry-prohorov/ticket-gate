// The shared fake-io world for the runner tests. It is the one place that fakes a lock holder
// with the engine's lock.mjs (surface kind wiring); importing it first sets TICKET_GATE_NIGHTLY_DIR before
// any module under test reads the env.
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { release, tryTake } from '../../../lock.mjs';

export const FIX = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'nightly',
);

// One nightly dir for the whole file: the module may read the env at import.
export const NIGHTLY = mkdtempSync(join(tmpdir(), 'nightly-out-'));
process.env.TICKET_GATE_NIGHTLY_DIR = NIGHTLY;
delete process.env.TICKET_GATE_STACK_LOCK_OWNER;

export const dirs = [NIGHTLY];
export const kids = [];
after(() => {
  for (const k of kids) k.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
export const tmp = (p = 'nightly-e2e-') => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
export const livePid = () => {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' });
  kids.push(c);
  return c.pid;
};

export const H = 3_600_000;
export const MIN = 60_000;
export const local = (d, h, m = 0) => new Date(2026, 0, d, h, m, 0).getTime();
export const NOW = local(15, 1, 0); // 01:00 local: a scheduled run, deadline 06:00
export const SHA = 'a1b2c3d4e5f6'.padEnd(40, '0');
export const SHA12 = SHA.slice(0, 12);
export const TOKEN = 'tg-fake-token-7f3a9c';
export const iso = (ms) => new Date(ms).toISOString();

export function world(opts = {}) {
  const {
    now = NOW,
    mainEnv = `TELEGRAM_BOT_TOKEN=${TOKEN}\nOTHER=1\n`,
    envLocal = true,
    report = 'green',
    pwCode = 0,
    timedOut = false,
    noReport = false,
    docker = true,
    fail = () => false,
    entries = new Map(),
    registryThrows = null,
    mutate = (w2, ids) => ({
      results: ids.map((id) => ({ id, status: 'killed' })),
    }),
    dirty = '',
    sha = SHA,
    sleep,
  } = opts;
  rmSync(NIGHTLY, { recursive: true, force: true });
  mkdirSync(NIGHTLY, { recursive: true });
  const root = tmp('nightly-world-');
  const main = join(root, 'main');
  const tmpd = join(root, 'tmp');
  mkdirSync(join(main, 'apps', 'web'), { recursive: true });
  mkdirSync(join(main, 'supabase', 'functions'), { recursive: true });
  mkdirSync(tmpd);
  if (envLocal)
    writeFileSync(join(main, 'apps', 'web', '.env.local'), 'NEXT_PUBLIC_X=1\n');
  if (mainEnv !== null)
    writeFileSync(join(main, 'supabase', 'functions', '.env'), mainEnv);
  const lock = join(root, 'lock', 'stack.lock');
  mkdirSync(dirname(lock));
  const wt = join(tmpd, 'demo-nightly', SHA12);

  const w = {
    root,
    main,
    tmpd,
    lock,
    wt,
    clock: now,
    calls: [],
    writes: [],
    removed: [],
    logs: [],
    sleeps: [],
    caffeinated: [],
    lockDuringRun: [],
    mutateCalls: [],
  };
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  };
  w.io = {
    now: () => w.clock,
    sleep:
      sleep?.(w) ??
      (async (ms) => {
        w.sleeps.push(ms);
        w.clock += ms;
      }),
    log: (s) => w.logs.push(String(s)),
    lockPath: lock,
    mainCheckout: main,
    tmpdir: tmpd,
    alive: isAlive,
    dockerUp: async () => docker,
    caffeinate: (pid) => w.caffeinated.push(pid),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => {
      w.writes.push(p);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c);
    },
    copyFile: (a, b) => {
      w.writes.push(b);
      mkdirSync(dirname(b), { recursive: true });
      copyFileSync(a, b);
    },
    mkdir: (p) => {
      w.writes.push(p);
      mkdirSync(p, { recursive: true });
    },
    rm: (p) => {
      w.removed.push(p);
      rmSync(p, { recursive: true, force: true });
    },
    exists: (p) => existsSync(p),
    registry: () => {
      if (registryThrows) throw new Error(registryThrows);
      return { entries, errors: [] };
    },
    run: async (cmd, args, o = {}) => {
      const line = [cmd, ...args].join(' ');
      w.calls.push({
        line,
        cwd: o.cwd,
        env: o.env,
        limitS: o.limitS,
        killSignal: o.killSignal,
        graceS: o.graceS,
      });
      if (line.startsWith('node tools/mutate-check.mjs --registry')) {
        const ids = args
          .find((a) => a.startsWith('--ids='))
          .slice(6)
          .split(',');
        w.mutateCalls.push(ids);
        const got = mutate(w, ids, o);
        if (got.results) {
          mkdirSync(join(o.cwd, '.turbo'), { recursive: true });
          writeFileSync(
            join(o.cwd, '.turbo', 'mutation-registry.json'),
            JSON.stringify({ results: got.results }),
          );
        }
        return { code: 0, timedOut: got.timedOut === true, out: '' };
      }
      if (line === 'git status --porcelain')
        return { code: 0, timedOut: false, out: dirty };
      if (fail(line))
        return { code: 1, timedOut: false, out: 'forced failure' };
      if (line === 'git rev-parse origin/main')
        return { code: 0, timedOut: false, out: `${sha}\n` };
      if (line.startsWith('git worktree add')) {
        mkdirSync(args[args.indexOf('--detach') + 1] ?? wt, {
          recursive: true,
        });
      }
      if (line.includes('playwright test')) {
        w.lockDuringRun.push(
          existsSync(join(lock, 'owner.json'))
            ? JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'))
            : null,
        );
        const out = o.env?.PLAYWRIGHT_JSON_OUTPUT_NAME;
        if (out && !noReport) {
          mkdirSync(dirname(out), { recursive: true });
          copyFileSync(join(FIX, `${report}.json`), out);
        }
        return { code: pwCode, timedOut, out: '' };
      }
      return { code: 0, timedOut: false, out: '' };
    },
  };
  return w;
}

export const history = () => {
  const f = join(NIGHTLY, 'history.jsonl');
  return existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
};
export const nightlyText = () =>
  readdirSync(NIGHTLY)
    .map((f) => readFileSync(join(NIGHTLY, f), 'utf8'))
    .join('\n');
export const KEYS = [
  'v',
  'sha',
  'ranAt',
  'endedAt',
  'ms',
  'trigger',
  'status',
  'reason',
  'reachedPlaywright',
  'stats',
  'redSpecs',
  'flakySpecs',
  'report',
  'finalReset',
  'mutations',
].sort();
export const heldBy = (lock, owner = 'verify:ticket') =>
  tryTake(lock, { owner, cwd: '/work/other', pid: livePid(), env: {} }).holder;

export { release };
