import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { evaluationSpecs, hasLoadTimeCode } from './load-time.mjs';
import { projectSelection } from '../selection/project.mjs';
import { unionGraph } from '../selection/graphs.mjs';
import { lazyTs } from './typescript.mjs';

const ts = lazyTs();

let tsOptions = null;
export const tsOptionsOf = () =>
  (tsOptions ??= {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.Preserve,
  });

export const posix = (p) => p.split('\\').join('/');

// ---------------------------------------------------------------- file helpers

export function listFiles(root, rel, accept) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) visit(p);
      else if (accept(p)) out.push(p);
    }
  };
  visit(rel);
  return out.sort();
}

export const readText = (root, rel) => {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- import graph

/**
 * Parse one file into its import uses and re-exports.
 * uses: [{ spec, names: string[] | null }]  (null = the whole module)
 * exports: pure-barrel re-exports. isBarrel: only import/export-from/type statements.
 */
function parseModule(text, rel) {
  const kind = rel.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : rel.endsWith('.ts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const uses = new Map();
  const addUse = (spec, names) => {
    const prev = uses.get(spec);
    if (prev === undefined) uses.set(spec, names === null ? null : [...names]);
    else if (prev !== null)
      uses.set(spec, names === null ? null : [...prev, ...names]);
  };
  const exports = [];
  let isBarrel = true;
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      const nb = c?.namedBindings;
      if (!c || c.name || (nb && ts.isNamespaceImport(nb))) addUse(spec, null);
      else if (nb && ts.isNamedImports(nb)) {
        const names = nb.elements.map((e) => (e.propertyName ?? e.name).text);
        addUse(spec, names.includes('default') ? null : names);
      }
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      const spec = st.moduleSpecifier.text;
      const c = st.exportClause;
      if (!c) {
        exports.push({ kind: 'star', spec });
        addUse(spec, null);
      } else if (ts.isNamespaceExport(c)) {
        exports.push({ kind: 'ns', spec, exported: c.name.text });
        addUse(spec, null);
      } else {
        const locals = [];
        for (const e of c.elements) {
          const local = (e.propertyName ?? e.name).text;
          exports.push({ kind: 'named', spec, exported: e.name.text, local });
          locals.push(local);
        }
        addUse(spec, locals.includes('default') ? null : locals);
      }
    } else if (
      !ts.isInterfaceDeclaration(st) &&
      !ts.isTypeAliasDeclaration(st)
    ) {
      isBarrel = false;
    }
  }
  for (const spec of ts
    .preProcessFile(text, true, true)
    .importedFiles.map((f) => f.fileName))
    if (!uses.has(spec)) uses.set(spec, null);
  return { uses, exports, isBarrel, sf };
}

/** Names a (non-barrel or barrel) module exports, following `export *`. */
function exportedNamesOf(sf, loadExports, seen = new Set()) {
  const names = new Set();
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
    const exported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods?.some(
      (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
    );
    if (exported && isDefault) names.add('default');
    else if (exported && ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text);
        else
          for (const el of d.name.elements)
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name))
              names.add(el.name.text);
      }
    else if (exported && st.name && ts.isIdentifier(st.name))
      names.add(st.name.text);
    else if (ts.isExportDeclaration(st)) {
      const c = st.exportClause;
      if (c && ts.isNamedExports(c))
        for (const e of c.elements) names.add(e.name.text);
      else if (c && ts.isNamespaceExport(c)) names.add(c.name.text);
      else if (!c && st.moduleSpecifier)
        loadExports(st.moduleSpecifier.text, names, seen);
    } else if (ts.isExportAssignment(st)) names.add('default');
  }
  return names;
}

/** Roots: the files whose closure carries an area. Existing files only. */
export function fileRoots(files, area) {
  return {
    name: 'files',
    entries: (root) =>
      files
        .filter((f) => existsSync(join(root, f)))
        .map((file) => ({ file, area })),
  };
}

/** `prefix` + rest resolved through the project's TypeScript from `${dir}/_.ts`; a miss is unresolved. */
export function alias(prefix, dir) {
  return {
    name: `alias ${prefix}`,
    resolve(spec, _from, ctx) {
      if (!spec.startsWith(prefix)) return null;
      return (
        ctx.viaTs(`./${spec.slice(prefix.length)}`, `${dir}/_.ts`) ?? {
          unresolved: true,
        }
      );
    },
  };
}

/**
 * The import graph source over a checkout. Lazy per file, cached for this graph only.
 * @param {{ roots: object[], resolvers?: object[], skipEdges?: string[][], tables?: string[], loadTime?: boolean }} options
 */
export function jsGraph({
  roots: rootSources,
  resolvers = [],
  skipEdges = [],
  tables = [],
  loadTime = false,
}) {
  return {
    name: 'js',
    graph: (root, cfg) =>
      graphOf(root, cfg, {
        rootSources,
        resolvers,
        skipEdges,
        tables,
        loadTime,
      }),
  };
}

