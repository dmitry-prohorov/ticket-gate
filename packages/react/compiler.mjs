// React Compiler bailout ratchet, as a pack check. Runs babel-plugin-react-compiler
// over every .ts/.tsx file of the configured scan dirs, the way the bundlers do, and
// compares what it could not compile with a baseline file.
//
// A bailout (the compiler gave up on a function) that is not in the baseline fails
// the check. So does a "skip": a top-level function named like a component or hook
// that the compiler emitted no event for (compilationMode infer drops a use* hook
// that calls no hook). A baseline entry whose function now compiles also fails, so
// the baseline can only shrink by itself.
//
// Every project value (scan dirs, exclude pattern, where @babel/core and the plugin
// resolve from, baseline path, message texts) is an option of reactCompiler().
// run(argv) takes --update, --seed, --root=<dir>, --baseline=<path> and returns
// { code, out, err }; it never prints and never exits.
//
// Exit codes: 0 green, 1 a new, stale, unreasoned or skipped function or a plugin-version
// mismatch, 2 the plugin did not load or a file did not parse.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const PLUGIN = 'babel-plugin-react-compiler';
export const COMPONENT_OR_HOOK = /^(use[A-Z0-9]|[A-Z])/;

class CheckFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new CheckFailure(code, message);
};

/** `@babel/core` and the plugin as the first package of `via` resolves them, step by step. */
function loadCompiler(repo, { from, via }, install) {
  try {
    let req = createRequire(join(repo, from, 'package.json'));
    for (const spec of via) {
      let dir = dirname(req.resolve(spec));
      while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
      req = createRequire(join(dir, 'package.json'));
    }
    const pluginEntry = req.resolve(PLUGIN);
    let pdir = dirname(pluginEntry);
    const nameOf = (d) =>
      existsSync(join(d, 'package.json'))
        ? JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).name
        : null;
    while (nameOf(pdir) !== PLUGIN) pdir = dirname(pdir);
    return {
      babel: req('@babel/core'),
      plugin: req(PLUGIN),
      version: JSON.parse(readFileSync(join(pdir, 'package.json'), 'utf8'))
        .version,
    };
  } catch (e) {
    return fail(
      2,
      `could not load @babel/core and ${PLUGIN} through ${via.at(-1)} (${e.message}). Run \`${install}\`.`,
    );
  }
}

const isFn = (n) =>
  n &&
  (n.type === 'FunctionDeclaration' ||
    n.type === 'FunctionExpression' ||
    n.type === 'ArrowFunctionExpression');

const sameStart = (node, loc) =>
  node.loc?.start.line === loc?.start?.line &&
  node.loc?.start.column === loc?.start?.column;

/** Visit every node with its parent. */
function walk(node, parent, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (
      key === 'loc' ||
      key === 'leadingComments' ||
      key === 'trailingComments' ||
      key === 'innerComments'
    )
      continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, node, visit);
    else if (v && typeof v === 'object') walk(v, node, visit);
  }
}

/** R2: the logger names only successes, so a bailout takes its name from the AST. */
function nameAt(ast, fnLoc) {
  let name = null;
  const parents = new Map();
  walk(ast, null, (node, parent) => {
    parents.set(node, parent);
    if (name !== null || !isFn(node) || !sameStart(node, fnLoc)) return;
    if (node.id?.name) {
      name = node.id.name;
      return;
    }
    let up = parents.get(node);
    while (up?.type === 'CallExpression') up = parents.get(up);
    if (up?.type === 'VariableDeclarator' && up.id.type === 'Identifier')
      name = up.id.name;
    else if (up?.type === 'ExportDefaultDeclaration') name = 'default';
    else name = '<anonymous>';
  });
  return name ?? '<anonymous>';
}

const WRAPPERS = /^(forwardRef|memo)$/;
const calleeName = (call) =>
  call.callee.name ?? call.callee.property?.name ?? '';

