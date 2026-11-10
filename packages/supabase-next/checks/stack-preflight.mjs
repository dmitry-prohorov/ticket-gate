#!/usr/bin/env node
// Is the local Supabase stack healthy enough for the gate steps about to run?
//
// The pack form. `stackPreflight(cfg)` binds the project values (services map, CLI command, web
// env file, anon key file, usage line) and returns the checker; a project binds them in a CLI shim
// or through the pack's stack-preflight command. Every problem line
// names the command that fixes it. Dependency-free Node ESM, no build step.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';

import { dbContainer } from '../mutations/snapshot.mjs';

import { safeKillGroup } from './kill-group.mjs';

// Re-exported from kill-group.mjs, a leaf module, so a caller that only kills process groups need
// not load this file.
export { killGroup, safeKillGroup } from './kill-group.mjs';

export const GRACE_S = 60;
// Reported as a warning only when unhealthy: no gate step needs them.
export const NEVER_REQUIRED = [
  'studio',
  'storage',
  'edge_runtime',
  'analytics',
  'vector',
];
// Never reported at all (a missing imgproxy or pooler is normal).
export const SILENT = ['imgproxy', 'pooler'];
const KNOWN = [
  'db',
  'kong',
  'auth',
  'rest',
  'realtime',
  'inbucket',
  'pg_meta',
  'studio',
  'storage',
  'edge_runtime',
  'analytics',
  'vector',
  'imgproxy',
  'pooler',
];

const API_HEALTH = 'http://127.0.0.1:54321/auth/v1/health';
const REST_URL = 'http://127.0.0.1:54321/rest/v1/';
const MAILPIT_URL = 'http://127.0.0.1:54324/livez';
const PG_URL = '127.0.0.1:54322';

/** The Supabase project id (config.toml `project_id`); throws as dbContainer does. */
export function projectId(configToml) {
  return dbContainer(configToml).replace(/^supabase_db_/, '');
}

function uptimeSeconds(status) {
  const m = /^Up (.*?)(?: \(|$)/.exec(status);
  if (!m) return Infinity;
  const t = m[1].toLowerCase();
  if (t.startsWith('less than a second')) return 0;
  if (t.startsWith('about a minute')) return 60;
  if (t.startsWith('about an hour')) return 3600;
  const n = /^(\d+) (second|minute|hour|day|week|month|year)/.exec(t);
  if (!n) return Infinity;
  const unit = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000,
    year: 31536000,
  }[n[2]];
  return Number(n[1]) * unit;
}

/** 'healthy' | 'starting' (may settle by itself) | 'stuck' (needs a human). */
export function classify(status) {
  const s = String(status);
  if (!/^Up/.test(s) || /\(paused\)/i.test(s)) return 'stuck';
  if (/\(health: starting\)/.test(s)) return 'starting';
  if (/\(unhealthy\)/.test(s)) {
    return uptimeSeconds(s) < GRACE_S ? 'starting' : 'stuck';
  }
  return 'healthy';
}

/** Parse `docker ps` text of `supabase_<svc>_<p>\t<status>` lines. `unknown` = lines that do not fit. */
export function parseDockerPs(text, pid) {
  const services = new Map();
  const unknown = [];
  const prefix = 'supabase_';
  const suffix = `_${pid}`;
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    const tab = line.indexOf('\t');
    const name = tab < 0 ? line : line.slice(0, tab);
    const status = tab < 0 ? '' : line.slice(tab + 1).trim();
    const svc =
      tab >= 0 && name.startsWith(prefix) && name.endsWith(suffix)
        ? name.slice(prefix.length, name.length - suffix.length)
        : null;
    if (svc === null || !KNOWN.includes(svc)) unknown.push(line);
    else services.set(svc, status);
  }
  return { services, unknown };
}

function stateOf(status) {
  if (/^Created/.test(status)) return 'created';
  if (/^Exited/.test(status)) return 'exited';
  if (/^Restarting/.test(status)) return 'restarting';
  if (/^Paused|\(paused\)/i.test(status)) return 'paused';
  if (/\(unhealthy\)/.test(status)) return 'unhealthy';
  return 'not running';
}

const bits = (steps, REQUIRED) => {
  const required = new Set();
  for (const s of steps) for (const svc of REQUIRED[s] ?? []) required.add(svc);
  return required;
};

