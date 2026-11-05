// The survivors Markdown of the mutation score gate. Pure: the package directory
// the report keys are relative to arrives as `packageDir`.
import { isAbsolute } from 'node:path';

import { summaryLine } from './judge.mjs';

/** Report keys are relative to `packageDir` or absolute; make them repo paths. */
export function repoKey(key, packageDir) {
  if (packageDir === '.') return key;
  if (isAbsolute(key)) {
    const i = key.indexOf(`${packageDir}/`);
    return i === -1 ? key : key.slice(i);
  }
  return key.startsWith(`${packageDir}/`) ? key : `${packageDir}/${key}`;
}

/** Report files by repo path. */
export function reportFiles(report, packageDir) {
  const out = {};
  for (const [k, f] of Object.entries(report?.files ?? {}))
    out[repoKey(k, packageDir)] = f;
  return out;
}

function slice(source, loc) {
  const lines = source.split('\n');
  const first = lines[loc.start.line - 1] ?? '';
  if (loc.end.line === loc.start.line)
    return first.slice(loc.start.column - 1, loc.end.column - 1);
  return `${first.slice(loc.start.column - 1)} ...`;
}

/**
 * The Markdown of the survivors file. `verdicts` carry `path`,
 * `isNew`, `score`, `baseScore`, `reasons`, `changed` (Set of lines, or null
 * for every line); `report` is the branch Stryker report; `sources` optionally
 * overrides a file's source text by repo path; `newDisables` is
 * `[{ path, line, text }]`.
 */
export function renderSurvivors({
  base,
  verdicts,
  report,
  sources = {},
  newDisables = [],
  packageDir,
}) {
  const files = reportFiles(report, packageDir);
  const names = new Map();
  for (const [file, t] of Object.entries(report?.testFiles ?? {}))
    for (const test of t.tests ?? [])
      names.set(test.id, `${file} > ${test.name}`);

  const out = [`# Mutation survivors (base ${base.slice(0, 7)})`, ''];
  out.push(summaryLine(verdicts));
  for (const v of verdicts)
    for (const r of v.reasons) out.push(`mutation: FAIL ${v.path}: ${r}`);
  for (const v of verdicts)
    for (const w of v.warnings ?? [])
      out.push(`mutation: WARN ${v.path}: ${w}`);
  for (const v of verdicts) {
    out.push(
      '',
      `## ${v.path}  score ${v.score} (${v.isNew ? 'new' : `base ${v.baseScore}`})`,
      '',
    );
    const file = files[v.path];
    const source = sources[v.path] ?? file?.source ?? '';
    const open = (file?.mutants ?? [])
      .filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
      .sort(
        (a, b) =>
          a.location.start.line - b.location.start.line ||
          a.location.start.column - b.location.start.column,
      );
    if (!open.length) out.push('- none');
    const regressed = new Set(v.regressed ?? []);
    for (const m of open) {
      const { line, column } = m.location.start;
      const changed = v.changed === null || v.changed?.has(line);
      const tag = changed
        ? ' [changed]'
        : regressed.has(m)
          ? ' [regressed]'
          : '';
      const tests = (m.coveredBy ?? [])
        .map((id) => names.get(id))
        .filter(Boolean);
      const base_ = v.path.split('/').pop();
      out.push(
        `- \`${base_}:${line}:${column}/${m.mutatorName}\` ${m.status}${tag}`,
        `  - original: \`${slice(source, m.location)}\``,
        `  - mutated: \`${m.replacement}\``,
        `  - covered by: ${tests.length ? tests.map((t) => `\`${t}\``).join('; ') : 'none (no coverage)'}`,
      );
    }
  }
  out.push('', '## New disable comments', '');
  if (!newDisables.length) out.push('- none');
  for (const d of newDisables)
    out.push(`- \`${d.path}:${d.line}\` ${d.text.trim()}`);
  return `${out.join('\n')}\n`;
}