export function buildGraph(root, cfg = projectSelection()) {
  return unionGraph(cfg.graphs, root, cfg);
}

function graphOf(root, cfg, o) {
  const { rootSources, resolvers, skipEdges, tables, loadTime } = o;
  const mods = new Map();
  const resolved = new Map();
  const unresolved = [];
  const leaves = new Set();
  const host = ts.sys;
  const abs = (rel) => join(root, rel);
  const rel = (a) => posix(relative(root, a));

  const load = (file) => {
    if (leaves.has(file)) return null;
    if (mods.has(file)) return mods.get(file);
    const text = readText(root, file);
    const m = text === null ? null : parseModule(text, file);
    mods.set(file, m);
    return m;
  };

  const viaTs = (name, containing) => {
    const r = ts.resolveModuleName(
      name,
      abs(containing),
      tsOptionsOf(),
      host,
    ).resolvedModule;
    if (r && !r.isExternalLibraryImport)
      return { file: rel(r.resolvedFileName) };
    return null;
  };
  const ctx = {
    root,
    viaTs,
    exists: (r) => existsSync(abs(r)),
    readText: (r) => readText(root, r),
  };

  /** -> { file } | { external: true } | { unresolved: true } */
  const resolveSpec = (from, spec) => {
    const key = `${from}\0${spec}`;
    if (resolved.has(key)) return resolved.get(key);
    let out = null;
    for (const r of resolvers) {
      out = r.resolve(spec, from, ctx);
      if (out) break;
    }
    if (out?.leaf) leaves.add(out.file);
    if (!out && spec.startsWith('.')) {
      out = viaTs(spec, from);
      if (!out) {
        const plain = posix(join(dirname(from), spec));
        if (
          /\.[a-z]+$/i.test(spec) &&
          existsSync(abs(plain)) &&
          statSync(abs(plain)).isFile()
        )
          out = { file: plain };
      }
    } else if (!out && !spec.startsWith('.')) {
      out = { external: true };
    }
    out ??= { unresolved: true };
    if (out.unresolved) unresolved.push({ importer: from, spec });
    resolved.set(key, out);
    return out;
  };

  const barrelOf = (file) => {
    const m = load(file);
    return m?.isBarrel ? m : null;
  };

  const exportNamesOfFile = (file, seen = new Set()) => {
    if (seen.has(file)) return new Set();
    seen.add(file);
    const m = load(file);
    if (!m) return new Set();
    return exportedNamesOf(
      m.sf,
      (spec, names, s) => {
        const t = resolveSpec(file, spec);
        if (t.file) for (const n of exportNamesOfFile(t.file, s)) names.add(n);
      },
      seen,
    );
  };

  /** Follow `name` through barrel `b`; null = could not resolve (caller expands b whole). */
  const followName = (b, name, marks, seen) => {
    const key = `${b}\0${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    marks.add(b);
    const m = load(b);
    for (const e of m.exports) {
      if ((e.kind === 'named' || e.kind === 'ns') && e.exported === name) {
        const t = resolveSpec(b, e.spec);
        if (!t.file) return null;
        if (e.kind === 'ns') return [t.file];
        if (barrelOf(t.file)) return followName(t.file, e.local, marks, seen);
        return [t.file];
      }
    }
    for (const e of m.exports) {
      if (e.kind !== 'star') continue;
      const t = resolveSpec(b, e.spec);
      if (!t.file) continue;
      if (barrelOf(t.file)) {
        const r = followName(t.file, name, marks, seen);
        if (r && r.length) return r;
      } else if (exportNamesOfFile(t.file).has(name)) {
        return [t.file];
      }
    }
    return null;
  };

  const edgeCache = new Map();
  /** -> { expand: string[], mark: string[] } */
  const edgesOf = (file) => {
    if (edgeCache.has(file)) return edgeCache.get(file);
    const expand = new Set();
    const mark = new Set();
    const m = load(file);
    if (m) {
      for (const [spec, rawNames] of m.uses) {
        const t = resolveSpec(file, spec);
        if (!t.file || tables.includes(t.file)) continue;
        const names = m.isBarrel ? null : rawNames;
        if (names !== null && barrelOf(t.file)) {
          for (const n of names) {
            const marks = new Set();
            const r = followName(t.file, n, marks, new Set());
            if (r === null) expand.add(t.file);
            else {
              for (const x of marks) mark.add(x);
              for (const x of r) expand.add(x);
            }
          }
        } else expand.add(t.file);
      }
    }
    const out = { expand: [...expand], mark: [...mark] };
    edgeCache.set(file, out);
    return out;
  };

  /** Entry closures skip the `skipEdges` edges; spec closures do not. */
  const skipped = new Set(skipEdges.map(([a, b]) => `${a}\0${b}`));
  const closureOf = (roots, skipEdges = false) => {
    const seen = new Set();
    const expanded = new Set();
    const queue = [...roots];
    for (const r of roots) seen.add(r);
    while (queue.length) {
      const f = queue.pop();
      if (expanded.has(f)) continue;
      expanded.add(f);
      const { expand, mark } = edgesOf(f);
      for (const x of mark) seen.add(x);
      for (const x of expand) {
        if (skipEdges && skipped.has(`${f}\0${x}`)) continue;
        seen.add(x);
        if (!expanded.has(x)) queue.push(x);
      }
    }
    return seen;
  };

  const entries = rootSources.flatMap((r) => r.entries(root));
  const specDir = cfg.specs.dir;
  const specFiles = listFiles(root, specDir, (p) => cfg.specs.match.test(p));

  let entryClosures = null;
  let specClosures = null;
  const prepare = () => {
    entryClosures ??= [
      ...entries.map((e) => ({
        area: e.area,
        set: closureOf([e.file], true),
      })),
      ...skipEdges
        .filter(([, to]) => existsSync(abs(to)))
        .map(([, to, area]) => ({ area, set: closureOf([to], true) })),
    ];
    specClosures ??= specFiles.map((f) => ({
      spec: f.slice(specDir.length + 1),
      set: closureOf([f]),
    }));
  };

  // Everything evaluated when a shell page loads. Module-level edges only
  // (evaluationSpecs), barrels taken whole, skipEdges NOT skipped.
  const evalEdgeCache = new Map();
  // quiet: base text may name a file HEAD no longer has; that is not an unresolved import of HEAD.
  const evalTargets = (file, text, quiet = false) => {
    const out = new Set();
    for (const spec of evaluationSpecs(text, file)) {
      const before = unresolved.length;
      const t = resolveSpec(file, spec);
      if (quiet && t.unresolved) {
        unresolved.length = before;
        resolved.delete(`${file}\0${spec}`);
      }
      if (t.file && !tables.includes(t.file)) out.add(t.file);
    }
    return out;
  };
  const evalEdgesOf = (file) => {
    if (!evalEdgeCache.has(file)) {
      const text = readText(root, file);
      evalEdgeCache.set(
        file,
        text === null ? new Set() : evalTargets(file, text),
      );
    }
    return evalEdgeCache.get(file);
  };
  const shellRoots = () =>
    entries.filter((e) => e.area === '*').map((e) => e.file);
  const evalClosure = (skip = new Set()) => {
    const seen = new Set(shellRoots());
    const queue = [...seen];
    while (queue.length) {
      const f = queue.pop();
      for (const x of evalEdgesOf(f)) {
        if (skip.has(`${f}\0${x}`) || seen.has(x)) continue;
        seen.add(x);
        queue.push(x);
      }
    }
    return seen;
  };
  let evalSet = null;
  const getEvalSet = () => (evalSet ??= evalClosure());
  let newlyMemo = null;

  const loadTimeMembers = () => ({
    /** Is `path` evaluated when any shell page loads? */
    evaluates(path) {
      prepare();
      return getEvalSet().has(path);
    },
    /** The evaluation set, sorted. */
    evaluationSet() {
      prepare();
      return [...getEvalSet()].sort();
    },
    /**
     * Changed paths whose added evaluation edge newly evaluates load-time code.
     * E' skips every changed file's added edges at once; N = E minus E'.
     */
    newlyEvaluatedLoadTime(changed, readBase) {
      prepare();
      if (
        newlyMemo?.readBase === readBase &&
        newlyMemo.key === changed.join('\n')
      )
        return newlyMemo.result;
      const E = getEvalSet();
      const skip = new Set();
      const withAdded = new Set();
      for (const p of changed) {
        if (!E.has(p)) continue;
        const headEdges = evalEdgesOf(p);
        const baseText = readBase(p);
        const baseEdges =
          baseText === null ? new Set() : evalTargets(p, baseText, true);
        for (const t of headEdges)
          if (!baseEdges.has(t)) {
            skip.add(`${p}\0${t}`);
            withAdded.add(p);
          }
      }
      let result = new Set();
      if (withAdded.size > 0) {
        const kept = evalClosure(skip);
        const newly = [...E].filter((f) => !kept.has(f));
        if (
          newly.some((f) => {
            const text = readText(root, f);
            return text !== null && hasLoadTimeCode(text, f);
          })
        )
          result = withAdded;
      }
      newlyMemo = { readBase, key: changed.join('\n'), result };
      return result;
    },
  });

  return {
    /** First unresolved import met by any walk, or null. */
    get unresolved() {
      prepare();
      return unresolved[0] ?? null;
    },
    reach(path) {
      prepare();
      const areas = new Set();
      const specs = new Set();
      for (const c of entryClosures) if (c.set.has(path)) areas.add(c.area);
      for (const c of specClosures) if (c.set.has(path)) specs.add(c.spec);
      return { areas, specs };
    },
    ...(loadTime ? loadTimeMembers() : {}),
    /** Specs whose e2e closure holds `file`. */
    importersOf(file) {
      prepare();
      return specClosures.filter((c) => c.set.has(file)).map((c) => c.spec);
    },
  };
}
