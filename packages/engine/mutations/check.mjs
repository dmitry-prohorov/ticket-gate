import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import {
  CARET_FILTER,
  CARET_HINT,
  FILTER_RE,
  KEY_RE,
  areaFor,
  compareKeys,
  loadRegistry,
  locate,
  registryAt,
} from './registry.mjs';
import { ROOT } from '../root.mjs';
import { checkProtects } from './kinds.mjs';
import { projectSetup } from './project.mjs';

export const PROBLEM_KINDS = [
  'stale',
  'misfiled',
  'unsorted',
  'vanished',
  'retired',
  'duplicate',
  'shape',
  'legacy',
];

const isStr = (v) => typeof v === 'string' && v !== '';
const git = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function readText(root, rel) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

/** A readFile for a kind's shape and stale rules: the text of a repo file, throwing when it is missing. */
const readerOf = (root) => (rel) => {
  const text = readText(root, rel);
  if (text === null) throw new Error(`${rel} does not exist`);
  return text;
};

export function ticketFromBranch(branch) {
  const m = /^[a-z]+\/([A-Z][A-Z0-9]*(?:-\d+[a-z0-9]*)?)(?=-|$)/.exec(
    branch ?? '',
  );
  return m ? m[1] : null;
}

/** An area file's bytes: keys in compareKeys order, fields in `setup.fieldOrder`. */
export function serializeArea(obj, setup = projectSetup()) {
  const order = setup.fieldOrder;
  const rank = (f) => {
    const i = order.indexOf(f);
    return i === -1 ? order.length : i;
  };
  const sorted = {};
  for (const key of Object.keys(obj).sort(compareKeys)) {
    const e = obj[key];
    sorted[key] =
      e && typeof e === 'object' && !Array.isArray(e)
        ? Object.fromEntries(
            Object.keys(e)
              .sort((a, b) => rank(a) - rank(b))
              .map((f) => [f, e[f]]),
          )
        : e;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function resolveBase(root, base) {
  const ref = base ?? git(root, ['merge-base', 'main', 'HEAD']).trim();
  return git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

function safeAreaFor(entry, setup) {
  try {
    return areaFor(entry, setup);
  } catch {
    return null;
  }
}

/** Why an entry's shape is wrong, one string each. */
function shapeReasons(key, e, keys, root, setup) {
  const out = [];
  if (!KEY_RE.test(key)) out.push('key must look like <ID>/<Mn>');
  if (!e || typeof e !== 'object' || Array.isArray(e))
    return [...out, 'entry must be an object'];
  const kind = setup.kinds.get(e.kind);
  if (!kind) {
    const names = [...setup.kinds.keys()];
    return [
      ...out,
      `kind must be ${names.slice(0, -1).join(', ')} or ${names.at(-1)}`,
    ];
  }
  out.push(...kind.shape(e, readerOf(root)));
  if (kind.runs && isStr(e.protects)) {
    const why = checkProtects(e.protects);
    if (why) out.push(why);
  }
  if (kind.runs && isStr(e.test)) {
    if (CARET_FILTER.test(e.test)) out.push(CARET_HINT);
    const filtering = FILTER_RE.test(e.test);
    if (filtering && !isStr(e.testName))
      out.push('testName is required because test filters by name');
    if (!filtering && e.testName !== undefined)
      out.push('testName is set but test has no name filter');
  }
  for (const k of setup.kinds.values()) out.push(...(k.strays?.(e) ?? []));
  if (
    e.retired &&
    typeof e.retired === 'object' &&
    e.retired.supersededBy !== undefined &&
    !keys.has(e.retired.supersededBy)
  )
    out.push(`retired.supersededBy ${e.retired.supersededBy} is not a key`);
  if (e.reaimed !== undefined) {
    if (
      !Array.isArray(e.reaimed) ||
      e.reaimed.some((r) => !isStr(r?.by) || !isStr(r?.why))
    )
      out.push('reaimed must be a list of { by, why }');
  }
  return out;
}

/** A patch entry whose file is gone or whose find does not occur exactly once. Checked for new keys too once their file exists (ten dead finds once reached review). */
function findReasons(root, entry, { fileOptional = false } = {}) {
  const out = [];
  if (entry.kind === 'patch' && isStr(entry.file) && isStr(entry.find)) {
    const src = readText(root, entry.file);
    // A new key may name a file a later slice of its ticket adds (CM-10).
    if (src === null && fileOptional) return out;
    if (src === null) out.push(`file ${entry.file} does not exist`);
    else {
      const hit = locate(src, entry.find, entry.within);
      if (hit.anchorCount !== undefined)
        out.push(
          `within anchor occurs ${hit.anchorCount} times in ${entry.file}`,
        );
      else if (hit.count !== 1)
        out.push(`find occurs ${hit.count} times in ${entry.file}`);
    }
  }
  return out;
}

/** Full-check failures of a live entry, one string each (no key prefix). */
function staleReasons(root, entry, setup) {
  const out = findReasons(root, entry);
  const kind = setup.kinds.get(entry.kind);
  if (kind?.runs && isStr(entry.testFile)) {
    const testText = readText(root, entry.testFile);
    if (testText === null)
      out.push(`testFile ${entry.testFile} does not exist`);
    else if (isStr(entry.testName)) {
      if (!testText.includes(entry.testName))
        out.push(`testName "${entry.testName}" not found in ${entry.testFile}`);
    }
  }
  if (kind?.stale) out.push(...kind.stale(entry, readerOf(root)));
  return out;
}

const STALE_TAIL = ' - re-aim (file/find/within) or retire with a citation';

export function checkRegistry(opts, setup = projectSetup()) {
  const root = opts?.root ?? ROOT;
  let baseSha;
  try {
    baseSha = resolveBase(root, opts?.base);
  } catch (err) {
    return {
      code: 2,
      lines: [
        `check:mutations: cannot resolve the base (${String(err.message).split('\n')[0]}); pass --base=<sha>`,
      ],
      problems: [],
    };
  }
  const reg = loadRegistry(root, setup);
  const baseReg = registryAt(baseSha, root, setup);
  const isNew = (key) => !baseReg.entries.has(key);
  const problems = [];
  const lines = [];
  const report = (kind, key, path, text) => {
    problems.push({ kind, key, path, line: 0 });
    lines.push(`${kind}: ${text}`);
  };

  for (const err of reg.errors) {
    const dup = /^(.+): duplicate key (\S+) \(also in (.+)\)$/.exec(err);
    if (dup)
      report(
        'duplicate',
        dup[2],
        dup[1],
        `${dup[2]} in ${dup[3]} and ${dup[1]}`,
      );
    else report('shape', err, err.split(':')[0], err);
  }

  const keys = new Set(reg.entries.keys());
  const perFile = new Map();
  for (const [key, { path, entry }] of reg.entries) {
    perFile.set(path, [...(perFile.get(path) ?? []), key]);
    for (const why of shapeReasons(key, entry, keys, root, setup))
      report('shape', key, path, `${key} ${why}`);
    const ok = entry && typeof entry === 'object';
    if (
      ok &&
      entry.retired !== undefined &&
      !(isStr(entry.retired?.by) && isStr(entry.retired?.why))
    )
      report('retired', key, path, `${key} needs retired.by and retired.why`);
    const want = ok ? safeAreaFor(entry, setup) : null;
    if (want && want !== path)
      report('misfiled', key, path, `${key} in ${path} - move to ${want}`);
    // A new key is shape-checked, plus its find must occur once in a file that exists.
    if (isNew(key) && ok && !entry.retired)
      for (const why of findReasons(root, entry, { fileOptional: true }))
        report('stale', key, path, `${key} ${why}${STALE_TAIL}`);
    if (isNew(key)) continue;
    if (!ok || entry.retired) continue;
    for (const why of staleReasons(root, entry, setup))
      report('stale', key, path, `${key} ${why}${STALE_TAIL}`);
  }

  for (const [path, list] of perFile) {
    const bad = list.findIndex(
      (k, i) => i > 0 && compareKeys(list[i - 1], k) > 0,
    );
    if (bad !== -1)
      report(
        'unsorted',
        list[bad],
        path,
        `${path} - first out of order: ${list[bad]}`,
      );
  }

  for (const [key, { path }] of baseReg.entries)
    if (!keys.has(key))
      report(
        'vanished',
        key,
        path,
        `${key} was in ${path} at ${baseSha.slice(0, 7)} - restore it and retire it with a citation`,
      );

  for (const path of setup.legacy?.files(root) ?? [])
    report(
      'legacy',
      path,
      path,
      `${path} - move its entries into ${setup.dir}/ (README)`,
    );

  const all = [...reg.entries.values()];
  const retired = all.filter((v) => v.entry?.retired).length;
  lines.push(
    `check:mutations: ${all.length} entries (${all.length - retired} live, ${retired} retired) in ${perFile.size} files, ${problems.length} problem(s)`,
  );
  return { code: problems.length ? 1 : 0, lines, problems };
}

/** { renames: Map<old, new>, added: string[] } from tracked changes against the base. */
function diffAgainst(root, baseSha) {
  const parts = git(root, ['diff', '-M', '--name-status', '-z', baseSha])
    .split('\0')
    .filter((p, i, a) => p !== '' || i < a.length - 1);
  const renames = new Map();
  const added = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i];
    if (status === '') break;
    if (status[0] === 'R' || status[0] === 'C') {
      if (status[0] === 'R') renames.set(parts[i + 1], parts[i + 2]);
      i += 3;
    } else {
      if (status[0] === 'A') added.push(parts[i + 1]);
      i += 2;
    }
  }
  return { renames, added };
}

function repair(root, diff, ticket, key, entry, setup) {
  const leave = (why, hint) => ({
    left: { key, why, ...(hint ? { hint } : {}) },
  });
  let next = structuredClone(entry);
  const notes = [];
  const moved = (p) => diff.renames.get(p);
  if (next.kind === 'patch' && moved(next.file)) {
    notes.push([next.file, moved(next.file)]);
    next.file = moved(next.file);
  }
  if (isStr(next.testFile) && moved(next.testFile)) {
    notes.push([next.testFile, moved(next.testFile)]);
    next.testFile = moved(next.testFile);
  }
  const kindRepair = setup.kinds.get(next.kind)?.repair;
  if (kindRepair) {
    const r = kindRepair(next, diff);
    if (r.left) return leave(r.left);
    next = r.entry;
    notes.push(...(r.notes ?? []));
  }
  if (!notes.length) {
    let hint;
    if (next.kind === 'patch')
      for (const p of diff.added) {
        const src = readText(root, p);
        if (src !== null && locate(src, next.find, next.within).count === 1) {
          hint = `find occurs once in added ${p}`;
          break;
        }
      }
    return leave(
      hint
        ? 'no git rename covers it; the guard may have been copied'
        : 'no git rename covers it (git add a moved file so it shows as a rename)',
      hint,
    );
  }
  if (next.kind === 'patch') {
    const src = readText(root, next.file);
    if (src === null) return leave(`file ${next.file} does not exist`);
    const located = locate(src, next.find, next.within);
    const why = `find occurs ${located.count} times in ${next.file}`;
    if (located.count !== 1) return leave(why);
  }
  const rest = staleReasons(root, next, setup);
  if (rest.length) return leave(rest[0]);
  next.reaimed = [
    ...(next.reaimed ?? []),
    ...notes.map(([a, b]) => ({ by: ticket, why: `moved: ${a} -> ${b}` })),
  ];
  return { entry: next };
}

function pruneEmptyDirs(root, rel, registryDir) {
  let dir = dirname(rel);
  while (dir.startsWith(`${registryDir}/`)) {
    try {
      rmdirSync(join(root, dir));
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

export function fixRegistry(opts, setup = projectSetup()) {
  const root = opts?.root ?? ROOT;
  let ticket = opts?.ticket;
  if (!ticket) {
    let branch = '';
    try {
      branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    } catch {
      /* no branch */
    }
    ticket = ticketFromBranch(branch);
  }
  if (!ticket)
    return {
      code: 2,
      lines: [
        'check:mutations --fix: no ticket id; pass --ticket=<ID> (the branch name does not carry one)',
      ],
      fixed: [],
      left: [],
    };
  let baseSha;
  try {
    baseSha = resolveBase(root, opts?.base);
  } catch (err) {
    return {
      code: 2,
      lines: [
        `check:mutations --fix: cannot resolve the base (${String(err.message).split('\n')[0]}); pass --base=<sha>`,
      ],
      fixed: [],
      left: [],
    };
  }
  const reg = loadRegistry(root, setup);
  const baseReg = registryAt(baseSha, root, setup);
  const isNew = (key) => !baseReg.entries.has(key);
  const diff = diffAgainst(root, baseSha);
  const keys = new Set(reg.entries.keys());
  const fixed = [];
  const left = [];
  const changes = [];

  for (const [key, { path, entry }] of reg.entries) {
    if (isNew(key)) continue;
    if (!entry || typeof entry !== 'object') continue;
    if (entry.retired || setup.kinds.get(entry.kind)?.runs === false) continue;
    if (shapeReasons(key, entry, keys, root, setup).length) continue;
    const want = safeAreaFor(entry, setup);
    if (!staleReasons(root, entry, setup).length && want === path) continue;
    const r = repair(root, diff, ticket, key, entry, setup);
    if (r.left) {
      left.push(r.left);
      continue;
    }
    const to = areaFor(r.entry, setup);
    fixed.push({ key, from: path, to });
    changes.push({ key, from: path, to, entry: r.entry });
  }

  const contents = new Map();
  const fileObj = (p) => {
    if (!contents.has(p))
      contents.set(
        p,
        Object.fromEntries(
          [...reg.entries]
            .filter(([, v]) => v.path === p)
            .map(([k, v]) => [k, v.entry]),
        ),
      );
    return contents.get(p);
  };
  for (const c of changes) {
    delete fileObj(c.from)[c.key];
    fileObj(c.to)[c.key] = c.entry;
  }
  for (const [p, obj] of contents) {
    if (Object.keys(obj).length === 0) {
      rmSync(join(root, p), { force: true });
      pruneEmptyDirs(root, p, setup.dir);
    } else {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), serializeArea(obj, setup));
    }
  }

  const lines = [
    ...fixed.map((f) => `fixed: ${f.key} ${f.from} -> ${f.to}`),
    ...left.map(
      (l) => `left: ${l.key} ${l.why}${l.hint ? ` (${l.hint})` : ''}`,
    ),
    `check:mutations --fix: ${fixed.length} re-aimed, ${left.length} left`,
  ];
  const check = checkRegistry({ root, base: baseSha }, setup);
  return {
    code: check.code === 0 ? 0 : check.code === 2 ? 2 : 1,
    lines: [...lines, ...check.lines],
    fixed,
    left,
  };
}

function main(argv, setup = projectSetup()) {
  const arg = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const unknown = argv.filter(
    (a) =>
      a !== '--fix' && !a.startsWith('--ticket=') && !a.startsWith('--base='),
  );
  if (unknown.length) {
    console.error(
      `check:mutations: unknown argument ${unknown[0]}. Usage: ${setup.commands.checkMutationsScript} [--fix] [--ticket=<ID>] [--base=<sha>]`,
    );
    return 2;
  }
  const opts = { root: ROOT, base: arg('base'), ticket: arg('ticket') };
  const r = argv.includes('--fix')
    ? fixRegistry(opts, setup)
    : checkRegistry(opts, setup);
  for (const l of r.lines) console.log(l);
  if (r.code === 1 && !argv.includes('--fix'))
    console.log(
      `Next: ${setup.commands.checkMutations} --fix --ticket=<ID> repairs moved files; anything else needs a hand edit (see ${setup.dir}/README.md).`,
    );
  return r.code;
}

export { main };
