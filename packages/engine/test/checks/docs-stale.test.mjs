import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { docsStale } from '../../checks/docs-stale.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'docs-stale-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const git = (...args) =>
  execFileSync('git', args, { cwd: tmp, encoding: 'utf8' }).trim();

const stamp = (sources, at) =>
  `<!-- guide-sources: ${sources}\nchecked-at: ${at} -->\n<p>page</p>\n`;

test('DS-1 docsStale lists current, stale, unstamped and ru/ pages', () => {
  mkdirSync(join(tmp, 'g', 'ru'), { recursive: true });
  mkdirSync(join(tmp, 'src'));
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(tmp, 'src', 'a.txt'), 'one\n');
  writeFileSync(join(tmp, 'src', 'b.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const first = git('rev-parse', '--short', 'HEAD');
  writeFileSync(join(tmp, 'src', 'a.txt'), 'one\ntwo\n');
  git('commit', '-q', '-am', 'second');
  writeFileSync(join(tmp, 'g', 'current.html'), stamp('src/b.txt', first));
  writeFileSync(join(tmp, 'g', 'stale.html'), stamp('src/a.txt', first));
  writeFileSync(join(tmp, 'g', 'ru', 'unstamped.html'), '<p>no stamp</p>\n');
  writeFileSync(join(tmp, 'g', 'index.html'), '<p>skipped</p>\n');

  const r = docsStale({ root: tmp, dirs: ['g', 'g/ru'] });
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, [
    `current.html: current (checked at ${first})`,
    `ru/unstamped.html: no guide-sources / checked-at stamp`,
    `stale.html: STALE since ${first}`,
    '    src/a.txt | 1 +\n     1 file changed, 1 insertion(+)',
    '',
    '2 of 3 pages to review',
  ]);
});
