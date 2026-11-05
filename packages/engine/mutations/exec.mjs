import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeKillGroup } from '../kill-group.mjs';
import { ROOT } from '../root.mjs';
import { projectSetup } from './project.mjs';
import { LIMITS } from './verdict.mjs';

// Every child runs here. detached: its own process group and session, so a
// terminal Ctrl-C reaches only the tool, which forwards it (onSignal in main).
// The loop is async because a listener runs only when the event loop turns.
const inFlight = new Set();
let signalCtx = { state: {}, onInterrupt: async () => {}, drop: undefined };

/** Which signal ended the run, if any: the tool's own, else the child's. */
export const interruptSignal = (state, r) =>
  state.interrupted ??
  (r.signal === 'SIGTERM'
    ? 'SIGTERM'
    : r.signal === 'SIGINT' || r.code === 130
      ? 'SIGINT'
      : null);

// The setup's drop list (the e2e step's report path, for this repo)
// must never reach a child: a served Playwright run here would overwrite
// .turbo/e2e-report.json (an earlier incident).
export function childEnv(
  extra,
  base = process.env,
  drop = projectSetup().childEnv.drop,
) {
  const rest = Object.fromEntries(
    Object.entries(base).filter(([k]) => !drop.includes(k)),
  );
  return { ...rest, ...extra };
}

export function exec(file, args, { input, limitS, env } = {}) {
  return new Promise((resolve) => {
    const c = spawn(file, args, {
      cwd: ROOT,
      env: childEnv(env, process.env, signalCtx.drop),
      detached: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    inFlight.add(c);
    let out = '';
    let settled = false;
    let timer;
    const done = async (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inFlight.delete(c);
      const { state, onInterrupt } = signalCtx;
      const sig = interruptSignal(state, r);
      if (sig) await onInterrupt(sig);
      resolve(r);
    };
    // Past the limit: TERM the whole group, KILL it 5 s later, resolve at once
    // (a grandchild holding the pipes open would otherwise delay 'close').
    const timeOut = (child) => {
      safeKillGroup(child.pid, 'SIGTERM');
      setTimeout(() => safeKillGroup(child.pid, 'SIGKILL'), 5000).unref();
      done({ code: 124, out, signal: null, timedOut: true, limitS });
    };
    // prettier-ignore
    if (limitS !== undefined) timer = setTimeout(() => timeOut(c), limitS * 1000);
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', (err) => done({ code: 1, out: String(err), signal: null }));
    // The forwarded signal can be lost by a group member still starting up
    // (forked, not yet exec'd), which then outlives its leader and holds the
    // pipes open, so 'close' never fires. When the leader exits on an
    // interrupt, KILL what is left of its group (orphans; the run exits right
    // after, so a delayed KILL would never fire) and settle at once.
    c.on('exit', (code, signal) => {
      if (!signalCtx.state.interrupted) return;
      safeKillGroup(c.pid, 'SIGKILL');
      done({ code: code ?? 1, out, signal });
    });
    c.on('close', (code, signal) => done({ code: code ?? 1, out, signal }));
    if (input !== undefined) {
      c.stdin.on('error', () => {});
      c.stdin.end(input);
    }
  });
}

/**
 * The io runMutations drives: the generic file and command methods, one build
 * method per rebuild rule, and every session's `ioMethods` (sql channel, served
 * build and start, type check).
 */
function realIo(only, state, onInterrupt, setup = projectSetup()) {
  signalCtx = { state, onInterrupt, drop: setup.childEnv.drop };
  const sh = (cmd, limitS) => exec('bash', ['-lc', cmd], { limitS });
  const io = {
    only,
    state,
    run: (cmd, { reuse } = {}) =>
      exec('bash', ['-lc', cmd], {
        limitS: LIMITS.run,
        env: reuse ? setup.reuseEnv : undefined,
      }),
    readFile: (p) => readFileSync(join(ROOT, p), 'utf8'),
    writeFile: (p, s) => writeFileSync(join(ROOT, p), s),
  };
  for (const rule of setup.rebuild)
    io[rule.io] = () => sh(rule.cmd, rule.limitS ?? LIMITS.build);
  const sessions = [
    ...[...setup.kinds.values()].map((k) => k.session),
    ...setup.harnesses,
  ];
  for (const s of sessions) Object.assign(io, s?.ioMethods?.({ exec, sh }));
  return io;
}

export { inFlight, realIo };