async function collect({ steps }, io, cfg) {
  const { REQUIRED, cli, webEnvMissing } = cfg;
  const STOP_START = `${cli} stop && ${cli} start`;
  const bad = steps.filter((s) => !(s in REQUIRED));
  if (bad.length > 0) {
    throw new Error(
      `unknown step id ${bad.join(', ')}: use ${Object.keys(REQUIRED).join(', ')}`,
    );
  }
  const pid = io.projectId();
  const ps = await io.dockerPs();
  if (!ps.ok) {
    return {
      items: [
        {
          text: `Docker is not running (docker ps did not answer in 5 s): start Docker, then run \`${cli} start\``,
        },
      ],
      warnings: [],
    };
  }
  const text = ps.text;
  const { services, unknown } = parseDockerPs(text, pid);
  const unrecognised = (t) =>
    `unrecognised containers for project ${pid}:\n${String(t).trim()}`;
  // prettier-ignore
  if (unknown.length > 0) return { problems: [unrecognised(text)], warnings: [], transient: false };
  if (services.size === 0) {
    return {
      items: [{ text: `the stack is stopped: run \`${cli} start\`` }],
      warnings: [],
    };
  }

  const required = bits(steps, REQUIRED);
  const items = [];
  const warnings = [];
  for (const svc of required) {
    const status = services.get(svc);
    if (status === undefined) {
      items.push({
        text: `service ${svc} is missing (no container): run \`${STOP_START}\``,
      });
      continue;
    }
    const cls = classify(status);
    if (cls === 'healthy') continue;
    if (cls === 'starting') {
      items.push({ starting: { svc, status }, text: '' });
    } else if (svc !== 'db' && /\(unhealthy\)/.test(status)) {
      items.push({
        text: `service ${svc} is unhealthy (${status}): run \`docker restart supabase_${svc}_${pid}\``,
      });
    } else {
      items.push({
        text: `service ${svc} is ${stateOf(status)} (${status}): run \`${STOP_START}\``,
      });
    }
  }
  for (const [svc, status] of services) {
    if (required.has(svc) || SILENT.includes(svc)) continue;
    if (classify(status) === 'stuck' && /\(unhealthy\)/.test(status)) {
      warnings.push(
        `warning: service ${svc} is unhealthy (${status}); no gate step needs it`,
      );
    }
  }

  const wants = (id) => steps.includes(id);
  const probes = [];
  const add = (name, url, command, check) =>
    probes.push({ name, url, command, check });
  if (wants('db') || wants('seed')) {
    add('Postgres', PG_URL, STOP_START, async () => io.tcp(54322));
  }
  if (wants('integration')) {
    add(
      'Supabase API',
      API_HEALTH,
      STOP_START,
      async () => (await io.probe(API_HEALTH)) === 200,
    );
    add('REST', REST_URL, STOP_START, async () => {
      const key = io.anonKey();
      return (
        (await io.probe(REST_URL, {
          apikey: key,
          Authorization: `Bearer ${key}`,
        })) === 200
      );
    });
  }
  if (wants('e2e') || wants('mutation-registry')) {
    add(
      'Mailpit',
      MAILPIT_URL,
      `docker restart supabase_inbucket_${pid}`,
      async () => (await io.probe(MAILPIT_URL)) === 200,
    );
  }
  const answers = await Promise.all(probes.map((p) => p.check()));
  probes.forEach((p, i) => {
    if (!answers[i]) {
      items.push({
        text: `${p.name} (${p.url}) does not answer: ${p.command.startsWith('docker') ? `\`${p.command}\`` : `run \`${p.command}\``}`,
        deferrable: true,
      });
    }
  });
  if (wants('e2e') || wants('mutation-registry')) {
    const holder = await io.portHolder(3000);
    if (holder) {
      items.push({
        text: `port 3000 is held by pid ${holder.pid} (cwd ${holder.cwd}): stop that server; the gate starts its own`,
      });
    }
    if (!io.hasWebEnv()) items.push({ text: webEnvMissing });
  }
  return { items, warnings, pid };
}

const startingLine = (svc, status, pid, afterS) =>
  `service ${svc} is starting (${status})${afterS === undefined ? '' : ` after ${afterS} s`}: run \`docker restart supabase_${svc}_${pid}\``;

function shape(c, afterS) {
  if (c.problems) return c;
  const problems = c.items.map((i) =>
    i.starting
      ? startingLine(i.starting.svc, i.starting.status, c.pid, afterS)
      : i.text,
  );
  const transient =
    c.items.length > 0 && c.items.every((i) => i.starting || i.deferrable);
  return { problems, warnings: c.warnings, transient };
}

/** One look: { problems, warnings, transient }. `transient` = every problem may settle by itself. */
export async function checkStack({ steps }, io, cfg) {
  return shape(await collect({ steps }, io, cfg));
}

/** Poll every `everyMs` while all problems are transient, up to `forS` seconds. */
export async function waitReady(
  { steps },
  io,
  {
    forS,
    everyMs = 2000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  },
  cfg,
) {
  const start = now();
  for (;;) {
    const c = await collect({ steps }, io, cfg);
    const r = shape(c);
    if (r.problems.length === 0 || !r.transient) return r;
    if (now() - start >= forS * 1000) return shape(c, forS);
    await sleep(everyMs);
  }
}

/** Run `bash -lc cmd` in its own process group; on `limitS` TERM the group, KILL 5 s later. */
export function runBounded(cmd, { limitS, cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    let done = false;
    let timer;
    let hard;
    const swallow = (sig) => safeKillGroup(child.pid, sig);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!timedOut) clearTimeout(hard);
      resolve({ code: timedOut ? 124 : (code ?? 1), out, timedOut });
    };
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => {
      out += String(err);
      finish(1);
    });
    child.on('exit', (code) => {
      if (timedOut) finish(124);
      else setTimeout(() => finish(code), 200).unref();
    });
    child.on('close', (code) => finish(code));
    if (limitS !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        swallow('SIGTERM');
        hard = setTimeout(() => {
          swallow('SIGKILL');
          finish(124);
        }, 5000);
        hard.unref();
      }, limitS * 1000);
    }
  });
}

