// The command line of the mutation score gate.
//
//   <score command> --base=<ref> [--root=<dir>]
//        [--report=<path> --base-report=<path>] [--files=<p,...>]
//
// Exit 0: pass (or nothing to mutate). 1: a file failed the rule. 2: the
// mutation tool, the report, the worktree or the install failed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { GateError, baseWorktree, git, gitOk, readReport } from './base.mjs';
import { baseToHeadLines, parseChangedLines } from './lines.mjs';
import {
  judge,
  needsForcedRerun,
  regressedMutants,
  scoreFile,
  summaryLine,
  warnings,
} from './judge.mjs';
import { renderSurvivors, reportFiles } from './survivors.mjs';
import { mutationTargets } from './targets.mjs';

/** Runs the gate; returns the exit code. `cfg` is the project config, `root` the default repo root. */
export function runScore(argv, cfg, root0) {
  const opt = (name) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = resolve(opt('root') ?? root0);
  const baseArg = opt('base');
  const adapter = cfg.adapter;
  if (!baseArg) {
    console.error(
      `mutation: FAIL --base=<ref> is required. Run: ${cfg.commands.score} --base=<BASE sha>`,
    );
    return 2;
  }
  try {
    const sha = git(root, [
      'rev-parse',
      '--verify',
      `${baseArg}^{commit}`,
    ]).trim();
    const sha7 = sha.slice(0, 7);
    const paths = opt('files')
      ? opt('files').split(',')
      : [
          ...git(root, ['diff', '--name-only', '--no-renames', sha]).split(
            '\n',
          ),
          ...git(root, ['ls-files', '--others', '--exclude-standard']).split(
            '\n',
          ),
        ].filter(Boolean);
    const targets = mutationTargets(
      paths,
      (p) => existsSync(join(root, p)),
      cfg,
    );
    if (!targets.length) {
      console.log(`mutation: ${cfg.noTargets} vs ${sha7}`);
      return 0;
    }

    let bad = 0;
    for (const t of targets)
      for (const d of adapter.disablesWithoutReason(
        readFileSync(join(root, t), 'utf8'),
      )) {
        console.log(
          `mutation: FAIL ${t}:${d.line}: Stryker disable without a reason`,
        );
        bad++;
      }

    const isNew = Object.fromEntries(
      targets.map((t) => [t, !gitOk(root, ['cat-file', '-e', `${sha}:${t}`])]),
    );
    const existing = targets.filter((t) => !isNew[t]);

    // `force`: the confirming run, which ignores the incremental file and re-tests every mutant.
    const reportPath = opt('report') ?? join(root, adapter.reportPath);
    const branchReport = (force) => {
      if (!opt('report')) adapter.runBranch({ root, files: targets, force });
      return readReport(reportPath, 'branch');
    };
    const baseReportOf = (force) => {
      if (opt('base-report')) return readReport(opt('base-report'), 'base');
      if (!existing.length) return null;
      const dir = baseWorktree(root, sha, cfg);
      const out = adapter.runBase({ root, dir, files: existing, force });
      return readReport(out, 'base');
    };

    const diffOf = (path) =>
      git(root, ['diff', '-U0', '--no-renames', '--no-color', sha, '--', path]);
    const verdictsOf = (report, baseReport) => {
      const branchFiles = reportFiles(report, cfg.packageDir);
      const baseFiles = reportFiles(baseReport, cfg.packageDir);
      return targets.map((path) => {
        const mutants = branchFiles[path]?.mutants ?? [];
        const s = scoreFile(mutants);
        const baseScore = baseFiles[path]
          ? scoreFile(baseFiles[path].mutants).score
          : 100;
        const diff = isNew[path] ? null : diffOf(path);
        const changed = diff === null ? null : parseChangedLines(diff);
        const onChanged = (status) =>
          mutants.filter(
            (m) =>
              m.status === status &&
              (changed === null || changed.has(m.location.start.line)),
          ).length;
        const v = {
          path,
          isNew: isNew[path],
          score: s.score,
          baseScore,
          changed,
          noCoverageOnChanged: onChanged('NoCoverage'),
          survivedOnChanged: onChanged('Survived'),
          survivorsOnChanged: onChanged('Survived') + onChanged('NoCoverage'),
          regressed:
            diff === null
              ? []
              : regressedMutants(
                  baseFiles[path]?.mutants ?? [],
                  mutants,
                  baseToHeadLines(diff),
                ),
        };
        return { ...v, reasons: judge(v, cfg), warnings: warnings(v) };
      });
    };

    let report = branchReport(false);
    let verdicts = verdictsOf(report, baseReportOf(false));
    // A regressed mutant can be a stale incremental result (a static mutant credited
    // to whichever test imported the module): confirm it on fresh runs before failing.
    if (needsForcedRerun(verdicts, !opt('report'))) {
      const n = verdicts.reduce((a, v) => a + v.regressed.length, 0);
      console.log(
        `mutation: ${n} mutant(s) killed on base survive on unchanged lines; confirming with --force (no incremental cache)`,
      );
      report = branchReport(true);
      verdicts = verdictsOf(report, baseReportOf(true));
    }

    for (const v of verdicts)
      for (const r of v.reasons) {
        console.log(`mutation: FAIL ${v.path}: ${r}`);
        bad++;
      }

    const newDisables = targets.flatMap((t) =>
      adapter.addedDisables(root, sha, t, isNew[t]),
    );
    const md = renderSurvivors({
      base: sha,
      verdicts,
      report,
      newDisables,
      packageDir: cfg.packageDir,
    });
    const survivorsFile = join(root, cfg.survivors);
    mkdirSync(dirname(survivorsFile), { recursive: true });
    writeFileSync(survivorsFile, md);
    process.stdout.write(md);
    if (bad)
      console.log(
        `mutation: survivors are in ${cfg.survivors}; ${cfg.handoff}, then rerun: ${cfg.commands.score} --base=${sha7}`,
      );
    console.log(summaryLine(verdicts));
    return bad ? 1 : 0;
  } catch (e) {
    if (e instanceof GateError) {
      console.log(e.message);
      return 2;
    }
    console.log(`mutation: FAIL ${e.stderr ?? e.message}`);
    return 2;
  }
}
