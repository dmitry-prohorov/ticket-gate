import { spawn } from 'node:child_process';
import { connect } from 'node:net';

import { safeKillGroup } from './kill-group.mjs';
import { LIMITS, tail } from './mutations/verdict.mjs';
import { ROOT } from './root.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connects = (host, port) =>
  new Promise((resolve) => {
    const s = connect({ host, port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => (s.destroy(), resolve(false)));
  });

/** Is something listening on this port (IPv4 or IPv6 loopback)? */
export const portInUse = async (port) =>
  (await connects('127.0.0.1', port)) || (await connects('::1', port));

const answers = (port) =>
  fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2000) })
    .then(() => true)
    .catch(() => false);

// `opts.start` in its own process group; ready when `opts.port` answers.
export async function startWebServer(opts, onSpawn) {
  const c = spawn('bash', ['-lc', opts.start], {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let exited = false;
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (out += d));
  const gone = new Promise((resolve) => {
    c.on('close', () => ((exited = true), resolve()));
    c.on('error', (err) => ((out += String(err)), (exited = true), resolve()));
  });
  const stop = async () => {
    if (!exited) {
      safeKillGroup(c.pid, 'SIGTERM');
      await Promise.race([gone, sleep(5000)]);
    }
    if (!exited) {
      safeKillGroup(c.pid, 'SIGKILL');
      await Promise.race([gone, sleep(2000)]);
    }
    for (let i = 0; i < 20 && (await portInUse(opts.port)); i++)
      await sleep(250);
  };
  onSpawn?.(stop);
  const died = () => exited;
  const deadline = Date.now() + LIMITS.serve * 1000;
  while (Date.now() < deadline && !exited) {
    if (await answers(opts.port)) return { ok: true, out, stop, died };
    await sleep(500);
  }
  return {
    ok: false,
    out: out || `no answer within ${LIMITS.serve} s`,
    stop,
    died,
  };
}

/** Why a port cannot be served on. Shared with the mutation harness. */
export const portBusy = (port) =>
  `port ${port} is already in use: a stale server would serve old code. Stop it (lsof -i :${port}), then re-run.`;

// Not detached, unlike the server: a terminal Ctrl-C must reach the build.
function runBuild(build, env) {
  return new Promise((resolve) => {
    const c = spawn('bash', ['-lc', build], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => c.kill('SIGKILL'), LIMITS.webBuild * 1000);
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, out: String(err) });
    });
    c.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

/**
 * Refuses a busy port, builds, starts the server and waits until `port` answers.
 * `onSpawn(stop)` runs right after the spawn, so a Ctrl-C during startup can stop it.
 * Throws on a busy port, a failed build or a server that never answers.
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function serve({ build, start, port, env }, { onSpawn } = {}) {
  if (await portInUse(port)) throw new Error(portBusy(port));
  const b = await runBuild(build, env);
  if (b.code !== 0) throw new Error(`build failed (${build}): ${tail(b.out)}`);
  const server = await startWebServer({ start, port, env }, onSpawn);
  if (!server.ok) {
    await server.stop();
    throw new Error(`server did not start on port ${port}: ${tail(server.out)}`);
  }
  return { stop: server.stop };
}