/** Top-level functions: { name, node }. */
function topLevelFunctions(ast) {
  const out = [];
  for (const stmt of ast.program.body) {
    const decl =
      stmt.type === 'ExportNamedDeclaration' ||
      stmt.type === 'ExportDefaultDeclaration'
        ? stmt.declaration
        : stmt;
    if (decl?.type === 'FunctionDeclaration' && decl.id)
      out.push({ name: decl.id.name, node: decl });
    else if (decl?.type === 'VariableDeclaration')
      for (const d of decl.declarations) {
        if (d.id.type !== 'Identifier') continue;
        let init = d.init;
        while (
          init?.type === 'CallExpression' &&
          WRAPPERS.test(calleeName(init))
        )
          init = init.arguments.find(
            (a) => isFn(a) || a.type === 'CallExpression',
          );
        if (isFn(init)) out.push({ name: d.id.name, node: init });
      }
  }
  return out;
}

const categoryOf = (e) =>
  e.kind === 'PipelineError'
    ? 'Pipeline'
    : (e.detail?.category ?? e.detail?.options?.category ?? 'Unknown');
const reasonOf = (e) =>
  e.detail?.reason ??
  e.detail?.options?.reason ??
  (typeof e.data === 'string' ? e.data : 'unknown');

function listFiles(root, scanDirs, exclude) {
  const r = spawnSync('git', ['ls-files', '--', ...scanDirs], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0)
    fail(
      2,
      `git ls-files failed in ${root}: ${r.stderr.trim()}. Run it inside a git work tree.`,
    );
  return r.stdout
    .split('\n')
    .filter(
      (f) => /\.tsx?$/.test(f) && !exclude.test(f) && existsSync(join(root, f)),
    )
    .sort();
}

export function scan(root, { babel, plugin }, { scanDirs, exclude }) {
  const files = listFiles(root, scanDirs, exclude);
  const bailouts = new Map();
  const skipped = [];
  let compiled = 0;
  for (const path of files) {
    const events = [];
    const options = {
      babelrc: false,
      configFile: false,
      filename: join(root, path),
      parserOpts: {
        plugins: path.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
      },
    };
    const code = readFileSync(join(root, path), 'utf8');
    let ast;
    try {
      babel.transformSync(code, {
        ...options,
        plugins: [
          [
            plugin,
            {
              target: '19',
              panicThreshold: 'none',
              logger: { logEvent: (_f, event) => events.push(event) },
            },
          ],
        ],
      });
      ast = babel.parseSync(code, options);
    } catch (e) {
      return fail(
        2,
        `${path} did not parse or transform: ${String(e.message).split('\n')[0]}. Fix the syntax error first.`,
      );
    }
    for (const e of events) {
      if (e.kind === 'CompileSuccess') compiled += 1;
      if (e.kind !== 'CompileError' && e.kind !== 'PipelineError') continue;
      const name = nameAt(ast, e.fnLoc);
      const category = categoryOf(e);
      const key = `${path}|${name}|${category}`;
      if (!bailouts.has(key))
        bailouts.set(key, {
          key,
          path,
          line: e.fnLoc?.start?.line ?? 0,
          name,
          category,
          reason: reasonOf(e),
        });
    }
    for (const { name, node } of topLevelFunctions(ast)) {
      if (!COMPONENT_OR_HOOK.test(name)) continue;
      if (events.some((e) => e.fnLoc && sameStart(node, e.fnLoc))) continue;
      skipped.push({
        key: `${path}|${name}`,
        path,
        line: node.loc.start.line,
        name,
      });
    }
  }
  return {
    files: files.length,
    compiled,
    bailouts: [...bailouts.values()],
    skipped,
  };
}

export function compare(report, baseline) {
  const known = new Set(baseline.bailouts.map((e) => e.key));
  const current = new Set(report.bailouts.map((b) => b.key));
  const allowedSkips = new Set(baseline.skipped.map((e) => e.key));
  const currentSkips = new Set(report.skipped.map((s) => s.key));
  const entries = [...baseline.bailouts, ...baseline.skipped];
  const fresh = report.bailouts.filter((b) => !known.has(b.key));
  const stale = baseline.bailouts.filter((e) => !current.has(e.key));
  const staleSkips = baseline.skipped.filter((e) => !currentSkips.has(e.key));
  const unskipped = report.skipped.filter((s) => !allowedSkips.has(s.key));
  const unreasoned = entries.filter((e) => e.allow === '');
  return {
    fresh,
    stale: [...stale, ...staleSkips],
    unskipped,
    unreasoned,
  };
}