/** True when any HTTP response arrives; false on a connection error or after 2 s. */
export async function httpAnswers(url) {
  return (await httpStatus(url)) !== null;
}

/** HTTP status, or null on a connection error or after 2 s. */
export async function httpStatus(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    return res.status;
  } catch {
    return null;
  }
}

const run = (file, args, timeout) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout }, (err, stdout) =>
      resolve({ ok: !err, text: String(stdout ?? '') }),
    );
  });

/** The real io: docker, sockets, lsof, files. webEnv: { file }, anonKey: { file, name }. */
export function realIo(root, webEnv, anonKey) {
  const pid = () =>
    projectId(readFileSync(join(root, 'supabase/config.toml'), 'utf8'));
  return {
    projectId: pid,
    dockerPs: () =>
      run(
        'docker',
        [
          'ps',
          '-a',
          '--filter',
          `name=_${pid()}$`,
          '--format',
          '{{.Names}}\t{{.Status}}',
        ],
        5000,
      ),
    probe: httpStatus,
    tcp: (port) =>
      new Promise((resolve) => {
        const sock = net.connect({ port, host: '127.0.0.1' });
        sock.setTimeout(2000);
        sock.once('connect', () => (sock.destroy(), resolve(true)));
        sock.once('timeout', () => (sock.destroy(), resolve(false)));
        sock.once('error', () => resolve(false));
      }),
    portHolder: async (port) => {
      const l = await run(
        'lsof',
        ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
        3000,
      );
      const holder = l.text.trim().split('\n')[0];
      if (!holder) return null;
      const c = await run(
        'lsof',
        ['-a', '-p', holder, '-d', 'cwd', '-Fn'],
        3000,
      );
      const cwd = /^n(.*)$/m.exec(c.text)?.[1] ?? 'unknown';
      return { pid: Number(holder), cwd };
    },
    hasWebEnv: () => existsSync(join(root, webEnv.file)),
    anonKey: () => {
      const m = new RegExp(`^${anonKey.name}=(.+)$`, 'm').exec(
        readFileSync(join(root, anonKey.file), 'utf8'),
      );
      return m ? m[1].trim() : '';
    },
  };
}

/** Parse the CLI args: { steps, wait } or { error }. */
export function parseArgs(args, REQUIRED) {
  let steps = null;
  let wait = 0;
  for (const a of args) {
    let m;
    if ((m = /^--steps=(.*)$/.exec(a))) {
      steps = m[1].split(',').filter(Boolean);
      const bad = steps.filter((s) => !(s in REQUIRED));
      if (steps.length === 0 || bad.length > 0) {
        return {
          error: `unknown step id ${bad.join(', ') || '(none)'}: use ${Object.keys(REQUIRED).join(', ')}`,
        };
      }
    } else if ((m = /^--wait=(.*)$/.exec(a))) {
      if (!/^\d+$/.test(m[1])) {
        return { error: `--wait=${m[1]} is not a whole number of seconds` };
      }
      wait = Number(m[1]);
    } else return { error: `unknown argument ${a}` };
  }
  if (steps === null) return { error: '--steps is required' };
  return { steps, wait };
}

export async function main(args, io, out, cfg) {
  const parsed = parseArgs(args, cfg.REQUIRED);
  if (parsed.error) {
    out.error(`${parsed.error}\n${cfg.usage}`);
    return 2;
  }
  const r =
    parsed.wait > 0
      ? await waitReady({ steps: parsed.steps }, io, { forS: parsed.wait }, cfg)
      : await checkStack({ steps: parsed.steps }, io, cfg);
  for (const w of r.warnings) out.log(w);
  if (r.problems.length > 0) {
    for (const p of r.problems) out.error(p);
    return 1;
  }
  out.log(`stack ok for: ${parsed.steps.join(', ')}`);
  return 0;
}

/**
 * Bind the project values. services: step id -> service names. webEnv: { file, missing }.
 * anonKey: { file, name }. usage: the line printed after a parse error. cli: the Supabase CLI
 * command used in every fix line.
 */
export function stackPreflight({
  services,
  root,
  cli = 'supabase',
  webEnv,
  anonKey,
  usage,
}) {
  const cfg = { REQUIRED: services, cli, webEnvMissing: webEnv.missing, usage };
  const io = (r = root) => realIo(r, webEnv, anonKey);
  return {
    REQUIRED: services,
    checkStack: ({ steps }, i) => checkStack({ steps }, i, cfg),
    waitReady: ({ steps }, i, opts) => waitReady({ steps }, i, opts, cfg),
    parseArgs: (args) => parseArgs(args, services),
    realIo: io,
    main: (args, i = io(), out = console) => main(args, i, out, cfg),
  };
}
