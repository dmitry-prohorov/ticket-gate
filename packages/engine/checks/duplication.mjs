// Duplication ratchet, generic part. Runs jscpd (settings in a config file) and compares the clones it
// finds with a baseline file. Every project value (package prefixes, limits, paths, message texts) is an
// option of duplication(); the project's values live in its ratchet-values file.
//
// Only "gated" clones count: any clone whose two sides sit in different packages, and any clone inside
// one package that is longer than withinMax. A gated clone that is not in the baseline fails the check,
// so a copy cannot be added without a person reading the baseline diff. A baseline entry whose clone is
// gone also fails, so the baseline can only shrink by itself.
//
// check() arguments (a CLI shim passes process.argv.slice(2)):
//   --update            rewrite the baseline from the current clones
//   --seed              with --update only: new entries get no `allow` (debt)
//   --report=<path>     read this jscpd JSON report instead of running jscpd (tests)
//   --baseline=<path>   default <root>/<baseline>
//
// Result: { code, lines, err, out }. code 0 green, 1 a new, stale or unexplained clone, 2 jscpd gave no
// report. err and out hold the lines for stderr and stdout; lines is err followed by out.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Trim each line, collapse whitespace runs, drop empty lines. */
export function normaliseFragment(text) {
  return text
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n');
}

