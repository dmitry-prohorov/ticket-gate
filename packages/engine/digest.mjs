// What a verify:ticket step's result depends on, so a green result can be
// reused when none of it changed.
//
// stepDigest(id, cmd) is sha256 over: the step id, its command, the full base
// sha, the node version (and deno's for deno-check and functions), every
// gitignored .env* file (path and blob id) and every changed path from
// treeEntries(base) that is NOT denied for that step. Deny-lists, never
// allow-lists: a path nobody listed is an input of every step. tools/ is never
// denied, so a tooling change re-runs everything. One exception: DATA_PATHS
// names data folders and files under tools/ that only the listed steps read
// (the mutation registry and the four check baselines are data, not tooling),
// so every other step may reuse its result.
//
// Dependency-free Node ESM: ticket-gate.mjs imports this file, and a gate must
// stay cheap and must never write anything.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATE } from './project.mjs';
import { ROOT } from './root.mjs';
import { baseRef, treeEntries } from './tree.mjs';

/** The one rule for "this step counts as verified": verify-ticket and ticket-gate both read it. */
export const VERIFIED_STATUSES = Object.freeze(['pass', 'human', 'reused']);

// Per-step reuse (reusable, deny-list) is declared on each step in gate.config.mjs.
// A deny entry ending `/` is a path prefix, `*.md` any path ending `.md`,
// `a/**/*.x` a path under `a/` ending `.x`. maestro is human and has no entry.
export const STEP_INPUTS = Object.freeze(
  Object.fromEntries(
    GATE.steps
      .filter((s) => !s.human)
      .map((s) => [
        s.id,
        { reusable: s.reuse !== false, deny: s.reuse ? s.reuse.deny : [] },
      ]),
  ),
);

const matches = (pattern, path) => {
  const deep = pattern.indexOf('**/');
  if (deep >= 0)
    return (
      path.startsWith(pattern.slice(0, deep)) &&
      path.endsWith(pattern.slice(deep + 3).replace(/^\*/, ''))
    );
  if (pattern.endsWith('/')) return path.startsWith(pattern);
  if (pattern.startsWith('*')) return path.endsWith(pattern.slice(1));
  return path === pattern;
};

/**
 * Data under tools/: a folder prefix or a file path -> the only step ids it is
 * an input of. The four baselines are read by the project's check script alone (S-2 proves no
 * e2e input references them), so `check --update` does not invalidate e2e reuse.
 */
export const DATA_PATHS = GATE.dataPaths;

// The engine's own directory (relative to the project root, posix) plus the config's toolPrefixes:
// a change under either is an input of every step unless dataPaths narrows it.
const ENGINE_PREFIX = `${relative(ROOT, dirname(fileURLToPath(import.meta.url)))
  .split('\\')
  .join('/')}/`;
const isToolPath = (p) =>
  p.startsWith(ENGINE_PREFIX) || GATE.toolPrefixes.some((t) => p.startsWith(t));

/** True iff `path` cannot affect step `id`. An unknown id denies nothing. */
export function isDenied(id, path) {
  for (const [prefix, steps] of Object.entries(DATA_PATHS))
    if (path.startsWith(prefix)) return !steps.includes(id);
  if (isToolPath(path)) return false;
  return (STEP_INPUTS[id]?.deny ?? []).some((d) => matches(d, path));
}

/** `deno --version` first line; `-` when deno is absent, slow or failing. */
export function denoVersion() {
  const r = spawnSync('deno', ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (r.error || r.status !== 0) return '-';
  return r.stdout.split('\n')[0].trim() || '-';
}

const gitOut = (args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const blobId = (bytes) =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');

// Ignored directories (node_modules/, .turbo/) collapse to one entry and are
// never walked. A deleted env file simply drops out, which moves the digest.
function envFiles() {
  return gitOut([
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  ])
    .split('\0')
    .filter(Boolean)
    .filter(
      (p) =>
        !p.endsWith('/') &&
        basename(p).startsWith('.env') &&
        !p.split('/').includes('node_modules'),
    )
    .sort()
    .map((p) => [p, blobId(readFileSync(join(ROOT, p)))]);
}

/**
 * One read of the tree for many digests: the full base sha, the tool versions,
 * the env files and treeEntries(base). `versions` defaults to the running node
 * and `deno --version` (read once, only when a digest needs it).
 */
export function inputState({ base, versions } = {}) {
  const sha = gitOut(['rev-parse', base ?? baseRef()]).trim();
  let deno;
  const v = versions ?? {
    node: process.version,
    get deno() {
      return (deno ??= denoVersion());
    },
  };
  return {
    base: sha,
    versions: v,
    // A pack upgrade changes how a step's command or selector behaves: it re-runs every reusable step.
    packs: (GATE.packs ?? []).map((p) => `${p.name}@${p.version}`),
    env: envFiles(),
    entries: treeEntries(sha),
  };
}

const NEEDS_DENO = ['deno-check', 'functions'];

/** sha256 hex of everything step `id` running `cmd` depends on (see the header). */
export function stepDigest(id, cmd, { base, versions, state } = {}) {
  if (!(id in STEP_INPUTS)) throw new Error(`stepDigest: unknown step ${id}`);
  const s = state ?? inputState({ base, versions });
  const h = createHash('sha256');
  const add = (line) => h.update(`${line}\n`);
  add(id);
  add(cmd);
  add(s.base);
  add(`node ${s.versions.node}`);
  for (const pack of s.packs ?? []) add(`pack ${pack}`);
  if (NEEDS_DENO.includes(id)) add(`deno ${s.versions.deno}`);
  for (const [p, blob] of s.env) add(`${p}\0${blob}`);
  s.entries
    .filter(([p]) => !isDenied(id, p))
    .forEach(([p, state]) => add(`${p}\0${state}`));
  return h.digest('hex');
}

export { AFFECTED_NIGHTLY, NIGHTLY_MAX_AGE_MS } from './nightly-window.mjs';

/**
 * sha256 hex of what one e2e spec's result depends on: the file,
 * the base, node, the env files, and the changed paths in `inputs` (the ones
 * that select it) plus anything under tools/ except DATA_PATHS (the mutation
 * registry and the check baselines are not inputs of e2e).
 */
export function specDigest(file, inputs, { base, versions, state } = {}) {
  const s = state ?? inputState({ base, versions });
  const h = createHash('sha256');
  const add = (line) => h.update(`${line}\n`);
  add('e2e-spec');
  add(file);
  add(s.base);
  add(`node ${s.versions.node}`);
  for (const pack of s.packs ?? []) add(`pack ${pack}`);
  for (const [p, blob] of s.env) add(`${p}\0${blob}`);
  s.entries
    .filter(
      ([p]) => inputs.includes(p) || (isToolPath(p) && !isDenied('e2e', p)),
    )
    .forEach(([p, state]) => add(`${p}\0${state}`));
  return h.digest('hex');
}
