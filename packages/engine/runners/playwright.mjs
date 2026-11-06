import { execFileSync } from 'node:child_process';

import { projectSelection } from '../selection/project.mjs';

const ERROR_CAP = 2000;

/** Walks Playwright's nested suites, calling visit(spec, test) for each test. */
export function walkReport(suites, visit) {
  for (const s of suites ?? []) {
    for (const spec of s.specs ?? [])
      for (const t of spec.tests ?? []) visit(spec, t, s);
    walkReport(s.suites, visit);
  }
}

/** Playwright JSON -> { stats, failedSpecs, flakySpecs, redTests }; null stats = interrupted. */
export function summarizeReport(playwrightJson) {
  const report = playwrightJson ?? {};
  const stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  const failed = new Set();
  const flaky = new Set();
  const redTests = [];
  const navigation = {};
  walkReport(report.suites, (spec, t) => {
    if (t.status in stats) stats[t.status] += 1;
    const file = spec.file ?? '';
    const notes = [
      ...(t.annotations ?? []),
      ...(t.results ?? []).flatMap((r) => r.annotations ?? []),
    ];
    for (const a of notes) {
      if (a?.type !== 'e2e-nav') continue;
      const seen = (navigation[file] ??= []);
      for (const p of String(a.description ?? '').split(' '))
        if (p !== '' && !seen.includes(p)) seen.push(p);
    }
    if (t.status === 'unexpected') {
      failed.add(file);
      const last = (t.results ?? []).at(-1);
      const msg = last?.error?.message ?? last?.errors?.[0]?.message ?? '';
      redTests.push({
        file,
        title: spec.title,
        project: t.projectName,
        error: String(msg).slice(0, ERROR_CAP),
      });
    }
    if (t.status === 'flaky') flaky.add(file);
  });
  return {
    stats: report.stats ? stats : null,
    failedSpecs: [...failed].sort(),
    flakySpecs: [...flaky].sort(),
    redTests,
    navigation,
  };
}

// ---------------------------------------------------------------- shadow and test list

const isSmoke = (spec, t) =>
  [...(spec.tags ?? []), ...(t.tags ?? [])].some(
    (x) => String(x).replace(/^@/, '') === 'smoke',
  ) || /@smoke\b/.test(spec.title ?? '');

/** What a partial run would have missed (R6). Never changes the gate's result. */
export function shadowOf(selection, report, cfg = projectSelection()) {
  const selected = new Set(selection.specs);
  const base = {
    mode: selection.mode,
    why: selection.why,
    selected: [...selection.specs],
  };
  if (selection.mode === 'full') return { ...base, missed: [] };
  if (report == null) return { ...base, missed: null, error: 'no-report' };
  const failed = new Set();
  walkReport(report.suites, (spec, t) => {
    if (t.status !== 'unexpected') return;
    const file = spec.file ?? '';
    if (cfg.specs.setup.has(file) || isSmoke(spec, t)) return;
    failed.add(file);
  });
  const failedFiles = [...failed];
  const missed = failedFiles.filter((f) => !selected.has(f));
  return { ...base, missed: missed.sort() };
}

/** Lines for `playwright test --test-list`: every test of a selected file plus smoke tests. */
export function testListLines(listJson, selection) {
  if (selection.mode === 'full') return null;
  const selected = new Set(selection.specs);
  const lines = new Set();
  const visit = (suites, titles) => {
    for (const s of suites ?? []) {
      const own = titles.length === 0 && s.title === s.file ? [] : [s.title];
      const path = [...titles, ...own.filter(Boolean)];
      for (const spec of s.specs ?? []) {
        const file = spec.file ?? s.file ?? '';
        for (const t of spec.tests ?? [])
          if (selected.has(file) || isSmoke(spec, t))
            lines.add(`${file} › ${[...path, spec.title].join(' › ')}`);
      }
      visit(s.suites, path);
    }
  };
  visit(listJson?.suites, []);
  return [...lines];
}

// ---------------------------------------------------------------- runner

/**
 * The Playwright runner adapter. `cmd` is the command that runs `playwright test` from the repo
 * root; `specPrefix` is the spec path prefix that command takes.
 */
export function playwright({ cmd, specPrefix }) {
  return {
    name: 'playwright',
    command: cmd.join(' '),
    specPrefix,
    list: (cwd) =>
      JSON.parse(
        execFileSync(cmd[0], [...cmd.slice(1), '--list', '--reporter=json'], {
          cwd,
          encoding: 'utf8',
          maxBuffer: 1 << 28,
        }),
      ),
    summarize: summarizeReport,
    invertFlag: '--test-list-invert',
  };
}
