// Review map: puts every path this branch changes in exactly one tier, so a
// person knows which files they must read line by line.
//
//   HUMAN    a person reads every line (auth, RLS, migrations, secrets, invites,
//            dependencies, and anything no rule recognises)
//   GATED    a person reads only what a gate flags (non-test core and lib logic)
//   MACHINE  gates only; a person spot-checks at most (UI, tests, docs, generated)
//
// Rules are evaluated in order and the first match wins, so every HUMAN row sits
// above every other row: HUMAN beats everything. A path no row matches is HUMAN
// (row D), because an unclassified file is one nobody decided could be skipped.
//
// The same walk measures the diff size (SIZE_EXCLUDED rows are left out) that
// `verify:ticket` warns about above SIZE_WARN and records as `oversize` above
// SIZE_OVERSIZE; the Stop hook enforces the latter.
//
// H11 sits after H10: a diff that adds a lint, type, compiler or mutation
// suppression (SUPPRESSION) is HUMAN, unless the path is CONTENT_EXEMPT. Only
// added lines count; the first matching row wins, so H1..H10 keep their reason.
//
// H1 (a migration) stays HUMAN, but its reason lists the line ranges outside
// every `create [or replace] function` statement (migrationReadRanges): a changed
// function body is read in its supabase/schema/functions/ file, where the diff is
// the change. A migration the parser cannot split reads whole (no ranges).
//
//   node review-map.mjs [--base=<sha>] [--full]
//       print the map, write .turbo/review-map.json. MACHINE prints as a count
//       line; --full lists every MACHINE path.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GATE as config, CONFIG_EXPORTS as project } from './project.mjs';
import { globRe } from './config.mjs';
import { packHook } from './pack-hooks.mjs';
import { ROOT } from './root.mjs';
import { baseRef } from './tree.mjs';

// The suppression and registry-retirement rows are the project's: a config that exports
// none of them has no H11/H12 row and these stay inert.
export const SUPPRESSION = project.SUPPRESSION ?? /(?!)/;
export const suppressionLines = project.suppressionLines ?? (() => []);
export const registryChanges = project.registryChanges ?? (() => []);
export { ROOT };
// SQL read ranges are a pack hook (sqlRanges); without one a migration reads whole.
export const migrationReadRanges = (text, inSnapshot) =>
  packHook('sqlRanges')?.migrationReadRanges?.(text, inSnapshot) ?? null;
const migrationFacts = (path, root) =>
  packHook('sqlRanges')?.migrationFacts?.(path, root) ?? {
    text: null,
    inSnapshot: undefined,
  };
const H1_REASON = (fmt) => packHook('sqlRanges').H1_REASON(fmt);

// The rules, size thresholds and size exclusions live in gate.config.mjs
// (reviewMap); the names below are kept for the callers that import them.
export const RULES = config.reviewMap.rules;
export const SIZE_EXCLUDED = config.reviewMap.sizeExcluded;
export const SIZE_WARN = config.reviewMap.warn;
export const SIZE_OVERSIZE = config.reviewMap.oversize;
export const HUMAN_LINES = config.reviewMap.humanLines ?? [];
export const GATED_LABEL = 'GATED (core logic: mutation gate)';

const UNCLASSIFIED = {
  id: '-',
  tier: 'HUMAN',
  reason: 'unclassified: no rule matched',
};

export function classify(f) {
  // A config with no catch-all row still puts every path in a tier: HUMAN, unread otherwise.
  const row = RULES.find((r) => r.match(f)) ?? UNCLASSIFIED;
  if (row.id === 'H12')
    return {
      tier: row.tier,
      rule: row.id,
      reason: `${row.reason}: ${registryChanges(f)
        .map((c) => `${c.key} (${c.base ? 'base line' : 'line'} ${c.line})`)
        .join(', ')}`,
    };
  if (row.id === 'H11')
    return {
      tier: row.tier,
      rule: row.id,
      reason: `${row.reason}: lines ${suppressionLines(f).join(', ')}`,
    };
  const ranges =
    row.id === 'H1' && typeof f.text === 'string'
      ? migrationReadRanges(f.text, f.inSnapshot)
      : null;
  if (ranges) {
    const fmt = ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
    return {
      tier: row.tier,
      rule: row.id,
      reason: `${row.reason}: ${H1_REASON(fmt)}`,
      ranges,
    };
  }
  return { tier: row.tier, rule: row.id, reason: row.reason };
}

