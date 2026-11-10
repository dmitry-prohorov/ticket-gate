import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isServed } from './served.mjs';
import { ROOT } from '../root.mjs';
import { baseRef } from '../tree.mjs';
import { patchKind } from './kinds.mjs';
import { projectSetup } from './project.mjs';
import { compareKeys, loadRegistry, locate, registryAt } from './registry.mjs';

/** Rule `guard`: a hunk this many lines (or fewer) from the `find` span selects. */
export const NEAR = 3;

const TITLE_RE = /^\s*(?:Deno\.)?(?:test|it|describe)(?:\.\w+)*\(/;
const indent = (line) => line.length - line.trimStart().length;

/**
 * `git diff -U0 --no-color` text -> Map<newPath, Array<[start, end]>> (1-based,
 * inclusive, new side). `+++ /dev/null` is skipped; a pure deletion `+c,0`
 * becomes [c, c+1] so both neighbours count.
 */
export function parseHunks(diffU0) {
  const out = new Map();
  let path = null;
  for (const line of String(diffU0).split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).split('\t')[0];
      path = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (path && !out.has(path)) out.set(path, []);
      continue;
    }
    if (line.startsWith('--- ') || path === null) continue;
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    const c = Number(m[1]);
    const d = m[2] === undefined ? 1 : Number(m[2]);
    out.get(path).push(d > 0 ? [c, c + d - 1] : [c, c + 1]);
  }
  return out;
}

/** `git diff -M --name-status` text -> [{ status: 'A'|'M'|'D'|'R', path, from? }]. */
export function parseNameStatus(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const s = cols[0][0];
    if (s === 'R' || s === 'C')
      out.push({ status: s === 'R' ? 'R' : 'A', path: cols[2], from: cols[1] });
    else out.push({ status: s, path: cols[1] });
  }
  return out;
}

/**
 * 1-based inclusive line ranges of every block whose title line contains
 * `testName` literally: from that line to the line before the next line at the
 * same or lower indentation that opens a test, else to EOF.
 */
export function testBlocks(source, testName) {
  const lines = String(source).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(testName)) continue;
    // prettier may put the title on the line after `test(`
    const s =
      !TITLE_RE.test(lines[i]) && TITLE_RE.test(lines[i - 1] ?? '') ? i - 1 : i;
    const own = indent(lines[s]);
    let end = lines.length;
    for (let j = s + 1; j < lines.length; j++) {
      if (indent(lines[j]) <= own && TITLE_RE.test(lines[j])) break;
      end = j + 1;
    }
    out.push([s + 1, end]);
  }
  return out;
}

const overlaps = (hunks, path, lo, hi) =>
  (hunks.get(path) ?? []).some(([hs, he]) => hs <= hi && he >= lo);

const lineAt = (src, offset) => src.slice(0, offset).split('\n').length;

function nearGuard(ctx, key, rec) {
  const e = rec.entry;
  if (e.kind !== 'patch' || !ctx.hunks.has(e.file)) return false;
  const src = ctx.readFile(e.file);
  if (src === null) return false;
  const hit = locate(src, e.find, e.within);
  if (hit.count !== 1) return false;
  const start = lineAt(src, hit.index);
  const end = lineAt(src, hit.index + Math.max(hit.length - 1, 0));
  return overlaps(ctx.hunks, e.file, start - NEAR, end + NEAR);
}

function inTestBlock(ctx, key, rec) {
  const e = rec.entry;
  if (!e.testFile || !ctx.hunks.has(e.testFile)) return false;
  if (!e.testName) return true;
  const src = ctx.readFile(e.testFile);
  if (src === null) return false;
  return testBlocks(src, e.testName).some(([lo, hi]) =>
    overlaps(ctx.hunks, e.testFile, lo, hi),
  );
}

const sortKeysDeep = (v) =>
  Array.isArray(v)
    ? v.map(sortKeysDeep)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeysDeep(v[k])]),
        )
      : v;
// The selection compares only what changes the run: an area move, a new `protects`,
// `testName` or `reaimed` item leaves the mutation and its test as they were.
// The fields are the kind's `runFields`, behind `kind` itself.
export const RUN_FIELDS = Object.freeze(['kind', ...patchKind.runFields]);
const canon = (entry, setup) => {
  const fields = setup.kinds.get(entry.kind)?.runFields ?? patchKind.runFields;
  return JSON.stringify(
    sortKeysDeep(
      Object.fromEntries(['kind', ...fields].map((f) => [f, entry[f] ?? null])),
    ),
  );
};

function entryChanged(ctx, key, rec) {
  return (
    canon(rec.entry, ctx.setup) !==
    canon(ctx.baseEntries.get(key).entry, ctx.setup)
  );
}

function pathMoved(ctx, key, rec) {
  const now = [rec.entry.file, rec.entry.testFile];
  const was = ctx.baseEntries.get(key).entry;
  return (
    now.some((p) => p && ctx.added.has(p)) ||
    [was.file, was.testFile].some((p) => p && ctx.gone.has(p))
  );
}

/** The selection rules in order: guard, test, entry, each kind's `selectRules`, moved. */
export const rulesOf = (setup) => [
  ['guard', nearGuard],
  ['test', inTestBlock],
  ['entry', entryChanged],
  ...[...setup.kinds.values()].flatMap((k) => k.selectRules ?? []),
  ['moved', pathMoved],
];

/**
 * Pure. entries/baseEntries: loadRegistry shape Map<key, { path, line, entry }>;
 * hunks: parseHunks output; statuses: parseNameStatus output plus untracked
 * files as 'A'; readFile(path) -> string | null (the working tree).
 * Returns [{ key, rules }] sorted by key; a key is in it iff >= 1 rule holds.
 */