const byKey = (p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0);

/** Next baseline for the current scan (rules in the header). */
export function updateBaseline(
  report,
  baseline,
  version,
  { seed = false, comment } = {},
) {
  const old = new Map(
    [...baseline.bailouts, ...baseline.skipped].map((e) => [e.key, e]),
  );
  const withAllow = (entry) => {
    const prev = old.get(entry.key);
    if (prev?.allow !== undefined) entry.allow = prev.allow;
    else if (!prev && !seed) entry.allow = '';
    return entry;
  };
  return {
    comment: comment,
    plugin: version,
    bailouts: report.bailouts
      .map((b) => withAllow({ key: b.key, reason: b.reason }))
      .sort(byKey),
    skipped: report.skipped.map((s) => withAllow({ key: s.key })).sort(byKey),
  };
}

function loadBaseline(path, version) {
  try {
    const b = JSON.parse(readFileSync(path, 'utf8'));
    return { ...b, bailouts: b.bailouts ?? [], skipped: b.skipped ?? [] };
  } catch {
    return { plugin: version, bailouts: [], skipped: [] };
  }
}

export function reactCompiler({
  repo,
  scanDirs,
  exclude,
  resolve: resolveVia,
  baseline: baselineRel,
  comment,
  name,
  update,
  install,
}) {
  const scope = { scanDirs, exclude };

  function run(argv) {
    const out = [];
    try {
      const opt = (flag) =>
        argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);
      const root = resolve(opt('root') ?? repo);
      const baselinePath = resolve(opt('baseline') ?? join(root, baselineRel));
      const compiler = loadCompiler(repo, resolveVia, install);
      const pluginVersion = compiler.version;
      const report = scan(root, compiler, scope);
      const baseline = loadBaseline(baselinePath, pluginVersion);

      if (argv.includes('--update')) {
        const next = updateBaseline(report, baseline, pluginVersion, {
          seed: argv.includes('--seed'),
          comment,
        });
        writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
        out.push(
          `${name}: baseline rewritten, ${next.bailouts.length} bailouts, ${next.skipped.length} skips.`,
        );
        return { code: 0, out, err: [] };
      }

      const { fresh, stale, unskipped, unreasoned } = compare(report, baseline);
      let problems = 0;
      if (baseline.plugin !== pluginVersion) {
        problems += 1;
        out.push(
          `plugin ${pluginVersion} != baseline ${baseline.plugin}: re-seed with --update`,
        );
      }
      for (const b of fresh) {
        problems += 1;
        out.push(
          `new bailout: ${b.path}:${b.line} ${b.name} [${b.category}] ${b.reason}`,
        );
      }
      for (const e of stale) {
        problems += 1;
        out.push(`stale: ${e.key} (fixed - run ${update})`);
      }
      for (const s of unskipped) {
        problems += 1;
        out.push(
          `skipped: ${s.path}:${s.line} ${s.name} is named like a component or hook but was not compiled ('use memo', or an allow entry)`,
        );
      }
      for (const e of unreasoned) {
        problems += 1;
        out.push(`unreasoned: ${e.key}`);
      }
      const debt = baseline.bailouts.filter(
        (e) => e.allow === undefined,
      ).length;
      const allowed = baseline.bailouts.length - debt;
      out.push(
        `${name}: ${report.files} files, ${report.compiled} compiled functions, ${report.bailouts.length} bailouts (${debt} debt, ${allowed} allowed), ${baseline.skipped.length} allowed skips`,
      );
      return { code: problems > 0 ? 1 : 0, out, err: [] };
    } catch (e) {
      if (e instanceof CheckFailure)
        return { code: e.code, out: [], err: [`${name}: ${e.message}`] };
      throw e;
    }
  }

  return {
    scan: (root, compiler) => scan(root, compiler, scope),
    compare,
    updateBaseline: (report, baselineJson, version, { seed = false } = {}) =>
      updateBaseline(report, baselineJson, version, { seed, comment }),
    run,
  };
}
