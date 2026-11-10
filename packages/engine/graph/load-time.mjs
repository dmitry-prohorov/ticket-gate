/**
 * Load-time code. A module's top-level statement either only declares something
 * (inert: a function, a literal table, an import) or does work when the module is evaluated
 * (a call, a `new`, a template with a substitution). Evaluating a module happens on every
 * page that imports it, so a changed load-time statement can break any spec.
 *
 * When in doubt a statement is load-time code.
 * Dependency-free Node ESM plus `typescript` (a root devDependency).
 */

import { lazyTs } from './typescript.mjs';

const ts = lazyTs();
const K = new Proxy({}, { get: (_, key) => ts.SyntaxKind[key] });

/** @typedef {{ text: string, loadTime: boolean }} Unit */

let printerInstance = null;
const printer = {
  printNode: (...a) =>
    (printerInstance ??= ts.createPrinter({ removeComments: true })).printNode(
      ...a,
    ),
};

const scriptKind = (fileName) =>
  fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.ts') || fileName.endsWith('.mts')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;

const parse = (source, fileName) =>
  ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );

const hasModifier = (node, kind) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

/** interface, type alias, `declare ...`, `import type`, `export type ... from`: no runtime form. */
function isTypeOnlyStatement(st) {
  if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st))
    return true;
  if (hasModifier(st, K.DeclareKeyword)) return true;
  if (ts.isImportDeclaration(st)) return st.importClause?.isTypeOnly === true;
  if (ts.isExportDeclaration(st)) return st.isTypeOnly;
  if (ts.isImportEqualsDeclaration(st)) return st.isTypeOnly;
  return false;
}

const unwrap = (e) => {
  let x = e;
  while (
    ts.isAsExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isTypeAssertionExpression(x) ||
    ts.isParenthesizedExpression(x)
  )
    x = x.expression;
  return x;
};

const staticName = (name) =>
  name !== undefined && !ts.isComputedPropertyName(name);

/** Every identifier a binding name (identifier or nested pattern) declares. */
function bindingNames(name, names) {
  if (ts.isIdentifier(name)) names.add(name.text);
  else
    for (const el of name.elements)
      if (ts.isBindingElement(el)) bindingNames(el.name, names);
}

/** Names the module declares itself at the top level (not imports): `extends` of one is load-time. */
function localNames(sf) {
  const names = new Set();
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        bindingNames(d.name, names);
      }
    } else if (
      (ts.isClassDeclaration(st) ||
        ts.isFunctionDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name
    )
      names.add(st.name.text);
  }
  return names;
}

function classInert(cls, locals) {
  if (ts.canHaveDecorators(cls) && (ts.getDecorators(cls) ?? []).length > 0)
    return false;
  for (const h of cls.heritageClauses ?? []) {
    if (h.token !== K.ExtendsKeyword) continue;
    for (const t of h.types) {
      const e = t.expression;
      if (!ts.isIdentifier(e) || locals.has(e.text)) return false;
    }
  }
  for (const m of cls.members) {
    if (ts.canHaveDecorators(m) && (ts.getDecorators(m) ?? []).length > 0)
      return false;
    if (ts.isClassStaticBlockDeclaration(m)) return false;
    if (m.name && ts.isComputedPropertyName(m.name)) return false;
    if (
      ts.isPropertyDeclaration(m) &&
      hasModifier(m, K.StaticKeyword) &&
      m.initializer
    )
      return false;
  }
  return true;
}

const isNumericOperand = (e) => ts.isNumericLiteral(e) || ts.isBigIntLiteral(e);

/** true = proved inert (evaluating it does no work and reads no other module's state). */
function exprInert(node, locals) {
  const e = unwrap(node);
  switch (e.kind) {
    case K.StringLiteral:
    case K.NumericLiteral:
    case K.BigIntLiteral:
    case K.NoSubstitutionTemplateLiteral:
    case K.RegularExpressionLiteral:
    case K.TrueKeyword:
    case K.FalseKeyword:
    case K.NullKeyword:
    case K.ArrowFunction:
    case K.FunctionExpression:
      return true;
    case K.PrefixUnaryExpression:
      return (
        (e.operator === K.MinusToken || e.operator === K.PlusToken) &&
        isNumericOperand(e.operand)
      );
    case K.ClassExpression:
      return classInert(e, locals);
    case K.ArrayLiteralExpression:
      return e.elements.every(
        (x) => ts.isOmittedExpression(x) || exprInert(x, locals),
      );
    case K.ObjectLiteralExpression:
      return e.properties.every((p) => {
        if (ts.isPropertyAssignment(p))
          return staticName(p.name) && exprInert(p.initializer, locals);
        if (
          ts.isMethodDeclaration(p) ||
          ts.isGetAccessorDeclaration(p) ||
          ts.isSetAccessorDeclaration(p)
        )
          return staticName(p.name);
        return false;
      });
    case K.CallExpression: {
      const c = e.expression;
      return (
        ts.isPropertyAccessExpression(c) &&
        ts.isIdentifier(c.expression) &&
        c.expression.text === 'Object' &&
        c.name.text === 'freeze' &&
        e.arguments.every((a) => exprInert(a, locals))
      );
    }
    default:
      return false; // fact 2: an expression not proved inert
  }
}

