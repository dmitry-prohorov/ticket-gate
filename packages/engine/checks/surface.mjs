// The surface ratchet: every tracked file under the configured roots is classified in a
// manifest with one kind, and the kind decides what the file may import or do. Engine-shaped:
// no project path is named here; the manifest, baseline, roots and messages come from the caller.
// A manifest with `strict: true` also fails every pending entry, the code lines of `check` files over
// `budget.check` (which may only go down, against the baseline) and more than `budget.wiring` wiring files.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

// Built from parts so no source file carries the package scope as a literal.
const SCOPE = '@ticket-' + 'gate/';

const KINDS = [
  'config',
  'data',
  'check',
  'support',
  'shim',
  'test',
  'wiring',
  'pending',
];
const CONFIG_TARGETS = new Set(['config', 'data', 'check', 'pending']);
const CONFIG_NODE = new Set(['node:path', 'node:url']);
const SHIM_MAX = 15;
const SHIM_IMPORT = /^(?:@ticket-gate\/|node:url$)/;
const ENGINE_INTERNAL = /^@ticket-gate\/[^/]+\/(?!config\.mjs$).+/;
const TEST_EXT = /\.(?:mjs|js|ts)$/;

class InputError extends Error {}
const inputError = (message) => new InputError(message);

/** '**' as a whole segment matches 0+ segments, '*' a run of non-'/' characters. */
export function globMatch(glob, path) {
  const g = glob.split('/');
  const p = path.split('/');
  const seg = (s) =>
    new RegExp(
      `^${s
        .split('*')
        .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')}$`,
    );
  const walk = (gi, pi) => {
    if (gi === g.length) return pi === p.length;
    if (g[gi] === '**') {
      for (let k = pi; k <= p.length; k++) if (walk(gi + 1, k)) return true;
      return false;
    }
    return pi < p.length && seg(g[gi]).test(p[pi]) && walk(gi + 1, pi + 1);
  };
  return walk(0, 0);
}

/** Whether a '/' after `out` opens a regex literal (not a division): after nothing, an operator or punctuation. */
function regexAllowed(out) {
  let k = out.length - 1;
  while (k >= 0 && (out[k] === ' ' || out[k] === '\t')) k--;
  if (k < 0 || out[k] === '\n') return true;
  if ('=(,:;[!&|?{}+-*%<>~^'.includes(out[k])) return true;
  return /(?:^|[^\w$])(?:return|typeof)$/.test(out.slice(0, k + 1));
}

/** The text with comments removed (string and template contents are kept), as non-blank lines. */
function codeOf(text) {
  let out = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === quote) quote = '';
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i++;
      }
      i++;
    } else if (c === '/' && regexAllowed(out)) {
      out += c;
      let inClass = false;
      for (i++; i < text.length && text[i] !== '\n'; i++) {
        out += text[i];
        if (text[i] === '\\') out += text[++i] ?? '';
        else if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
      }
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
    }
  }
  return out.split('\n').filter((l) => l.trim() !== '');
}

/** Non-blank lines outside '//' and block comments. */
export function codeLines(text) {
  return codeOf(text).length;
}

/** A string literal, consumed first so a `from` or `import` inside one is never a specifier. */
const STRING = '\'(?:[^\'\\\\\\n]|\\\\.)*\'|"(?:[^"\\\\\\n]|\\\\.)*"|`(?:[^`\\\\]|\\\\.)*`';

/** Specifiers of `from '...'`, `import('...')` and `import '...'` on code lines, outside strings. */
export function importsOf(text) {
  const code = codeOf(text).join('\n');
  const out = [];
  for (const re of [
    /\bfrom\s*['"]([^'"]+)['"]/.source,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/.source,
    /(?:^|[;{}])\s*import\s*['"]([^'"]+)['"]/.source,
  ])
    for (const m of code.matchAll(new RegExp(`${STRING}|${re}`, 'gm')))
      if (m[1] !== undefined) out.push(m[1]);
  return out;
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw inputError(`unreadable ${what} ${path}: ${e.message}`);
  }
}

function loadManifest(path) {
  const m = readJson(path, 'manifest');
  if (!Array.isArray(m?.entries)) throw inputError('entries must be an array');
  // prettier-ignore
  if (m.strict !== undefined && typeof m.strict !== 'boolean') throw inputError('strict must be true or false');
  if (m.strict === true) {
    for (const key of ['check', 'wiring']) {
      // prettier-ignore
      if (!Number.isInteger(m.budget?.[key]) || m.budget[key] < 0) throw inputError(`strict needs budget.${key}, a non-negative integer`);
    }
  }
  const seen = new Set();
  m.entries.forEach((e, i) => {
    const at = `entries[${i}]${Array.isArray(e?.match) ? ` (${e.match[0]})` : ''}`;
    if (!Array.isArray(e?.match) || e.match.length === 0)
      throw inputError(`${at}: match must be a non-empty array`);
    for (const glob of e.match) {
      if (typeof glob !== 'string' || glob === '')
        throw inputError(`${at}: match holds a non-string glob`);
      if (seen.has(glob)) throw inputError(`${at}: glob ${glob} is repeated`);
      seen.add(glob);
    }
    // prettier-ignore
    if (!KINDS.includes(e.kind)) throw inputError(`${at}: unknown kind ${e.kind}`);
    // prettier-ignore
    if (typeof e.why !== 'string' || e.why.trim() === '') throw inputError(`${at}: why must be a non-empty string`);
  });
  return m;
}

