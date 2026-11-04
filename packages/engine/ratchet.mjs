// Generic ratchets for `ticket-gate ratchet <name>`: a line-count baseline and a skill-reference
// resolver. Every path, limit, message and command name arrives through the factory argument;
// the project values live in the project's gate config.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export function countLines(text) {
  return text === ''
    ? 0
    : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * A module-size ratchet bound to `cfg`: { limits: { module, test }, testRe, roots, baselineRel,
 * comment, name, cmd, fixNew, fixGrew, usage }. `name` prefixes every message, `cmd` is the
 * command a message tells the reader to run.
 */
export function createModuleSize(cfg) {
  const { limits, testRe, roots, name, cmd } = cfg;
  const limitOf = (path) => (testRe.test(path) ? limits.test : limits.module);

  function trackedFiles(root) {
    const r = spawnSync('git', ['ls-files', '-z', '--', ...roots], {
      cwd: root,
      encoding: 'utf8',
    });
    if (r.status !== 0)
      throw new Error(
        `git ls-files failed in ${root}: ${String(r.stderr).trim()}. Run it inside a git work tree.`,
      );
    return r.stdout
      .split('\0')
      .filter((f) => /\.m?js$/.test(f))
      .sort();
  }

  function measure(root, files) {
    const out = {};
    for (const f of files) {
      const p = join(root, f);
      if (existsSync(p)) out[f] = countLines(readFileSync(p, 'utf8'));
    }
    return out;
  }

  const over = (path, n) => ({ path, lines: n, limit: limitOf(path) });
  const less = (path, e, now) => ({ path, was: e.lines, now: now ?? 0 });

  function compare(sizes, baseline) {
    const fresh = [];
    const grown = [];
    const shrunk = [];
    for (const path of Object.keys(sizes)) {
      const was = baseline.files[path]?.lines;
      const n = sizes[path];
      if (!was && n > limitOf(path)) fresh.push(over(path, n));
      if (was && n > was) grown.push({ path, was, now: n });
    }
    for (const [path, e] of Object.entries(baseline.files)) {
      const now = sizes[path];
      if (now === undefined || now < e.lines) shrunk.push(less(path, e, now));
    }
    return { fresh, grown, shrunk };
  }

  function updateBaseline(sizes, baseline, { allow = {}, seed = false } = {}) {
    const files = {};
    const added = [];
    const lowered = [];
    const removed = [];
    const refused = [];
    for (const path of Object.keys(sizes).sort()) {
      const n = sizes[path];
      if (n <= limitOf(path)) continue;
      const prev = baseline.files[path];
      if (prev && n > prev.lines && !allow[path]) {
        refused.push({ path, why: 'grew', was: prev.lines, now: n });
        continue;
      }
      if (!prev && !seed && !allow[path]) {
        refused.push({ path, why: 'no allow', now: n });
        continue;
      }
      const entry = { lines: n };
      const reason = allow[path] ?? prev?.allow;
      if (reason) entry.allow = reason;
      files[path] = entry;
      if (!prev) added.push(path);
      else if (n < prev.lines) lowered.push(path);
    }
    for (const path of Object.keys(baseline.files))
      if (!files[path] && !refused.some((r) => r.path === path))
        removed.push(path);
    return {
      next: { comment: cfg.comment, files },
      added,
      lowered,
      removed,
      refused,
    };
  }

  function checkModuleSize(root, opts = {}) {
    const baselinePath = opts.baselinePath ?? join(root, cfg.baselineRel);
    const seeding = Boolean(opts.update && opts.seed);
    let baseline = { files: {} };
    const hadBaseline = existsSync(baselinePath);
    if (hadBaseline) {
      try {
        baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
      } catch (e) {
        return {
          code: 2,
          wrote: false,
          lines: [
            `${name}: unreadable baseline ${baselinePath}: ${e.message}. Fix: resolve the conflict, or delete the file and run ${cmd} --update --seed.`,
          ],
        };
      }
      if (
        !baseline ||
        typeof baseline.files !== 'object' ||
        baseline.files === null
      )
        return {
          code: 2,
          wrote: false,
          lines: [
            `${name}: baseline ${baselinePath} has no "files" object. Fix: resolve the conflict, or delete the file and run ${cmd} --update --seed.`,
          ],
        };
    } else if (!seeding) {
      return {
        code: 2,
        wrote: false,
        lines: [
          `${name}: no baseline at ${baselinePath}. Fix: ${cmd} --update --seed.`,
        ],
      };
    }
    let files;
    try {
      files = trackedFiles(root);
    } catch (e) {
      return { code: 2, wrote: false, lines: [`${name}: ${e.message}`] };
    }
    const sizes = measure(root, files);

    if (opts.update) {
      const u = updateBaseline(sizes, baseline, {
        allow: opts.allow,
        seed: opts.seed && !hadBaseline,
      });
      if (u.refused.length > 0) {
        return {
          code: 1,
          wrote: false,
          lines: [
            ...u.refused.map((r) =>
              r.why === 'grew'
                ? `GREW ${r.path} was ${r.was}, now ${r.now}: shrink it, or --allow=${r.path}=<reason>`
                : `NO REASON ${r.path} ${r.now} lines: split it, or --allow=${r.path}=<reason>`,
            ),
            `${name}: baseline not written.`,
          ],
        };
      }
      writeFileSync(baselinePath, `${JSON.stringify(u.next, null, 2)}\n`);
      return {
        code: 0,
        wrote: true,
        lines: [
          ...u.added.map((p) => `ADDED ${p} ${sizes[p]}`),
          ...u.lowered.map(
            (p) => `LOWERED ${p} ${baseline.files[p].lines} -> ${sizes[p]}`,
          ),
          ...u.removed.map((p) => `REMOVED ${p}`),
          `${name}: baseline updated (${Object.keys(u.next.files).length} entries)`,
        ],
      };
    }

    const c = compare(sizes, baseline);
    const notes = c.shrunk.map(
      (s) =>
        `SHRUNK ${s.path} was ${s.was}, now ${s.now}: run ${cmd} --update to lock it in`,
    );
    if (c.fresh.length === 0 && c.grown.length === 0) {
      return {
        code: 0,
        wrote: false,
        lines: [
          ...notes,
          `${name}: ${Object.keys(sizes).length} files measured, ${Object.keys(baseline.files).length} baselined, none grew`,
        ],
      };
    }
    return {
      code: 1,
      wrote: false,
      lines: [
        ...c.fresh.map(
          (f) => `NEW ${f.path} ${f.lines} lines (limit ${f.limit})`,
        ),
        ...c.grown.map((g) => `GREW ${g.path} was ${g.was}, now ${g.now}`),
        ...notes,
        ...(c.fresh.length > 0 ? [cfg.fixNew] : []),
        ...(c.grown.length > 0 ? [cfg.fixGrew] : []),
      ],
    };
  }

  function parseArgs(argv) {
    const opts = { allow: {} };
    let root = null;
    const bad = (a) => ({
      error: `unknown or invalid argument ${a}. ${cfg.usage}`,
    });
    for (const a of argv) {
      if (a === '--update') opts.update = true;
      else if (a === '--seed') opts.seed = true;
      else if (a.startsWith('--root=')) root = a.slice(7);
      else if (a.startsWith('--baseline=')) opts.baselinePath = a.slice(11);
      else if (a.startsWith('--allow=')) {
        const m = /^--allow=(.+?\.m?js)=(.+)$/.exec(a);
        if (!m) return bad(a);
        opts.allow[m[1]] = m[2];
      } else return bad(a);
    }
    if ((opts.seed || Object.keys(opts.allow).length > 0) && !opts.update)
      return { error: `--seed and --allow need --update. ${cfg.usage}` };
    return { opts, root };
  }

  /** The ratchet CLI as a function: `args` are its flags, `--root=` overrides `root`. */
  function runModuleSize(root, args) {
    const parsed = parseArgs(args);
    if (parsed.error) return { code: 2, lines: [`${name}: ${parsed.error}`] };
    const { code, lines } = checkModuleSize(parsed.root ?? root, parsed.opts);
    return { code, lines };
  }

  return {
    limits,
    limitOf,
    trackedFiles,
    measure,
    compare,
    updateBaseline,
    checkModuleSize,
    parseArgs,
    runModuleSize,
  };
}