export function excludedFromSize(path) {
  const probe = { path, lines: [], depsChanged: false };
  return SIZE_EXCLUDED.some((id) =>
    /[/*]/.test(id)
      ? globRe(id).test(path)
      : RULES.find((r) => r.id === id).match(probe),
  );
}

const hitPath = (match, path) =>
  typeof match === 'string' ? globRe(match).test(path) : match.test(path);

/** The `line`s whose `match` (a glob or a RegExp) hits a changed path, once each, in config order. */
export function humanLinesFor(humanLines, paths) {
  return [
    ...new Set(
      humanLines
        .filter((h) => paths.some((p) => hitPath(h.match, p)))
        .map((h) => h.line),
    ),
  ];
}

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const stable = (v) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(v ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  );

/** True when any dependency field differs; missing and `{}` are equal; bad JSON is true. */
export function depsChanged(beforeJson, afterJson) {
  let before;
  let after;
  try {
    before = beforeJson === null ? {} : JSON.parse(beforeJson);
    after = afterJson === null ? {} : JSON.parse(afterJson);
  } catch {
    return true;
  }
  return DEP_FIELDS.some((k) => stable(before?.[k]) !== stable(after?.[k]));
}

export function sizeLevel(lines) {
  if (lines > SIZE_OVERSIZE) return 'oversize';
  if (lines > SIZE_WARN) return 'warn';
  return 'ok';
}

const git = (root, args) =>
  execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const readOrNull = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

/** Pure parse of `git diff -U0 --no-renames --no-color` output.
 *  Map<path, { lines, addedLines }>; the new-file counter starts at the `+c` of
 *  each `@@ -a[,b] +c[,d] @@` header and advances on '+' and ' ' lines only. */
export function parseUnifiedDiff(text) {
  const out = new Map();
  let current = null;
  let inHunk = false;
  let next = 0;
  for (const l of text.split('\n')) {
    const header = /^diff --git a\/(.+) b\/\1$/.exec(l);
    if (header) {
      current = header[1];
      inHunk = false;
      out.set(current, { lines: [], addedLines: [] });
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) {
      inHunk = true;
      next = Number(hunk[1]);
    } else if (inHunk && current) {
      const rec = out.get(current);
      if (l.startsWith('+')) {
        rec.lines.push(l.slice(1));
        rec.addedLines.push({ line: next, text: l.slice(1) });
        next += 1;
      } else if (l.startsWith('-')) rec.lines.push(l.slice(1));
      else if (l.startsWith(' ')) next += 1;
    }
  }
  return out;
}

/** Per changed path: added, removed, the diff lines, and whether dependencies changed. */
export function collect(base, root = ROOT) {
  const tracked = git(root, ['diff', '-z', '--name-only', '--no-renames', base])
    .split('\0')
    .filter(Boolean);
  const untracked = git(root, [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
  ])
    .split('\0')
    .filter(Boolean);
  const stats = new Map();
  for (const rec of git(root, ['diff', '--numstat', '-z', '--no-renames', base])
    .split('\0')
    .filter(Boolean)) {
    const [a, r, ...rest] = rec.split('\t');
    stats.set(rest.join('\t'), {
      added: Number(a) || 0,
      removed: Number(r) || 0,
    });
  }
  const diffs = parseUnifiedDiff(
    git(root, ['diff', '-U0', '--no-renames', '--no-color', base]),
  );
  const isRegistryFile = (p) => config.registryFile?.(p) === true;
  const paths = [...new Set([...tracked, ...untracked])].sort();
  let baseReg = null;
  let treeReg = null;
  if (paths.some(isRegistryFile)) {
    const reg = packHook('registry');
    baseReg = reg?.at?.(base, root).entries ?? new Map();
    treeReg = reg?.load?.(root).entries ?? new Map();
  }
  const registryOf = (path) => {
    const retired = [];
    const removed = [];
    for (const [key, v] of treeReg) {
      if (v.path !== path || !v.entry.retired) continue;
      if (!baseReg.get(key)?.entry.retired) retired.push({ key, line: v.line });
    }
    for (const [key, v] of baseReg)
      if (v.path === path && !treeReg.has(key))
        removed.push({ key, line: v.line });
    return { retired, removed };
  };
  return paths.map((path) => {
    let added = 0;
    let removed = 0;
    let lines = [];
    let addedLines = [];
    if (stats.has(path)) ({ added, removed } = stats.get(path));
    else if (untracked.includes(path)) {
      const buf = readOrNull(() => readFileSync(join(root, path)));
      if (buf && !buf.subarray(0, 8000).includes(0)) {
        const text = buf.toString('utf8');
        lines = text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        added = lines.length;
        addedLines = lines.map((text, i) => ({ line: i + 1, text }));
      }
    }
    if (diffs.has(path)) ({ lines, addedLines } = diffs.get(path));
    const deps =
      basename(path) === 'package.json'
        ? depsChanged(
            readOrNull(() => git(root, ['show', `${base}:${path}`])),
            readOrNull(() => readFileSync(join(root, path), 'utf8')),
          )
        : false;
    const { text = null, inSnapshot } = migrationFacts(path, root);
    return {
      path,
      ...(isRegistryFile(path) ? { registry: registryOf(path) } : {}),
      added,
      removed,
      lines,
      addedLines,
      depsChanged: deps,
      text,
      inSnapshot,
    };
  });
}

const empty = () => ({ files: 0, lines: 0 });

export function buildMap(files, base) {
  const totals = { HUMAN: empty(), GATED: empty(), MACHINE: empty() };
  let size = 0;
  const out = files
    .map((f) => {
      const { tier, rule, reason, ranges } = classify(f);
      const n = f.added + f.removed;
      totals[tier].files += 1;
      totals[tier].lines += n;
      if (!excludedFromSize(f.path)) size += n;
      return {
        path: f.path,
        tier,
        rule,
        reason,
        added: f.added,
        removed: f.removed,
        ...(ranges ? { ranges } : {}),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    base,
    generatedAt: new Date().toISOString(),
    files: out,
    human: humanLinesFor(
      HUMAN_LINES,
      out.map((f) => f.path),
    ),
    totals,
    size: {
      lines: size,
      level: sizeLevel(size),
      warn: SIZE_WARN,
      oversize: SIZE_OVERSIZE,
    },
  };
}

// `collect` lists paths itself rather than through tree-hash's changedPaths,
// which is bound to this repo's ROOT: RM-G1 runs it against a tmp repo.
export function reviewMap(base, root = ROOT) {
  const ref = base ?? baseRef();
  const full = git(root, ['rev-parse', ref]).trim();
  return buildMap(collect(ref, root), full);
}

const item = (f) =>
  `- \`${f.path}\` +${f.added} -${f.removed} - ${f.rule} ${f.reason}`;

/** machine: 'count' (default) | 'full'. */
export function renderMarkdown(map, { machine = 'count' } = {}) {
  const section = (tier, title, blurb, folded) => {
    const rows = map.files.filter((f) => f.tier === tier);
    const head = `**${title}** - ${blurb}`;
    if (rows.length === 0) return [head, '- none', ''];
    if (!folded) return [head, ...rows.map(item), ''];
    return [
      head,
      `<details><summary>${rows.length} files</summary>`,
      '',
      ...rows.map(item),
      '</details>',
      '',
    ];
  };
  const t = map.totals;
  const part = (label, x) => `${label}: ${x.files} files, ${x.lines} lines.`;
  return [
    `#### Review map (base ${map.base.slice(0, 7)})`,
    '',
    ...section('HUMAN', 'HUMAN', 'a person reads every line', false),
    ...section(
      'GATED',
      GATED_LABEL,
      'a person reads only what a gate flags',
      true,
    ),
    ...(machine === 'full'
      ? section(
          'MACHINE',
          'MACHINE',
          'gates only; a person spot-checks at most',
          true,
        )
      : [
          '**MACHINE** - gates only; a person spot-checks at most',
          `Machine: ${t.MACHINE.files} files, ${t.MACHINE.lines} lines (full list: .turbo/review-map.json)`,
          '',
        ]),
    `${part('Human review', t.HUMAN)} ${part('Gated', t.GATED)} ${part('Machine', t.MACHINE)}`,
    ...(map.human?.length
      ? ['', 'Human steps:', ...map.human.map((l) => `- ${l}`)]
      : []),
  ].join('\n');
}

export function renderSizeLine(size, { color = false } = {}) {
  const L = size.lines;
  const lines = [
    `Size: ${L} changed lines (tests, e2e, .maestro, docs, db.types.ts, lockfile and i18n tables excluded).`,
  ];
  const level = sizeLevel(L);
  if (level === 'warn' || level === 'oversize') {
    if (level === 'warn')
      lines.push(
        `WARNING: ${L} > ${SIZE_WARN} changed lines: split candidate (${config.reviewMap.splitHint}).`,
      );
    else {
      const o = `OVERSIZE: ${L} > ${SIZE_OVERSIZE} changed lines: the DoD gate blocks unless contracts/<ID>.md section 1 has an "oversize-accepted: <reason>" line.`;
      lines.push(color ? `\x1b[31m${o}\x1b[0m` : o);
    }
  }
  return lines.join('\n');
}

/** Writes the JSON half of the map to <root>/.turbo/review-map.json. */
export function writeMap(map, root = ROOT) {
  const file = join(root, '.turbo', 'review-map.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(map, null, 2));
  return file;
}

export function main(args = process.argv.slice(2)) {
  const base = args
    .find((a) => a.startsWith('--base='))
    ?.slice('--base='.length);
  const map = reviewMap(base);
  writeMap(map);
  console.log(
    renderMarkdown(map, {
      machine: args.includes('--full') ? 'full' : 'count',
    }),
  );
  console.log('');
  console.log(renderSizeLine(map.size, { color: process.stdout.isTTY }));
}
