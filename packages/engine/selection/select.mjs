import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildGraph, listFiles, readText } from '../graph/js.mjs';
import { loadTimeChanged } from '../graph/load-time.mjs';
import { FullSignal } from './value-rules.mjs';
import { projectSelection } from './project.mjs';

export const startsAny = (path, list) => list.some((p) => path.startsWith(p));
export const isFullTrigger = (path, cfg = projectSelection()) =>
  startsAny(path, cfg.triggers);

export function isOutside(path, cfg = projectSelection()) {
  const { prefixes, rootRe, testFile } = cfg.outside;
  const inDomain = (rootRe?.test(path) ?? false) || startsAny(path, prefixes);
  return (
    !inDomain ||
    path.endsWith('.md') ||
    startsAny(path, cfg.ignored) ||
    (testFile?.test(path) ?? false)
  );
}

export function full(path, rule) {
  return {
    mode: 'full',
    why: `${path}: ${rule}`,
    rule,
    areas: [],
    specs: [],
  };
}

/** spec path (relative to the spec dir) -> areas declared on line 1; no header -> absent. */
export function specHeaders(root, cfg = projectSelection()) {
  const out = new Map();
  const dir = cfg.specs.dir;
  for (const f of listFiles(root, dir, (p) => cfg.specs.match.test(p))) {
    const first = (readText(root, f) ?? '')
      .split('\n', 1)[0]
      .replace(/\r$/, '');
    const m = cfg.specs.header.exec(first);
    if (m) out.set(f.slice(dir.length + 1), m[1].split(', '));
  }
  return out;
}

// ---------------------------------------------------------------- select

/** No base reader means the load-time rule does not run (the nightly's suspect rule). */
const NO_BASE = () => null;

/**
 * One path through the pipeline is outside -> before-rules -> triggers ->
 * after-rules -> spec files -> graph reach. A rule's `full` ends the run; its specs/areas are
 * added and the next path is taken.
 * @param {{ root?: string, changed: string[], readBase?: (path: string) => string|null,
 *           nightly?: { status?: string, flakySpecs?: string[] } | null, graph?: object,
 *           config?: object }} input
 */
export function select({
  root: rootArg,
  changed,
  readBase = NO_BASE,
  nightly = null,
  graph: given = null,
  config = null,
}) {
  const cfg = config ?? projectSelection();
  const root = rootArg ?? cfg.root;
  const specDir = cfg.specs.dir;
  const areas = new Set();
  const specs = new Set();
  let graph = given;
  const getGraph = () => (graph ??= buildGraph(root, cfg));
  const ctx = {
    root,
    cfg,
    readBase,
    readText: (rel) => readText(root, rel),
    graph: getGraph,
  };
  const before = cfg.rules.filter((r) => r.stage !== 'after-triggers');
  const after = cfg.rules.filter((r) => r.stage === 'after-triggers');
  /** @returns {object|null} a full selection, or null when the path was consumed or passed */
  const applyRules = (rules, path) => {
    for (const r of rules) {
      const out = r.rule(path, ctx);
      if (!out) continue;
      if (out.full) return { done: full(path, out.full) };
      for (const a of out.areas ?? []) areas.add(a);
      for (const s of out.specs ?? []) specs.add(s);
      return { done: null };
    }
    return null;
  };

  try {
    for (const path of changed) {
      if (isOutside(path, cfg)) {
        // A tool the harness imports (a spec helper, a config's stack lock) is still on an
        // import edge (D6); the rest are not input.
        if (!startsAny(path, cfg.outside.reach)) continue;
        const hit = getGraph().reach(path);
        if (hit.areas.has('*')) return full(path, 'shell');
        for (const a of hit.areas) areas.add(a);
        for (const s of hit.specs) specs.add(s);
        continue;
      }
      const early = applyRules(before, path);
      if (early?.done) return early.done;
      if (early) continue;
      if (startsAny(path, cfg.triggers)) return full(path, 'trigger');
      const late = applyRules(after, path);
      if (late?.done) return late.done;
      if (late) continue;
      if (path.startsWith(`${specDir}/`) && cfg.specs.match.test(path)) {
        if (existsSync(join(root, path)))
          specs.add(path.slice(specDir.length + 1));
        continue;
      }
      const g = getGraph();
      if (g.unresolved) return full(g.unresolved.importer, 'unresolved');
      const hit = g.reach(path);
      for (const a of hit.areas) areas.add(a);
      if (areas.has('*')) return full(path, 'shell');
      // Load-time code every shell page evaluates, whatever area reaches it.
      if (readBase !== NO_BASE && g.evaluates?.(path)) {
        if (loadTimeChanged(readBase(path), readText(root, path), path))
          return full(path, 'load-time');
        if (g.newlyEvaluatedLoadTime(changed, readBase).has(path))
          return full(path, 'load-time');
      }
      for (const s of hit.specs) specs.add(s);
      if (hit.areas.size > 0 || hit.specs.size > 0) continue;
      if (startsAny(path, cfg.unreachedOk)) continue;
      return full(path, 'unknown');
    }
  } catch (err) {
    if (err instanceof FullSignal) return full(err.path, err.rule);
    throw err;
  }

  if (nightly?.status === 'amber')
    for (const s of nightly.flakySpecs ?? []) specs.add(s);
  for (const [spec, declared] of specHeaders(root, cfg))
    if (declared.some((a) => areas.has(a))) specs.add(spec);

  const sortedAreas = [...areas]
    .filter((a) => cfg.areas === null || cfg.areas.includes(a))
    .sort();
  const sortedSpecs = [...specs].sort();
  return {
    mode: 'affected',
    why: `affected: ${sortedAreas.length} areas, ${sortedSpecs.length} specs`,
    areas: sortedAreas,
    specs: sortedSpecs,
  };
}
