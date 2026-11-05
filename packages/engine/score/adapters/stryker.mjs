// The Stryker adapter of the mutation score gate: how to run the mutation
// tool on the branch and on a base worktree, and which lines disable it.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { fail2, git } from '../base.mjs';

export const DISABLE_WITH_REASON =
  /Stryker\s+disable(?:\s+next-line)?\s+[\w,]+\s*:\s*\S/;

/** Lines of `source` that disable Stryker without a stated reason. */
export function disablesWithoutReason(source) {
  const bad = [];
  source.split('\n').forEach((text, i) => {
    if (!/Stryker\s+disable/.test(text)) return;
    const line = text;
    if (!DISABLE_WITH_REASON.test(line)) bad.push({ line: i + 1 });
  });
  return bad;
}

function runStryker(cmd, args, cwd, label) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0)
    fail2(
      `${label} Stryker run exited ${r.status ?? r.signal}. Run it by hand: cd ${cwd} && ${cmd} ${args.join(' ')}`,
    );
}

function addedDisables(root, base, path, isNew) {
  const found = [];
  if (isNew) {
    readFileSync(join(root, path), 'utf8')
      .split('\n')
      .forEach((text, i) => {
        if (/Stryker\s+disable/.test(text))
          found.push({ path, line: i + 1, text });
      });
    return found;
  }
  const diff = git(root, [
    'diff',
    '-U0',
    '--no-renames',
    '--no-color',
    base,
    '--',
    path,
  ]);
  let line = 0;
  for (const l of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) line = Number(h[1]);
    else if (l.startsWith('+') && !l.startsWith('+++')) {
      if (/Stryker\s+disable/.test(l))
        found.push({ path, line, text: l.slice(1) });
      line++;
    }
  }
  return found;
}

/**
 * `branchCmd`: the command (argv) that runs Stryker for the branch, given
 * `--mutate <files>` appended. `packageDir`: the package the files live in.
 * `config`: Stryker's config file inside it. `reportPath`: the JSON report,
 * relative to the repo root (and to a base worktree).
 */
export function stryker({ branchCmd, packageDir, config, reportPath }) {
  const rel = (t) =>
    packageDir === '.' ? t : t.slice(`${packageDir}/`.length);
  const forceArg = (force) => (force ? ['--force'] : []);
  return {
    name: 'stryker',
    reportPath,
    runBranch({ root, files, force }) {
      rmSync(join(root, reportPath), { force: true });
      runStryker(
        branchCmd[0],
        [
          ...branchCmd.slice(1),
          '--mutate',
          files.map(rel).join(','),
          ...forceArg(force),
        ],
        root,
        'branch',
      );
    },
    runBase({ root, dir, files, force }) {
      const out = join(dir, reportPath);
      rmSync(out, { force: true });
      runStryker(
        join(root, packageDir, 'node_modules', '.bin', 'stryker'),
        [
          'run',
          join(root, packageDir, config),
          '--mutate',
          files.map(rel).join(','),
          ...forceArg(force),
        ],
        join(dir, packageDir),
        'base',
      );
      return out;
    },
    disablesWithoutReason,
    addedDisables,
  };
}
