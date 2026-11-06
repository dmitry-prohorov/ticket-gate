import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildGraph, listFiles, readText } from '../graph/js.mjs';
import { lazyTs } from '../graph/typescript.mjs';
import { parseTable } from './value-rules.mjs';
import { projectSelection } from './project.mjs';
import { select, specHeaders } from './select.mjs';

const ts = lazyTs();

// ---------------------------------------------------------------- --for

const LOCATOR_ATTRS = ['role', 'aria-label', 'data-testid', 'data-slot'];

/** Per-file test counts from a `playwright test --list --reporter=json` listing. */
export function testCounts(listJson) {
  const counts = new Map();
  const visit = (suites) => {
    for (const s of suites ?? []) {
      for (const spec of s.specs ?? []) {
        const file = spec.file ?? s.file ?? '';
        counts.set(file, (counts.get(file) ?? 0) + (spec.tests ?? []).length);
      }
      visit(s.suites);
    }
  };
  visit(listJson?.suites);
  return counts;
}

/** Literal attribute values and t('key') keys of a TSX text. */
function locatorsIn(text) {
  const values = new Set();
  const keys = new Set();
  if (text === null) return { values, keys };
  const sf = ts.createSourceFile(
    'x.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const visit = (n) => {
    if (ts.isJsxAttribute(n) && LOCATOR_ATTRS.includes(n.name.getText(sf))) {
      let v = n.initializer;
      if (v && ts.isJsxExpression(v)) v = v.expression;
      if (v && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)))
        values.add(v.text);
    } else if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 't' &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    )
      keys.add(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { values, keys };
}

/** Locator values present in baseText and absent from headText, sorted. */
export function removedLocators(baseText, headText, en) {
  const was = locatorsIn(baseText);
  const now = locatorsIn(headText);
  const removed = new Set();
  for (const v of was.values) if (!now.values.has(v)) removed.add(v);
  for (const key of was.keys) {
    if (now.keys.has(key)) continue;
    const enValue = en.get(key);
    if (typeof enValue === 'string') removed.add(enValue);
  }
  return [...removed].filter((v) => v.length > 0).sort();
}

