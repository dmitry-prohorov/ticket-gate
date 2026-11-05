import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';

import { safeKillGroup } from '../kill-group.mjs';
import { ROOT } from '../root.mjs';
import { applyPatch, restorePatch, sessionOf } from './harness.mjs';
import { projectSetup } from './project.mjs';
import { LIMITS, tail, verdict } from './verdict.mjs';

/** A patch claimed by a harness that defers to a slower run: built and served once per distinct patch. */
export const isServed = (m, setup = projectSetup()) =>
  sessionOf(m, setup)?.defer !== undefined;

/** Twelve hex chars naming one distinct patch. */
export const patchKey = (m) =>
  createHash('sha256')
    .update(`${m.file}\0${m.within ?? ''}\0${m.find}\0${m.replace}`)
    .digest('hex')
    .slice(0, 12);

// A patch under opts.skipBuild (an e2e spec) changes no app code: it runs on the clean server.
const buildNeeded = (m, opts) => !m.file.startsWith(opts.skipBuild);

const needsWebBuild = (m, setup = projectSetup()) => {
  const opts = sessionOf(m, setup)?.opts;
  return opts === undefined || buildNeeded(m, opts);
};

/** Every entry of a group that could not be built or started is `error`, never `killed`. */
function groupError(group, phase, r) {
  return {
    results: group.entries.map((m) => ({
      id: m.id,
      status: 'error',
      detail: `group ${group.key}: ${phase} failed: ${tail(r.out)}`,
    })),
    build: phase === 'build' ? 'failed' : (group.built ?? 'none'),
  };
}

// Apply one patch, build, serve, run each entry's test against that one server,
// stop the server, restore the file byte-exact. Returns { results, build }.
async function runGroup(group, io, state, ctx, opts) {
  const m0 = group.entries[0];
  const rules = ctx.rulesFor(m0);
  const needsBuild = buildNeeded(m0, opts);
  let server = null;
  const body = async () => {
    for (const rule of rules) state[rule.flag] = true;
    applyPatch([m0], io, state);
    for (const rule of rules) {
      const cb = await io[rule.io]();
      if (cb.code !== 0) return groupError(group, 'build', cb);
    }
    if (needsBuild) {
      const build = await io.buildWeb();
      if (build.code !== 0) return groupError(group, 'build', build);
      group.built = 'ok';
    }
    server = await io.startServer();
    state.server = server;
    if (!server.ok) return groupError(group, 'start', server);
    const results = [];
    for (const m of group.entries) {
      const t = await io.run(m.test, { reuse: true });
      if (server.died?.())
        return groupError(group, 'start', {
          out: `server died mid-group: ${tail(t.out)}`,
        });
      results.push(verdict(m, t));
    }
    return { results, build: group.built ?? 'none' };
  };
  let res;
  try {
    res = await body();
  } catch (err) {
    res = groupError(group, 'start', { out: String(err?.message ?? err) });
  } finally {
    try {
      await server?.stop();
    } catch {
      /* best effort: the next group's port check reports a leak */
    }
    state.server = null;
    try {
      restorePatch(state, io);
    } catch (err) {
      const detail = `RESTORE FAILED: ${err.message}. Run ${ctx.setup.commands.restoreHint}`;
      res = {
        ...res,
        results: group.entries.map((m) => ({
          id: m.id,
          status: 'error',
          detail,
        })),
      };
    }
    state.restore = null;
  }
  for (const rule of rules) {
    const b = await io[rule.io]();
    if (b.code === 0) state[rule.flag] = false;
    else
      ctx.fatal = `${rule.cmd} failed after restoring ${m0.file}: ${rule.drift}. Run ${rule.cmd}`;
  }
  return res;
}

// One clean build and server prove every distinct served test passes unmutated.
async function cleanPhase(entries, io, state, opts) {
  const build = await io.buildWeb();
  if (build.code !== 0)
    return { fatal: `clean ${opts.build} failed: ${tail(build.out)}` };
  const server = await io.startServer();
  state.server = server;
  const base = new Map();
  try {
    if (!server.ok)
      return {
        fatal: `clean server did not start on port ${opts.port}: ${tail(server.out)}`,
      };
    for (const m of entries) {
      if (base.has(m.test)) continue;
      let r;
      try {
        r = await io.run(m.test, { reuse: true });
      } catch (err) {
        r = { code: 1, out: String(err) };
      }
      base.set(m.test, r);
    }
  } finally {
    try {
      await server.stop();
    } catch {
      /* best effort */
    }
    state.server = null;
  }
  return { base };
}

/**
 * The harness for patches tested through a built and served app: one clean
 * build proves the baselines, then one build and server per distinct patch.
 * `opts` = { name, order, port, env, build, start, skipBuild,
 * claims: RegExp, defer }; the harness exposes them as `opts`.
 */
export function served(opts) {
  return {
    name: opts.name,
    order: opts.order,
    claims: (m) => m.kind === 'patch' && opts.claims.test(m.test),
    defer: opts.defer,
    opts,
    ioMethods: ({ exec }) => ({
      buildWeb: () =>
        exec('bash', ['-lc', opts.build], {
          limitS: LIMITS.webBuild,
          env: opts.env,
        }),
      startServer: () => startWebServer(opts),
      portInUse,
    }),
    async refuse(_entries, io) {
      return (await io.portInUse(opts.port))
        ? `port ${opts.port} is already in use: a stale server would serve old code. Stop it (lsof -i :${opts.port}), then re-run.`
        : null;
    },
    async open(entries, io, state) {
      if (entries.length === 0)
        return { baselines: new Map(), groups: [], builds: 0 };
      const clean = await cleanPhase(entries, io, state, opts);
      if (clean.fatal) return { fatal: clean.fatal, groups: [], builds: 1 };
      return { baselines: clean.base, builds: 1 };
    },
    // Groups that rebuild leave their mutated build behind, so the groups that do
    // not rebuild (e2e patches) run first, on the clean phase's build.
    group(entries) {
      const byKey = new Map();
      for (const m of entries) {
        const key = patchKey(m);
        if (!byKey.has(key)) byKey.set(key, { key, entries: [] });
        byKey.get(key).entries.push(m);
      }
      const built = (g) => Number(buildNeeded(g.entries[0], opts));
      return [...byKey.values()].sort((a, b) => built(a) - built(b));
    },
    async run(groups, io, emit, state, ctx) {
      const done = [];
      let builds = 0;
      for (const group of groups) {
        const t0 = Date.now();
        const r = await runGroup(group, io, state, ctx, opts);
        if (r.build !== 'none') builds++;
        done.push({
          key: group.key,
          ids: group.entries.map((m) => m.id),
          build: r.build,
          ms: Date.now() - t0,
        });
        for (const x of r.results) emit(x, group.key);
        if (ctx.fatal) break;
      }
      return { groups: done, builds, fatal: ctx.fatal ?? undefined };
    },
    async interrupt(state) {
      try {
        await state.server?.stop();
      } catch {
        /* best effort */
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connects = (host, port) =>
  new Promise((resolve) => {
    const s = connect({ host, port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => (s.destroy(), resolve(false)));
  });

/** Is something listening on this port (IPv4 or IPv6 loopback)? */
const portInUse = async (port) =>
  (await connects('127.0.0.1', port)) || (await connects('::1', port));

const answers = (port) =>
  fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(2000) })
    .then(() => true)
    .catch(() => false);

// `opts.start` in its own process group; ready when `opts.port` answers.
async function startWebServer(opts) {
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

export { needsWebBuild, portInUse, startWebServer };
