// Identifies the current working tree, so a verification receipt cannot outlive
// the code it verified.
//
// The hash covers every path this branch changes or adds (measured from the
// merge-base with `main`, not HEAD, so committing does not empty it), outside
// the ticket docs. Each path contributes only its final state: mode plus git blob id
// of the working-tree bytes, `-` if deleted, `d` for a directory. Committing,
// staging or leaving a file untracked therefore does not move the hash; a
// changed byte, a changed execute bit, a deletion or a rename does.
//
// treeHashAt(commit) is the same hash computed from a commit's tree instead of
// the working tree, so ticket-gate can ask "was the tree a DoD tick was
// committed on ever verified green?". verify-ticket records each green run's
// hash in .turbo/ticket-verify-history.jsonl (readHistory reads it back).
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './root.mjs';

// `.ticket-gate/tree.json` { exclude: [dir, ...] }: paths under these are outside the tree hash.
// Read once; a missing or unreadable file excludes nothing (stricter: more paths are hashed).
let EXCLUDE = null;
export function treeExclude() {
  if (EXCLUDE) return EXCLUDE;
  try {
    const raw = JSON.parse(
      readFileSync(join(ROOT, '.ticket-gate', 'tree.json'), 'utf8'),
    );
    EXCLUDE = Array.isArray(raw.exclude)
      ? raw.exclude.filter((d) => typeof d === 'string' && d)
      : [];
  } catch {
    EXCLUDE = [];
  }
  return EXCLUDE;
}
// prettier-ignore
const excluded = (p) => treeExclude().some((d) => p === d || p.startsWith(`${d}/`));

const sh = (cmd) =>
  execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    // The default 1 MiB overflows (ENOBUFS) on a large unrelated diff.
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * The ref this branch's work is measured from: the merge-base with `main`
 * (or `origin/main`) when it exists, else HEAD. On `main` itself the two are
 * the same commit.
 */
export function baseRef(preferred) {
  for (const ref of [
    ...(preferred ? [preferred] : []),
    'main',
    'origin/main',
  ]) {
    try {
      return sh(`git merge-base ${ref} HEAD`).trim();
    } catch {
      /* ref missing: try the next one */
    }
  }
  return 'HEAD';
}

const nul = (cmd) => sh(cmd).split('\0').filter(Boolean);

export function untrackedFiles() {
  return nul('git ls-files -z --others --exclude-standard');
}

/**
 * Paths this branch changes: committed since the merge-base with main, plus
 * the working tree, plus untracked files. `base` overrides the merge-base.
 * `--no-renames` lists both sides of a rename; `-z` keeps odd names unquoted.
 */
export function changedPaths(base) {
  const ref = base ?? baseRef();
  const tracked = nul(`git diff -z --name-only --no-renames ${ref}`);
  return [...new Set([...tracked, ...untrackedFiles()])].sort();
}

const blobId = (bytes) =>
  createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');

function stateOf(path) {
  let st;
  try {
    st = lstatSync(join(ROOT, path));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return '-';
    throw err;
  }
  if (st.isSymbolicLink())
    return `120000 ${blobId(Buffer.from(readlinkSync(join(ROOT, path))))}`;
  if (st.isDirectory()) return 'd';
  const mode = st.mode & 0o111 ? '100755' : '100644';
  return `${mode} ${blobId(readFileSync(join(ROOT, path)))}`;
}

/**
 * Sorted (path, state) for every changed path outside the ticket docs. `base`
 * overrides the merge-base; `exclude` is a list of path prefixes ending `/`
 * that are left out as well (a project's registry data).
 */
export function treeEntries(base = baseRef(), { exclude = [] } = {}) {
  return changedPaths(base)
    .filter((p) => !excluded(p) && !exclude.some((x) => p.startsWith(x)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((p) => [p, stateOf(p)]);
}

function digest(entries) {
  const h = createHash('sha256');
  for (const [path, state] of entries) h.update(`${path}\0${state}\n`);
  return h.digest('hex');
}

export function treeHash({ exclude = [] } = {}) {
  return digest(treeEntries(baseRef(), { exclude }));
}

export const HISTORY_REL = '.turbo/ticket-verify-history.jsonl';

const gitZ = (args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean);

/**
 * Sorted [path, state] for `git diff -z --name-only --no-renames <base> <commit>`
 * outside the ticket docs, states read from <commit> (same strings as stateOf).
 */
export function treeEntriesAt(commit, base = baseRef()) {
  for (const ref of [commit, base])
    if (typeof ref !== 'string' || ref === '' || ref.startsWith('-'))
      throw new Error('treeHashAt: bad ref');
  // prettier-ignore
  const paths = gitZ(['diff', '-z', '--name-only', '--no-renames', base, commit]).filter((p) => !excluded(p));
  const states = new Map();
  for (const rec of gitZ(['ls-tree', '-r', '-t', '-z', commit])) {
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    states.set(rec.slice(tab + 1), type === 'blob' ? `${mode} ${oid}` : 'd');
  }
  return paths
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((p) => [p, states.get(p) ?? '-']);
}

/** digest(treeEntriesAt(commit, base)); equals treeHash() on a clean tree at HEAD. */
export function treeHashAt(commit, base = baseRef()) {
  return digest(treeEntriesAt(commit, base));
}

/**
 * Entries of the history file in file order. Missing file -> []. A blank line,
 * a line that is not JSON, or one without a string treeHash is skipped.
 */
export function readHistory(path = join(ROOT, HISTORY_REL)) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    if (raw.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue; // a corrupt line is skipped, never fatal
    }
    if (entry && typeof entry.treeHash === 'string') out.push(entry);
  }
  return out;
}

/**
 * sha of the commit that last changed line `line` (1-based) of working-tree
 * `file`; null when uncommitted, untracked, or on any git error.
 */
export function lineCommit(file, line) {
  try {
    const first = execFileSync(
      'git',
      ['blame', '--porcelain', '-L', `${line},${line}`, '--', file],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 512 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).split('\n')[0];
    const sha = /^([0-9a-f]{40}) /.exec(first)?.[1];
    if (!sha) return null;
    if (/^0{40}$/.test(sha)) return null;
    return sha;
  } catch {
    return null; // untracked file, or no git: never settled
  }
}
