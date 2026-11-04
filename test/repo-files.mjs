// Shared by the repo-level tests: the file set a commit would contain.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const REPO = join(import.meta.dirname, '..');

// Tracked files plus untracked-but-not-ignored ones, so a test run before
// `git add` already sees what the next commit would hold.
export function repoFiles(cwd = REPO) {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd, encoding: 'utf8' },
  );
  // A path deleted in the working tree but still in the index is not in the next commit.
  return [...new Set(out.split('\0').filter(Boolean))]
    .filter((f) => existsSync(join(cwd, f)))
    .sort();
}