export function selectEntries(
  { entries, baseEntries, hunks, statuses, readFile },
  setup = projectSetup(),
) {
  const rules = rulesOf(setup);
  const ctx = {
    setup,
    baseEntries,
    hunks,
    readFile,
    changed: new Set([...hunks.keys(), ...statuses.map((s) => s.path)]),
    added: new Set(
      statuses
        .filter((s) => s.status === 'A' || s.status === 'R')
        .map((s) => s.path),
    ),
    gone: new Set(
      statuses.flatMap((s) =>
        s.status === 'D' ? [s.path] : s.status === 'R' ? [s.from] : [],
      ),
    ),
  };
  const out = [];
  for (const key of [...entries.keys()].sort(compareKeys)) {
    const rec = entries.get(key);
    if (!baseEntries.has(key)) continue;
    if (rec.entry.retired) continue;
    if (setup.kinds.get(rec.entry.kind)?.runs === false) continue;
    const held = rules.filter(([, fn]) => fn(ctx, key, rec)).map(([n]) => n);
    if (held.length) out.push({ key, rules: held });
  }
  return out;
}

/**
 * The ticket gate runs only the entries that need no `next build`: a selected
 * Playwright-backed entry (`isServed`) is left to the nightly rotation (tools/nightly-e2e.mjs
 * `runMutationPhase` runs every live entry, `rotationOrder`). Pure.
 * `selection`: selectChanged output; `entries`: loadRegistry shape.
 * Returns { run, deferred }, both [{ key, rules }] in selection order.
 */
/** The live registry entries (loadRegistry shape), for callers that must not read the registry themselves (step-inputs SI-R2). */
export const registryEntries = (root = ROOT, setup = projectSetup()) =>
  loadRegistry(root, setup).entries;

/** The registry entries at a git ref (same reason as registryEntries; used by the precheck). */
export const registryEntriesAt = (ref, root = ROOT, setup = projectSetup()) =>
  registryAt(ref, root, setup).entries;

export function splitServed(selection, entries, setup = projectSetup()) {
  const run = [];
  const deferred = [];
  for (const s of selection) {
    const e = entries.get(s.key)?.entry;
    (e && isServed(e, setup) ? deferred : run).push(s);
  }
  return { run, deferred };
}

const git = (root, args) =>
  execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * The I/O edge: diffs the WORKING TREE against `base` (tracked changes plus
 * untracked files, as tree-hash.changedPaths does) and selects against the
 * registry in the tree and at `base`. Throws on an invalid registry.
 */
export function selectChanged(
  { base, root = ROOT } = {},
  setup = projectSetup(),
) {
  const ref = base || baseRef();
  const reg = loadRegistry(root, setup);
  if (reg.errors.length)
    throw new Error(`registry invalid: ${reg.errors.join('; ')}`);
  const baseReg = registryAt(ref, root, setup);
  const hunks = parseHunks(
    git(root, ['diff', '-U0', '--no-color', '-M', ref, '--']),
  );
  const statuses = parseNameStatus(
    git(root, ['diff', '-M', '--name-status', ref, '--']),
  );
  const readFile = (p) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return null;
    }
  };
  const untracked = git(root, [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
  ])
    .split('\0')
    .filter(Boolean);
  for (const p of untracked) {
    statuses.push({ status: 'A', path: p });
    const src = readFile(p);
    if (src !== null) hunks.set(p, [[1, Math.max(src.split('\n').length, 1)]]);
  }
  return selectEntries(
    {
      entries: reg.entries,
      baseEntries: baseReg.entries,
      hunks,
      statuses,
      readFile,
    },
    setup,
  );
}

/**
 * For tech-lead: live entries whose `file` or `testFile` equals a listed path or
 * lies under a listed path ending `/`; sql entries whose snapshot is a listed path.
 * [{ key, path, protects }] sorted by key.
 */
export function affected(paths, entries, setup = projectSetup()) {
  const hit = (p) =>
    paths.some((q) => (q.endsWith('/') ? p.startsWith(q) : p === q));
  const out = [];
  for (const key of [...entries.keys()].sort(compareKeys)) {
    const { entry: e } = entries.get(key);
    const kind = setup.kinds.get(e.kind);
    if (e.retired || kind?.runs === false) continue;
    const path = [e.file, e.testFile, ...(kind?.paths?.(e) ?? [])].find(
      (p) => p && hit(p),
    );
    if (path) out.push({ key, path, protects: e.protects ?? '' });
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (n) =>
    args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  if (args.includes('--affected')) {
    const paths = flag('paths')?.split(',').filter(Boolean);
    if (!paths) {
      console.error(
        'mutation-select: --affected needs --paths=<a,b,...> (the files your ticket changes; end a folder with /)',
      );
      process.exit(2);
    }
    const rows = affected(paths, loadRegistry().entries);
    for (const r of rows) console.log(`${r.key}  ${r.path}  ${r.protects}`);
    console.log(`mutations:affected: ${rows.length} entries`);
    return;
  }
  const all = selectChanged({ base: flag('base') });
  const reg = loadRegistry().entries;
  const defer = args.includes('--defer-playwright');
  const { run, deferred } = splitServed(all, reg);
  const sel = defer ? run : all;
  for (const s of sel) console.log(`${s.key}  ${s.rules.join(',')}`);
  console.log(
    defer
      ? `mutation-select: ${sel.length} selected (${deferred.length} playwright deferred to the nightly)`
      : `mutation-select: ${sel.length} selected (${deferred.length} playwright)`,
  );
}

export { main };
