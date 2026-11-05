import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

import { ROOT } from '../root.mjs';
import { treeHash } from '../tree.mjs';
import { projectSetup } from './project.mjs';

// jest, vitest and playwright match -t / -g against the FULL name (describe
// titles + test title), so a leading ^ selects nothing. node's pattern matches
// each level's own name and is exempt.
export const CARET_FILTER =
  /(?:^|\s)(?:-t|--testNamePattern|-g|--grep)(?:=|\s+)['"]?\^/;
export const CARET_HINT =
  '"test" filter starts with ^: jest and vitest -t (and playwright -g) match the full name (describe titles + test title), so a leading ^ selects no test; drop the ^';

export const KEY_RE = /^[A-Z][A-Za-z0-9-]*\/[A-Z]{1,2}\d+$/;
export const FILTER_RE =
  /(?:^|\s)(?:-t|--testNamePattern|-g|--grep|--test-name-pattern)(?:=|\s)|(?<=\bdeno test\b.*)\s--filter(?:=|\s)/;

/** Orders keys `<ID>/<Mn>`: digit runs numerically, everything else by code unit. */
export function compareKeys(a, b) {
  const parts = (k) => k.match(/\d+|\D+/g) ?? [];
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    const dx = /^\d/.test(x);
    const dy = /^\d/.test(y);
    if (dx && dy) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    return x < y ? -1 : 1;
  }
  return pa.length === pb.length ? 0 : pa.length < pb.length ? -1 : 1;
}

/** The repo-relative area file an entry belongs in: its kind's `area`, else the setup's. */
export function areaFor(entry, setup = projectSetup()) {
  const kind = setup.kinds.get(entry.kind);
  return kind?.area ? kind.area(entry, setup.dir) : setup.area(entry);
}

const lineOf = (text, needle) => {
  const i = text.indexOf(needle);
  return i === -1 ? 1 : text.slice(0, i).split('\n').length;
};

function walkJson(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkJson(p, out);
    else if (n.endsWith('.json')) out.push(p);
  }
  return out;
}

function addArea(entries, errors, rel, text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    errors.push(`${rel}: not valid JSON (${err.message})`);
    return;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(`${rel}: must be an object of { "<ID>/<Mn>": entry }`);
    return;
  }
  for (const [key, entry] of Object.entries(obj)) {
    if (entries.has(key)) {
      errors.push(
        `${rel}: duplicate key ${key} (also in ${entries.get(key).path})`,
      );
      continue;
    }
    entries.set(key, { path: rel, line: lineOf(text, `"${key}"`), entry });
  }
}

/** The registry in the working tree: { entries: Map<key, { path, line, entry }>, errors }. */
export function loadRegistry(root = ROOT, setup = projectSetup()) {
  const entries = new Map();
  const errors = [];
  for (const abs of walkJson(join(root, setup.dir))) {
    const rel = relative(root, abs);
    addArea(entries, errors, rel, readFileSync(abs, 'utf8'));
  }
  return { entries, errors };
}

const gitAt = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * The registry at a git ref. A ref without the registry folder is read by the
 * setup's `legacy` reader (when it has one).
 */
export function registryAt(ref, root = ROOT, setup = projectSetup()) {
  const entries = new Map();
  const errors = [];
  const ls = (pathspec) =>
    gitAt(root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', pathspec])
      .split('\0')
      .filter(Boolean);
  const show = (path) => gitAt(root, ['show', `${ref}:${path}`]);
  const areas = ls(setup.dir).filter((p) => p.endsWith('.json'));
  if (areas.length) {
    for (const p of areas) addArea(entries, errors, p, show(p));
    return { entries, errors };
  }
  return setup.legacy ? setup.legacy.atRef(ref, root) : { entries, errors };
}

/** [key, entry][] of `<ticket>/*`, in compareKeys order, retired entries included. */
export function entriesFor(registry, ticket) {
  return [...registry.entries]
    .filter(([k]) => k.startsWith(`${ticket}/`))
    .sort(([a], [b]) => compareKeys(a, b))
    .map(([k, v]) => [k, v.entry]);
}

/** The runnable spec for runMutations: live entries whose kind runs (no retired). */
export function toSpec(pairs, ticket, setup = projectSetup()) {
  return {
    ticket,
    mutations: pairs
      .filter(([, e]) => !e.retired && setup.kinds.get(e.kind)?.runs !== false)
      .map(([key, e]) => ({ id: key, ...e })),
  };
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

/** sha256 of the pairs with every object's keys sorted. */
export function entriesDigest(pairs) {
  return createHash('sha256')
    .update(JSON.stringify(sortKeysDeep(pairs)))
    .digest('hex');
}

/** The tree hash a ticket receipt binds: the registry folder is data, left out. */
export function ticketTreeHash(setup = projectSetup()) {
  return treeHash({ exclude: [`${setup.dir}/`] });
}

export { blockSpan, findPattern, locate, patchedSource } from './locate.mjs';
export { addArea };
