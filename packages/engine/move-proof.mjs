// Move proof for move-only tickets. Usage: <moveCheck command> [--base=REF]
//
// Compares the lines a branch adds with the lines it removes, outside tests,
// docs and generated files (excludedFromSize in tools/gate/review-map.mjs). Every
// added line must match a removed line (a multiset: one removed line pays for
// one added line), after trimming and dropping a leading `export `. Blank lines
// and import or re-export statements are exempt. `unmatched` is the count that
// does not match: 0 means the diff only moved code. the Stop hook
// reads it from the receipt for a contract's `oversize-accepted: move-only`.
//
// Exit: 0 when nothing is unmatched, 1 when something is, 2 on a bad flag or
// a git error. Dependency-free: node and git only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COMMANDS } from './config.mjs';
import { excludedFromSize } from './review-map.mjs';
import { ROOT } from './root.mjs';
import { baseRef } from './tree.mjs';

const git = (root, args) =>
  execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });

/** Trim; strip a leading `export ` unless it opens a re-export (`export {`, `export *`). */
export function normalise(text) {
  return text.trim().replace(/^export (?![{*])/, '');
}

export const IMPORT_START =
  /^(?:import(?:\s+|\s*[{'"*])|export\s*(?:type\s+)?[{*])/;

/** Only JS/TS has import statements; every line of any other file is code. */
export const JS_FILE = /\.(?:[cm]?[jt]sx?|mts|cts)$/;

/** 1-based numbers of every line inside an import or re-export statement. */
export function importLineNumbers(lines) {
  const inside = new Set();
  let open = false;
  lines.forEach((raw, i) => {
    const t = raw.trim().replace(/(['"`;])\s*\/\/.*$/, '$1');
    if (!open && !IMPORT_START.test(t)) return;
    open = true;
    inside.add(i + 1);
    if (
      /;$/.test(t) ||
      /from\s*['"][^'"]+['"]$/.test(t) ||
      /^import\s*['"][^'"]+['"]$/.test(t)
    )
      open = false;
  });
  return inside;
}

/** Multiset match: the added entries no removed line pays for, in input order. */
export function matchMoves(added, removed) {
  const pool = new Map();
  for (const r of removed) {
    const key = normalise(r);
    pool.set(key, (pool.get(key) ?? 0) + 1);
  }
  const unmatched = [];
  for (const a of added) {
    const key = normalise(a.text);
    const left = pool.get(key) ?? 0;
    if (left === 0) unmatched.push(a);
    else pool.set(key, left - 1);
  }
  return unmatched;
}

/** Added `{path, line, text}` and removed `{path, line, text}` from a -U0 diff. */
function parseDiff(diff) {
  const added = [];
  const removed = [];
  let oldPath = null;
  let newPath = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) {
      inHunk = false;
      oldPath = newPath = null;
    } else if (!inHunk && l.startsWith('--- ')) {
      oldPath = l === '--- /dev/null' ? null : l.slice(6);
    } else if (!inHunk && l.startsWith('+++ ')) {
      newPath = l === '+++ /dev/null' ? null : l.slice(6);
    } else if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
        inHunk = true;
      }
    } else if (inHunk && l.startsWith('+') && newPath) {
      added.push({ path: newPath, line: newLine++, text: l.slice(1) });
    } else if (inHunk && l.startsWith('-') && oldPath) {
      removed.push({ path: oldPath, line: oldLine++, text: l.slice(1) });
    }
  }
  return { added, removed };
}

const isBinary = (text) => text.includes('\0');

/**
 * Full proof over `git diff -U0` (base to working tree) plus untracked files.
 * Import statements are classified against the whole file, never hunk text.
 */
export function moveProof(base, root = ROOT) {
  const { added: diffAdded, removed: diffRemoved } = parseDiff(
    git(root, ['diff', '-U0', '--no-renames', '--no-color', base]),
  );
  const untracked = git(root, [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
  ])
    .split('\0')
    .filter(Boolean);
  const counted = (e) => !excludedFromSize(e.path);
  const memo = new Map();
  const imports = (key, load) => {
    if (!memo.has(key)) {
      let text = '';
      try {
        text = load();
      } catch {
        /* file gone or unreadable: nothing exempt */
      }
      const path = key.slice(key.indexOf(':') + 1);
      memo.set(
        key,
        JS_FILE.test(path) ? importLineNumbers(text.split('\n')) : new Set(),
      );
    }
    return memo.get(key);
  };
  const keep = (e, set) => e.text.trim() !== '' && !set.has(e.line);
  const added = diffAdded.filter(counted).filter((e) =>
    keep(
      e,
      imports(`w:${e.path}`, () => readFileSync(join(root, e.path), 'utf8')),
    ),
  );
  for (const path of untracked.filter((p) => !excludedFromSize(p))) {
    let text;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue;
    }
    if (isBinary(text)) continue;
    const set = imports(`w:${path}`, () => text);
    text.split('\n').forEach((t, i) => {
      const e = { path, line: i + 1, text: t };
      if (keep(e, set)) added.push(e);
    });
  }
  const removed = diffRemoved
    .filter(counted)
    .filter((e) =>
      keep(
        e,
        imports(`b:${e.path}`, () => git(root, ['show', `${base}:${e.path}`])),
      ),
    )
    .map((e) => e.text);
  const lines = matchMoves(added, removed).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line,
  );
  return { unmatched: lines.length, base, lines };
}

/** The CLI body; `moveCheck` is the project's `commands.moveCheck`, named in the usage line. */
export function main({
  moveCheck = DEFAULT_COMMANDS.moveCheck,
  args = process.argv.slice(2),
} = {}) {
  const stray = args.find((a) => !a.startsWith('--base='));
  if (stray) {
    console.error(
      `${moveCheck.split(' ').pop()}: unknown argument ${stray}. Usage: ${moveCheck} [--base=REF]`,
    );
    process.exit(2);
  }
  const baseArg = args[0]?.slice('--base='.length);
  let proof;
  try {
    proof = moveProof(baseArg || baseRef());
  } catch (e) {
    console.error(
      `move:check: ${e.message.split('\n')[0]}. Check the ref with \`git rev-parse <ref>\` and pass --base=<ref>.`,
    );
    process.exit(2);
  }
  for (const l of proof.lines)
    console.log(`${l.path}:${l.line}  ${l.text.trim()}`);
  console.log(`unmatched: ${proof.unmatched}`);
  process.exit(proof.unmatched === 0 ? 0 : 1);
}
