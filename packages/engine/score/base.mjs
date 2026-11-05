// Git, report and base-worktree helpers of the mutation score gate. Every
// project value (install command, marker, worktree folder) arrives as `cfg`.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { schemaProblem } from './schema.mjs';

export class GateError extends Error {}

export const fail2 = (msg) => {
  throw new GateError(`mutation: FAIL ${msg}`);
};

export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export const gitOk = (cwd, args) => {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
};

export function readReport(path, label) {
  if (!existsSync(path)) fail2(`${label} report missing: ${path}`);
  let report;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail2(`${label} report unreadable: ${path} (${e.message})`);
  }
  const problem = schemaProblem(report);
  if (problem) fail2(`${label} report ${path}: ${problem}`);
  return report;
}

/** The install runner for a `baseInstall` config: `(dir) => spawnResult`. */
export const installWith = (baseInstall) => (dir) =>
  spawnSync(baseInstall.cmd, baseInstall.args, { cwd: dir, stdio: 'inherit' });

export function ensureBaseInstall(dir, sha, install, cfg) {
  const { baseInstall } = cfg;
  if (!existsSync(join(dir, baseInstall.marker))) {
    const r = install(dir);
    if (r.status !== 0)
      fail2(
        `${baseInstall.label} in the base worktree ${dir} exited ${r.status}. Run it by hand: cd ${dir} && ${baseInstall.hint}`,
      );
    writeFileSync(join(dir, baseInstall.marker), sha);
  }
}

export function baseWorktree(root, sha, cfg) {
  const dir = join(tmpdir(), cfg.worktreeDir, sha.slice(0, 12));
  try {
    git(root, ['worktree', 'prune']);
    const head = existsSync(dir)
      ? git(dir, ['rev-parse', 'HEAD']).trim()
      : null;
    if (head !== sha) {
      if (existsSync(dir)) {
        gitOk(root, ['worktree', 'remove', '--force', dir]);
        rmSync(dir, { recursive: true, force: true });
      }
      git(root, ['worktree', 'add', '--detach', dir, sha]);
    }
  } catch (e) {
    fail2(`base worktree ${dir} failed: ${e.stderr ?? e.message}`);
  }
  ensureBaseInstall(dir, sha, installWith(cfg.baseInstall), cfg);
  return dir;
}