function enumInert(en, locals) {
  return en.members.every(
    (m) =>
      !m.initializer ||
      (exprInert(m.initializer, locals) &&
        !ts.isArrowFunction(unwrap(m.initializer)) &&
        !ts.isFunctionExpression(unwrap(m.initializer))),
  );
}

/** true = load-time code. */
function statementLoadTime(st, locals) {
  if (
    ts.isImportDeclaration(st) ||
    ts.isExportDeclaration(st) ||
    ts.isImportEqualsDeclaration(st) ||
    ts.isFunctionDeclaration(st) ||
    ts.isEmptyStatement(st)
  )
    return false;
  if (ts.isClassDeclaration(st)) return !classInert(st, locals);
  if (ts.isEnumDeclaration(st)) return !enumInert(st, locals);
  if (ts.isExpressionStatement(st)) return !ts.isStringLiteral(st.expression); // a directive is inert
  if (ts.isVariableStatement(st)) {
    const list = st.declarationList;
    // `await using` and `using` share the Const bit; only a plain `const` can be inert
    if ((list.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const)
      return true;
    return !list.declarations.every(
      (d) =>
        ts.isIdentifier(d.name) &&
        d.initializer !== undefined &&
        exprInert(d.initializer, locals),
    );
  }
  return true; // fact 2: a statement not proved inert is load-time code
}

/**
 * Statement units in order. Text is the comment-free printed statement, so comment-only and
 * whitespace-only edits are no change. Type-only statements yield no unit.
 * @returns {Unit[]}
 */
export function loadTimeUnits(source, fileName = 'x.ts') {
  const sf = parse(source, fileName);
  const locals = localNames(sf);
  const units = [];
  for (const st of sf.statements.filter((x) => !isTypeOnlyStatement(x))) {
    units.push({
      text: printer.printNode(ts.EmitHint.Unspecified, st, sf),
      loadTime: statementLoadTime(st, locals),
    });
  }
  return units;
}

export function hasLoadTimeCode(source, fileName = 'x.ts') {
  return loadTimeUnits(source, fileName).some((u) => u.loadTime);
}

/** Texts keyed with their occurrence index, so duplicates keep their identity. */
function keyed(units) {
  const seen = new Map();
  return units.map((u) => {
    const n = seen.get(u.text) ?? 0;
    seen.set(u.text, n + 1);
    return `${n}\0${u.text}`;
  });
}

/** The units both sides hold, in base order, differ in order from head order. */
function orderChanged(b, h) {
  const bk = keyed(b);
  const hk = keyed(h);
  const inHead = new Set(hk);
  const inBase = new Set(bk);
  const commonB = bk.filter((k) => inHead.has(k));
  const commonH = hk.filter((k) => inBase.has(k));
  return commonB.some((k, i) => k !== commonH[i]);
}

/**
 * R4: did a load-time statement get added, removed, edited, or reordered?
 * base === null: the file is new, every load-time unit is added. head === null: removed,
 * which is not a hit here (F3 names edits and added imports only).
 */
export function loadTimeChanged(base, head, fileName = 'x.ts') {
  if (head === null) return false;
  const b = base === null ? [] : loadTimeUnits(base, fileName);
  const h = loadTimeUnits(head, fileName);
  const bl = b.filter((u) => u.loadTime).map((u) => u.text);
  const hl = h.filter((u) => u.loadTime).map((u) => u.text);
  if (bl.length !== hl.length || bl.some((t, i) => t !== hl[i])) return true;
  const anyLoadTime = hl.length > 0;
  if (anyLoadTime && orderChanged(b, h)) return true;
  return false;
}

/** Module specifiers evaluated when the file loads (type-only statements add none). */
export function evaluationSpecs(source, fileName = 'x.ts') {
  const sf = parse(source, fileName);
  const out = new Set();
  const calls = (node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === K.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
    )
      out.add(node.arguments[0].text);
    ts.forEachChild(node, calls);
  };
  for (const st of sf.statements) {
    if (isTypeOnlyStatement(st)) continue;
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) {
      if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier))
        out.add(st.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(st) &&
      ts.isExternalModuleReference(st.moduleReference) &&
      ts.isStringLiteral(st.moduleReference.expression)
    )
      out.add(st.moduleReference.expression.text);
    calls(st);
  }
  return [...out];
}