const relPath = (name, root) => {
  const p = isAbsolute(name) ? relative(root, name) : name;
  return p.split('\\').join('/').replace(/^\.\//, '');
};

const pairOf = (key) => key.slice(0, key.lastIndexOf('|'));

export function duplication({
  packages,
  withinMax,
  config,
  report,
  baseline,
  bin,
  comment,
  name,
  fix,
}) {
  /** The package a path belongs to: first prefix of `packages` that matches, else 'other'. */
  function packageOf(path) {
    for (const [pkg, prefix] of Object.entries(packages))
      if (path.startsWith(prefix)) return pkg;
    return 'other';
  }

  /** One jscpd duplicate -> a clone with a stable key (no line numbers). */
  function cloneOf(dup, root) {
    const first = { ...dup.firstFile, path: relPath(dup.firstFile.name, root) };
    const second = {
      ...dup.secondFile,
      path: relPath(dup.secondFile.name, root),
    };
    const [x, y] =
      first.path <= second.path ? [first, second] : [second, first];
    const hash = createHash('sha256')
      .update(normaliseFragment(dup.fragment ?? ''))
      .digest('hex')
      .slice(0, 16);
    const pa = packageOf(x.path);
    const pb = packageOf(y.path);
    const names = [pa, pb].sort();
    return {
      a: x.path,
      b: y.path,
      hash,
      key: `${x.path}|${y.path}|${hash}`,
      lines: dup.lines,
      cross: pa !== pb,
      kind: pa !== pb ? `${names[0]}<->${names[1]}` : `within ${pa}`,
      loc: [`${x.path}:${x.start}-${x.end}`, `${y.path}:${y.start}-${y.end}`],
    };
  }

  const gated = (c) => c.cross || c.lines > withinMax;

  const groupByKey = (clones) => {
    const groups = new Map();
    for (const c of clones.filter(gated)) {
      const g = groups.get(c.key) ?? [];
      g.push(c);
      groups.set(c.key, g);
    }
    return groups;
  };

  /**
   * fresh: clones beyond what the baseline allows. stale: baseline entries with
   * fewer current clones than their count. unreasoned: entries with allow "".
   */
  function compare(clones, base) {
    const groups = groupByKey(clones);
    const entries = new Map(base.clones.map((e) => [e.key, e]));
    const fresh = [];
    for (const [key, group] of groups) {
      const e = entries.get(key);
      fresh.push(...group.slice(e ? (e.count ?? 1) : 0));
    }
    const stale = [];
    for (const e of base.clones) {
      const now = groups.get(e.key)?.length ?? 0;
      if (now < (e.count ?? 1)) stale.push(e);
    }
    const unreasoned = base.clones.filter((e) => e.allow === '');
    const counts = {
      gated: [...groups.values()].reduce((n, g) => n + g.length, 0),
      allowed: base.clones.filter((e) => e.allow).length,
      debt: base.clones.filter((e) => e.allow === undefined).length,
    };
    return { fresh, stale, unreasoned, counts };
  }

  /** Next baseline for the current clones (rules in the header). */
  function updateBaseline(clones, base, { seed = false } = {}) {
    const groups = groupByKey(clones);
    const old = new Map(base.clones.map((e) => [e.key, e]));
    const dropped = base.clones.filter((e) => !groups.has(e.key));
    const out = [];
    const added = [];
    for (const [key, group] of groups) {
      const prev = old.get(key);
      const entry = { key, lines: group[0].lines };
      if (group.length > 1) entry.count = group.length;
      if (prev) {
        if (prev.allow !== undefined) entry.allow = prev.allow;
      } else {
        const replaces = dropped.some(
          (d) =>
            d.allow === undefined &&
            pairOf(d.key) === pairOf(key) &&
            group[0].lines <= d.lines,
        );
        if (!seed && !replaces) entry.allow = '';
        added.push(entry);
      }
      out.push(entry);
    }
    out.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
    return { next: { comment, clones: out }, added, removed: dropped };
  }

  function loadBaseline(path) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { clones: [] };
    }
  }

  /** The jscpd report, or null when there is none. */
  function readReport(root, reportPath) {
    if (!reportPath) {
      rmSync(join(root, report), { recursive: true, force: true });
      const r = spawnSync(bin, ['--config', join(root, config)], {
        cwd: root,
        encoding: 'utf8',
      });
      if (r.status !== 0) return null;
      reportPath = join(root, report, 'jscpd-report.json');
    }
    try {
      const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
      return Array.isArray(parsed.duplicates) ? parsed : null;
    } catch {
      return null;
    }
  }

  function check({ root, args = [], update = false }) {
    const opt = (key) =>
      args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);
    const done = (code, err, out) => ({
      code,
      lines: [...err, ...out],
      err,
      out,
    });
    const parsed = readReport(root, opt('report'));
    if (!parsed)
      return done(
        2,
        [`${name}: jscpd produced no report. ${fix.noReport}`],
        [],
      );
    const baselinePath = resolve(opt('baseline') ?? join(root, baseline));
    const clones = parsed.duplicates.map((d) => cloneOf(d, root));
    const base = loadBaseline(baselinePath);

    if (update || args.includes('--update')) {
      const { next, added, removed } = updateBaseline(clones, base, {
        seed: args.includes('--seed'),
      });
      writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
      const out = [
        ...added.map((e) => `  ADDED ${e.key} (${e.lines} lines)`),
        ...removed.map((e) => `  REMOVED ${e.key} (${e.lines} lines)`),
        `${name}: baseline rewritten, ${next.clones.length} entries (${added.length} added, ${removed.length} removed).`,
      ];
      return done(0, [], out);
    }

    const { fresh, stale, unreasoned, counts } = compare(clones, base);
    const err = [];
    if (fresh.length > 0) {
      err.push(`${name}: ${fresh.length} new clone(s). ${fix.fresh}`);
      for (const c of fresh)
        err.push(
          `  NEW ${c.kind} ${c.lines} lines: ${c.loc[0]} <-> ${c.loc[1]}`,
        );
    }
    if (stale.length > 0) {
      err.push(
        `${name}: ${stale.length} baseline entr${stale.length === 1 ? 'y' : 'ies'} no longer match a clone. ${fix.stale}`,
      );
      for (const e of stale)
        err.push(`  STALE ${e.key} (${e.lines} lines): the clone is gone`);
    }
    if (unreasoned.length > 0) {
      err.push(
        `${name}: ${unreasoned.length} baseline entr${unreasoned.length === 1 ? 'y has' : 'ies have'} an empty "allow". ${fix.unreasoned}`,
      );
      for (const e of unreasoned)
        err.push(
          `  NO REASON ${e.key}: write why the copy is deliberate in "allow"`,
        );
    }
    let code = 0;
    if (fresh.length > 0) code = 1;
    if (stale.length > 0) code = 1;
    if (unreasoned.length > 0) code = 1;
    const out = code
      ? []
      : [
          `${name}: ${counts.gated} gated clone(s), all in ${baseline} (${counts.allowed} allowed, ${counts.debt} debt).`,
        ];
    return done(code, err, out);
  }

  return {
    baseline,
    withinMax,
    packageOf,
    cloneOf,
    compare,
    updateBaseline,
    check,
  };
}
