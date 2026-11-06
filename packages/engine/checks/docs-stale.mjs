// Which pages of a docs folder describe code that has changed since they were last checked. Each
// page starts with a comment:
//
//   guide-sources: <path> <path> ...
//   checked-at: <commit>
//
// docsStale() lists, per page, the files under its sources that changed between `checked-at` and
// HEAD. Pages with no changes are listed as current. Read-only; it never edits a page.
//
// docsStale({ root, dirs, ext, exclude }) -> { code: 0, lines }. Pages are the files of each dir
// ending ext and not in exclude, labelled relative to dirs[0] and sorted. git runs in root.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

export function docsStale({
  root,
  dirs,
  ext = '.html',
  exclude = ['index.html'],
}) {
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', cwd: root }).trim();

  function readStamp(file) {
    const head = readFileSync(join(root, dirs[0], file), 'utf8').slice(0, 2000);
    const sources = /guide-sources:\s*([^\n]+)/
      .exec(head)?.[1]
      .trim()
      .split(/\s+/);
    const checkedAt = /checked-at:\s*(\S+)/.exec(head)?.[1];
    return { sources, checkedAt };
  }

  // The top-level pages first, then each further dir's pages (labelled with their sub path).
  const pages = dirs.flatMap((dir) => {
    const sub = relative(dirs[0], dir).split('\\').join('/');
    const prefix = sub === '' ? '' : `${sub}/`;
    return readdirSync(join(root, dir))
      .filter((f) => f.endsWith(ext) && !exclude.includes(f))
      .map((f) => posix.join(prefix, f));
  });
  const lines = [];
  let stale = 0;
  for (const page of pages.sort()) {
    const { sources, checkedAt } = readStamp(page);
    if (!sources || !checkedAt) {
      lines.push(`${page}: no guide-sources / checked-at stamp`);
      stale += 1;
      continue;
    }
    const changed = git([
      'diff',
      '--stat=120',
      `${checkedAt}..HEAD`,
      '--',
      ...sources,
    ]);
    if (changed === '') {
      lines.push(`${page}: current (checked at ${checkedAt})`);
    } else {
      stale += 1;
      lines.push(`${page}: STALE since ${checkedAt}`);
      lines.push(changed.replace(/^/gm, '    '));
    }
  }
  lines.push('', `${stale} of ${pages.length} pages to review`);
  return { code: 0, lines };
}
