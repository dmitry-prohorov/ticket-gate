import { listFiles, readText } from '../graph/js.mjs';
import { lazyTs } from '../graph/typescript.mjs';

const ts = lazyTs();

export const FRAGMENT_MIN = 8;

// ---------------------------------------------------------------- i18n value rule

export class FullSignal extends Error {
  constructor(path, rule) {
    super(`${path}: ${rule}`);
    this.path = path;
    this.rule = rule;
  }
}

export const unwrap = (e) => {
  let x = e;
  while (
    x &&
    (ts.isAsExpression(x) ||
      ts.isSatisfiesExpression(x) ||
      ts.isParenthesizedExpression(x))
  )
    x = x.expression;
  return x;
};

/** The exported object literal of an i18n table as { map: dotted key -> value, outside }. */
export function parseTable(text, path) {
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let obj = null;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
      continue;
    for (const d of st.declarationList.declarations) {
      const init = unwrap(d.initializer);
      if (init && ts.isObjectLiteralExpression(init)) obj = obj ?? init;
    }
  }
  if (!obj) return null;
  const map = new Map();
  const walkObj = (o, prefix) => {
    let i = 0;
    for (const p of o.properties) {
      const name =
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) ||
          ts.isStringLiteral(p.name) ||
          ts.isNumericLiteral(p.name))
          ? p.name.text
          : null;
      if (name === null) {
        map.set(`${prefix}[${i++}:${p.getText(sf)}]`, {
          nonLiteral: p.getText(sf),
        });
        continue;
      }
      const key = prefix ? `${prefix}.${name}` : name;
      const v = unwrap(p.initializer);
      if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))
        map.set(key, v.text);
      else if (ts.isObjectLiteralExpression(v)) walkObj(v, key);
      else map.set(key, { nonLiteral: v.getText(sf) });
    }
  };
  walkObj(obj, '');
  return {
    map,
    outside: text.slice(0, obj.getStart(sf)) + text.slice(obj.getEnd()),
  };
}

/** Placeholder-free fragments of at least FRAGMENT_MIN characters. */
export const fragmentsOf = (value) =>
  value
    .split(/\{[^}]*\}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= FRAGMENT_MIN);

// ---------------------------------------------------------------- object-table rule

/** Specs holding a changed or removed table key's key, value, or a long fragment of it. */
function tableSpecs(path, ctx) {
  const { root, cfg } = ctx;
  const specDir = cfg.specs.dir;
  const headText = ctx.readText(path);
  const baseText = ctx.readBase(path);
  const head = headText === null ? null : parseTable(headText, path);
  const old = baseText === null ? null : parseTable(baseText, path);
  if (!head || !old || head.outside !== old.outside)
    throw new FullSignal(path, 'i18n-structure');
  const needles = new Set();
  for (const [key, oldValue] of old.map) {
    const now = head.map.get(key);
    if (now !== undefined && JSON.stringify(now) === JSON.stringify(oldValue))
      continue;
    if (
      typeof oldValue !== 'string' ||
      (now !== undefined && typeof now !== 'string')
    )
      throw new FullSignal(path, 'i18n-structure');
    needles.add(key);
    if (oldValue.length > 0) needles.add(oldValue);
    for (const f of fragmentsOf(oldValue)) needles.add(f);
  }
  for (const [key, v] of head.map)
    if (!old.map.has(key) && typeof v !== 'string')
      throw new FullSignal(path, 'i18n-structure');
  if (needles.size === 0) return [];
  const hits = [];
  for (const f of listFiles(
    root,
    specDir,
    (p) => p.endsWith('.ts') && !(cfg.outside.testFile?.test(p) ?? false),
  )) {
    const text = readText(root, f) ?? '';
    if (![...needles].some((n) => text.includes(n))) continue;
    if (cfg.specs.match.test(f)) hits.push(f.slice(specDir.length + 1));
    else hits.push(...ctx.graph().importersOf(f));
  }
  return hits;
}

/** The value rule for exported object-literal tables (today's i18n rule): only changed values select specs. */
export function objectTable(tables) {
  return {
    name: 'object-table',
    rule(path, ctx) {
      if (!tables.includes(path)) return null;
      return { specs: tableSpecs(path, ctx) };
    },
  };
}