function loadBaseline(path) {
  const b = readJson(path, 'baseline');
  if (!Array.isArray(b?.pending))
    throw inputError(`baseline ${path} has no "pending" array`);
  // prettier-ignore
  if (b.budget !== undefined && !(Number.isInteger(b.budget?.check) && b.budget.check >= 0)) throw inputError(`baseline ${path}: budget.check must be a non-negative integer`);
  return { pending: new Set(b.pending), budgetCheck: b.budget?.check };
}

function trackedFiles(root, roots) {
  let raw;
  try {
    raw = execFileSync('git', ['ls-files', '-z', '--', ...roots], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw inputError(`cannot list tracked files in ${root}: ${e.message}`);
  }
  const inRoots = (f) =>
    roots.some((r) => (r.endsWith('/') ? f.startsWith(r) : f === r));
  return raw.split('\0').filter((f) => f && inRoots(f));
}

/**
 * A surface ratchet bound to `cfg`: { manifest, baseline, roots, comment, fix, usage } (paths relative
 * to the repo root). Returns the ratchet entry { baseline, check({ root, args, update }) }.
 */
export function surface(cfg) {
  const { manifest: manifestPath, baseline: baselinePath, roots } = cfg;

  function run(root, args, updateFlag) {
    let update = Boolean(updateFlag);
    let seed = false;
    for (const a of args ?? []) {
      if (a === '--update') update = true;
      else if (a === '--seed') seed = true;
      else
        throw Object.assign(inputError(`unknown argument ${a}`), {
          usage: true,
        });
    }
    if (seed && !update)
      throw Object.assign(inputError('--seed needs --update'), {
        usage: true,
      });

    const manifest = loadManifest(join(root, manifestPath));
    const absBaseline = join(root, baselinePath);
    const haveBaseline = existsSync(absBaseline);
    if (!haveBaseline && !(update && seed))
      throw inputError(
        `no baseline at ${baselinePath}. Fix: run the ratchet once with --update --seed`,
      );
    const { pending: before, budgetCheck: floor } = haveBaseline
      ? loadBaseline(absBaseline)
      : { pending: new Set(), budgetCheck: undefined };
    const strict = manifest.strict === true;
    // prettier-ignore
    if (strict && !update && floor === undefined) throw inputError(`baseline ${baselinePath} has no budget.check. Fix: run the ratchet once with --update`);

    const globs = manifest.entries.flatMap((entry) =>
      entry.match.map((glob) => ({ glob, entry })),
    );
    const pendingGlobs = globs
      .filter((g) => g.entry.kind === 'pending')
      .map((g) => g.glob);

    if (update) {
      const seeding = !haveBaseline;
      const added = seeding ? [] : pendingGlobs.filter((g) => !before.has(g));
      const refuse = (list) => ({
        code: 1,
        lines: [
          `surface: refused: pending glob(s) not in the baseline: ${list.join(', ')}. A pending entry is never added.`,
          cfg.fix,
        ],
      });
      // prettier-ignore
      if (added.length > 0) return refuse(added);
      const refuseBudget = () => ({
        code: 1,
        lines: [
          `surface: refused: budget.check ${manifest.budget.check} is over ${floor} in ${baselinePath}. A budget only goes down.`,
          cfg.fix,
        ],
      });
      // prettier-ignore
      if (strict && manifest.budget.check > floor) return refuseBudget();
      const next = [...new Set(pendingGlobs)].sort();
      const removed = [...before].filter((g) => !next.includes(g)).length;
      const kept = strict ? manifest.budget.check : floor;
      const nextBaseline = { comment: cfg.comment, pending: next };
      if (kept !== undefined) nextBaseline.budget = { check: kept };
      writeFileSync(absBaseline, `${JSON.stringify(nextBaseline, null, 2)}\n`);
      return {
        code: 0,
        lines: [
          `surface: baseline ${baselinePath}: ${next.length} pending globs (removed ${removed})${strict ? `, budget.check ${kept}` : ''}`,
        ],
      };
    }

    const files = trackedFiles(root, roots);
    const used = new Set();
    const hitsOf = new Map();
    for (const file of files) {
      const hits = globs.filter((g) => globMatch(g.glob, file));
      for (const h of hits) used.add(h.glob);
      hitsOf.set(file, hits);
    }
    const kindOf = (file) => hitsOf.get(file)?.[0]?.entry.kind;
    const ownerRe = new RegExp(manifest.ownerPattern ?? '.+');
    const out = [];
    let checkLines = 0;

    function configImportOk(spec, file) {
      if (spec.startsWith(SCOPE) || CONFIG_NODE.has(spec)) return true;
      if (!spec.startsWith('.')) return false;
      const target = posix.join(posix.dirname(file), spec);
      return CONFIG_TARGETS.has(kindOf(target));
    }

    for (const file of files) {
      const hits = hitsOf.get(file);
      // prettier-ignore
      if (hits.length === 0) out.push([1, file, 'matches no entry']);
      // prettier-ignore
      if (hits.length > 1) out.push([1, file, `matches ${hits.length} entries`]);
      const kind = hits[0]?.entry.kind;
      if (!kind || kind === 'pending') continue;
      const abs = join(root, file);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf8');
      // prettier-ignore
      if (kind === 'check') checkLines += codeLines(text);
      if ((kind === 'config' || kind === 'data') && file.endsWith('.mjs')) {
        for (const spec of importsOf(text))
          // prettier-ignore
          if (!configImportOk(spec, file)) out.push([3, file, `imports ${spec}`]);
        for (const code of codeOf(text))
          // prettier-ignore
          if (/\bfetch\(/.test(code)) out.push([3, file, 'calls fetch(']);
      }
      if (kind === 'shim' && file.endsWith('.mjs')) {
        const n = codeLines(text);
        if (n > SHIM_MAX)
          out.push([4, file, `has ${n} code lines, over ${SHIM_MAX}`]);
        for (const spec of importsOf(text))
          // prettier-ignore
          if (!SHIM_IMPORT.test(spec)) out.push([4, file, `imports ${spec}`]);
      }
      if (kind === 'test' && TEST_EXT.test(file)) {
        for (const spec of importsOf(text))
          // prettier-ignore
          if (ENGINE_INTERNAL.test(spec)) out.push([6, file, `imports ${spec}`]);
      }
    }

    for (const { glob, entry } of globs) {
      // prettier-ignore
      if (!used.has(glob)) out.push([1, glob, 'matches no tracked file']);
      if (entry.kind !== 'pending') continue;
      // prettier-ignore
      if (!before.has(glob)) out.push([2, glob, 'pending entry is not in the baseline']);
      // prettier-ignore
      if (!ownerRe.test(entry.owner ?? '')) out.push([2, glob, 'pending entry names no owner ticket']);
      // prettier-ignore
      if (strict) out.push([2, glob, 'pending entry in strict mode']);
    }

    const wiring = files.filter((f) => kindOf(f) === 'wiring');
    // prettier-ignore
    if (strict && checkLines > manifest.budget.check) out.push([5, manifestPath, `check files have ${checkLines} code lines, over budget.check ${manifest.budget.check}`]);
    // prettier-ignore
    if (strict && manifest.budget.check > floor) out.push([5, manifestPath, `budget.check ${manifest.budget.check} is over ${floor} in ${baselinePath}; the budget only goes down`]);
    // prettier-ignore
    if (strict && wiring.length > manifest.budget.wiring) out.push([6, manifestPath, `${wiring.length} files of kind wiring (${wiring.join(', ')}), over budget.wiring ${manifest.budget.wiring}`]);

    if (out.length > 0) {
      out.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
      return {
        code: 1,
        lines: [
          `surface: FAIL ${out.length} problem(s) in ${files.length} tracked files`,
          ...out.map(([rule, path, why]) => `  [rule ${rule}] ${path}: ${why}`),
          cfg.fix,
        ],
      };
    }

    const kinds = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const f of files) kinds[kindOf(f)]++;
    const owners = new Map();
    for (const { entry } of globs) {
      if (entry.kind !== 'pending') continue;
      owners.set(entry.owner, (owners.get(entry.owner) ?? 0) + 1);
    }
    const ownerList = [...owners]
      .sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true }))
      .map(([o, n]) => `${o} ${n}`)
      .join(', ');
    return {
      code: 0,
      lines: [
        `surface: OK ${files.length} tracked files, ${manifest.entries.length} entries, ${globs.length} globs`,
        `  kinds (files): ${KINDS.map((k) => `${k} ${kinds[k]}`).join(', ')}`,
        `  pending: ${pendingGlobs.length} globs (${ownerList})`,
        ...(strict
          ? [
              `  budget: check ${checkLines}/${manifest.budget.check} code lines, wiring ${wiring.length}/${manifest.budget.wiring} files`,
            ]
          : []),
      ],
    };
  }

  return {
    baseline: baselinePath,
    check({ root, args, update }) {
      try {
        return run(root, args, update);
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        return {
          code: 2,
          lines: [`surface: ${e.message}`, ...(e.usage ? [cfg.usage] : [])],
        };
      }
    },
  };
}