/** The narrow run for named files (a dev aid; the gate's selection is untouched). */
export function forFiles({
  root: rootArg,
  files,
  readBase = () => null,
  counts,
  budget = 150,
  graph = null,
  config = null,
}) {
  const cfg = config ?? projectSelection();
  const root = rootArg ?? cfg.root;
  const specDir = cfg.specs.dir;
  const enFile = cfg.locale?.table;
  const g = graph ?? buildGraph(root, cfg);
  const headers = specHeaders(root, cfg);
  const gated = [];
  const perFile = [];
  const listed = new Map(); // spec -> areas declaring it (reached ones)
  const reached = new Set();
  const present = [];
  for (const file of files) {
    if (!existsSync(join(root, file))) {
      perFile.push({ file, missing: true, areas: [] });
      continue;
    }
    const one = select({
      root,
      changed: [file],
      readBase,
      graph: g,
      config: cfg,
    });
    if (one.mode === 'full') {
      gated.push({ file, rule: one.rule });
      perFile.push({ file, rule: one.rule, areas: [] });
      continue;
    }
    present.push(file);
    perFile.push({ file, areas: [] });
    for (const a of one.areas) reached.add(a);
    for (const s of one.specs) {
      const declared = (headers.get(s) ?? []).filter((a) =>
        one.areas.includes(a),
      );
      listed.set(s, new Set([...(listed.get(s) ?? []), ...declared]));
    }
    perFile[perFile.length - 1].areas = one.areas;
  }
  const testsOf = (s) => counts.get(s) ?? 0;
  const sizes = new Map();
  for (const a of reached) {
    const declaring = [...headers].filter(([, d]) => d.includes(a));
    sizes.set(a, {
      n: declaring.length,
      tests: declaring.reduce((t, [s]) => t + testsOf(s), 0),
    });
  }
  const groups = [...reached].map((area) => ({
    area,
    tests: sizes.get(area).tests,
    size: sizes.get(area).n,
    specs: [],
  }));
  groups.sort((a, b) => a.tests - b.tests || a.area.localeCompare(b.area));
  const rank = new Map(groups.map((grp, i) => [grp.area, i]));
  for (const f of perFile)
    f.areas = [...f.areas].sort((a, b) => rank.get(a) - rank.get(b));
  const direct = { area: 'direct', tests: 0, size: 0, specs: [] };
  const placed = new Set();
  for (const grp of groups)
    for (const [s, declared] of [...listed].sort()) {
      if (!declared.has(grp.area) || placed.has(s)) continue;
      placed.add(s);
      grp.specs.push({ spec: s, tests: testsOf(s) });
    }
  for (const [s] of [...listed].sort())
    if (!placed.has(s)) direct.specs.push({ spec: s, tests: testsOf(s) });
  for (const grp of [...groups, direct]) {
    if (grp.area === 'direct') {
      grp.size = grp.specs.length;
      grp.tests = grp.specs.reduce((t, x) => t + x.tests, 0);
    }
  }
  const out = direct.specs.length > 0 ? [direct, ...groups] : groups;
  const all = [...listed.keys()].sort();
  const tests = all.reduce((t, s) => t + testsOf(s), 0);
  const overBudget = tests > budget;
  let specs = all;
  let filtered = null;
  if (overBudget) {
    const headEn = enFile ? readText(root, enFile) : null;
    const baseEn = enFile ? readBase(enFile) : null;
    const en = new Map([
      ...(baseEn === null ? [] : (parseTable(baseEn, enFile)?.map ?? [])),
      ...(headEn === null ? [] : (parseTable(headEn, enFile)?.map ?? [])),
    ]);
    const locators = [
      ...new Set(
        present.flatMap((f) =>
          removedLocators(readBase(f), readText(root, f), en),
        ),
      ),
    ].sort();
    const keep = new Set();
    const listedSet = new Set(all);
    for (const f of listFiles(root, specDir, (p) => p.endsWith('.ts'))) {
      const text = readText(root, f) ?? '';
      if (!locators.some((l) => text.includes(l))) continue;
      const rel = f.slice(specDir.length + 1);
      for (const s of cfg.specs.match.test(f) ? [rel] : g.importersOf(f))
        if (listedSet.has(s)) keep.add(s);
    }
    specs = all.filter((s) => keep.has(s));
    filtered = { kept: specs.length, of: all.length, locators };
  }
  return {
    gated,
    files: perFile,
    groups: out,
    total: tests,
    filtered,
    specs,
    command:
      specs.length === 0
        ? 'none'
        : `${cfg.runner.command} ${specs.map((s) => `${cfg.runner.specPrefix}${s}`).join(' ')}`,
  };
}

/** Printed lines for a ForResult. */
export function forLines(result, budget) {
  const lines = [];
  for (const f of result.files) {
    if (f.missing) lines.push(`${f.file}: not found`);
    else if (f.rule) lines.push(`${f.file}: ${f.rule}: use the gate`);
    else lines.push(`${f.file}: ${f.areas.join(', ') || 'no area'}`);
  }
  for (const grp of result.groups) {
    lines.push(`  ${grp.area} ${grp.size} specs / ${grp.tests} tests`);
    for (const s of grp.specs) lines.push(`    ${s.spec} (${s.tests})`);
  }
  const areas = result.groups.filter((x) => x.area !== 'direct').length;
  const listedSpecs = result.groups.reduce((n, x) => n + x.specs.length, 0);
  lines.push(
    `for: ${result.files.length} files, ${areas} areas, ${listedSpecs} specs, ${result.total} tests (budget ${budget})`,
  );
  if (result.filtered) {
    const f = result.filtered;
    lines.push(
      `filtered: ${f.kept} of ${f.of} specs by ${f.locators.length} removed locators`,
      `locators: ${f.locators.join(', ')}`,
      'limit: an implicit role change (a <button> becoming role="radio") is not a removed locator',
    );
  }
  lines.push(result.command);
  return lines;
}