const NAME = '[A-Za-z0-9][A-Za-z0-9_-]*';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every SKILL.md under `dir` (posix `rel` prefix), skipping node_modules. */
export function skillMdFiles(dir, rel, out) {
  if (!isDir(dir)) return;
  for (const e of readdirSync(dir).sort()) {
    if (e === 'node_modules') continue;
    const p = join(dir, e);
    if (isDir(p)) skillMdFiles(p, `${rel}/${e}`, out);
    else if (e === 'SKILL.md') out.push(`${rel}/${e}`);
  }
}

const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '');

/**
 * A skill-reference ratchet bound to `cfg`: { prefixes, skillRoots, sourceFiles(root), name,
 * prefixedNote, fix, usage }. `skillRoots` are posix dirs; `sourceFiles` lists the prose files to scan.
 */
export function createSkillRefs(cfg) {
  const { prefixes, skillRoots, name } = cfg;
  const pathRe = new RegExp(
    `(${skillRoots.map(escape).join('|')})/(${NAME})`,
    'g',
  );
  const prefixRe = new RegExp(`\\b(${prefixes.join('|')}):(${NAME})`, 'g');
  const entryRe = new RegExp(`^(?:(${prefixes.join('|')}):)?(${NAME})$`);

  function installedSkills(root) {
    const out = new Set();
    for (const r of skillRoots) {
      const dir = join(root, r);
      if (!isDir(dir)) continue;
      for (const e of readdirSync(dir)) if (isDir(join(dir, e))) out.add(e);
    }
    return out;
  }

  function frontmatterSkills(lines) {
    const out = [];
    if (lines[0]?.trim() !== '---') return out;
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end < 0) return out;
    const push = (raw, line) => {
      const item = unquote(raw);
      if (!item) return;
      const m = entryRe.exec(item);
      out.push({
        name: m ? m[2] : item,
        prefix: m?.[1] ?? null,
        form: 'skills',
        line,
      });
    };
    for (let i = 1; i < end; i++) {
      const m = /^skills:\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      const rest = m[1].trim();
      if (rest) {
        for (const part of rest.replace(/^\[|\]$/g, '').split(','))
          push(part, i + 1);
        continue;
      }
      for (let j = i + 1; j < end; j++) {
        const b = /^\s*-\s*(.+)$/.exec(lines[j]);
        if (!b) break;
        push(b[1], j + 1);
      }
    }
    return out;
  }

  function skillRefs(text) {
    const lines = text.split(/\r?\n/);
    const refs = frontmatterSkills(lines);
    const seen = new Set(
      refs.map((r) => `${r.line}:${r.prefix ?? ''}:${r.name}`),
    );
    const add = (r) => {
      const k = `${r.line}:${r.prefix ?? ''}:${r.name}`;
      if (seen.has(k)) return;
      seen.add(k);
      refs.push(r);
    };
    lines.forEach((l, i) => {
      for (const m of l.matchAll(pathRe))
        add({
          name: m[2],
          prefix: null,
          form: 'path',
          root: m[1],
          line: i + 1,
        });
      for (const m of l.matchAll(prefixRe))
        add({ name: m[2], prefix: m[1], form: 'skills', line: i + 1 });
    });
    return refs.sort((a, b) => a.line - b.line);
  }

  function resolves(ref, installed, root) {
    if (ref.prefix) return false;
    if (ref.form === 'path') return isDir(join(root, ref.root, ref.name));
    return installed.has(ref.name);
  }

  const written = (r) =>
    r.prefix
      ? `${r.prefix}:${r.name}`
      : r.form === 'path'
        ? `${r.root}/${r.name}`
        : r.name;

  function checkSkillRefs(root) {
    const installed = installedSkills(root);
    const files = cfg.sourceFiles(root);
    const bad = [];
    let total = 0;
    for (const f of files) {
      for (const r of skillRefs(readFileSync(join(root, f), 'utf8'))) {
        total++;
        if (!resolves(r, installed, root))
          bad.push(
            `DANGLING ${f}:${r.line} ${written(r)}${r.prefix ? cfg.prefixedNote : ''}`,
          );
      }
    }
    if (bad.length === 0)
      return {
        code: 0,
        lines: [
          `${name}: ${total} references in ${files.length} files resolve`,
        ],
      };
    return { code: 1, lines: [...bad, cfg.fix] };
  }

  /** The ratchet CLI as a function: `args` are its flags, `--root=` overrides `root`. */
  function runSkillRefs(root, args) {
    let at = root;
    for (const a of args) {
      if (!a.startsWith('--root='))
        return {
          code: 2,
          lines: [`${name}: unknown argument ${a}. ${cfg.usage}`],
        };
      at = a.slice(7);
    }
    const { code, lines } = checkSkillRefs(at);
    return { code, lines };
  }

  return {
    prefixes,
    installedSkills,
    skillRefs,
    resolves,
    checkSkillRefs,
    runSkillRefs,
  };
}
