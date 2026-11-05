import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { checkRegistry } from '../../../mutations/check.mjs';

import { bindConsumer } from './consumer.fixture.mjs';

bindConsumer();

export const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

export const R = 'tools/mutation-registry/';
// Contract s2.0 ENTRY_FIELDS, so fixtures are written in the on-disk order.
export const FIELDS = [
  'kind',
  'protects',
  'object',
  'file',
  'within',
  'find',
  'replace',
  'apply',
  'restore',
  'test',
  'testFile',
  'testName',
  'from',
  'title',
  'why',
  'retired',
  'reaimed',
];
export const ord = (e) =>
  Object.fromEntries(FIELDS.filter((k) => k in e).map((k) => [k, e[k]]));
export const area = (obj) =>
  `${JSON.stringify(
    Object.fromEntries(Object.entries(obj).map(([k, e]) => [k, ord(e)])),
    null,
    2,
  )}\n`;

export const patch = (over = {}) => ({
  kind: 'patch',
  protects: '3 guard holds for row 1',
  file: 'src/a.ts',
  find: 'return 1;',
  replace: 'return 2;',
  test: 'node --test test/a.test.mjs',
  testFile: 'test/a.test.mjs',
  ...over,
});
export const sqlEntry = (over = {}) => ({
  kind: 'sql',
  protects: '3 sql guard holds for row 1',
  object: 'function public.f(uuid)',
  apply: 'grant execute on function public.f(uuid) to authenticated;',
  test: 'node --test test/a.test.mjs',
  testFile: 'test/a.test.mjs',
  ...over,
});
export const unguarded = (over = {}) => ({
  kind: 'unguarded',
  from: 'e2e/a.spec.ts',
  title: 'a spec',
  why: 'cannot fail in isolation',
  ...over,
});

export const SRC_A = 'export function a() {\n  return 1;\n}\n';
export const TEST_A = "test('S1-2 guard', () => {});\n";

export const git = (dir, ...a) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
    cwd: dir,
    stdio: 'pipe',
  })
    .toString()
    .trim();
export const put = (dir, rel, body) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
export const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
export const readJson = (dir, rel) => JSON.parse(read(dir, rel));

/** A repo whose base commit holds `files`; the working tree starts equal to it. */
export function mk(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-mutations-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  put(dir, 'README.md', 'x\n');
  for (const [rel, body] of Object.entries(files)) put(dir, rel, body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'feat');
  return { dir, base };
}

export const check = (dir, base) => checkRegistry({ root: dir, base });
export const text = (r) => r.lines.join('\n');
export const has = (r, kind, key) =>
  r.problems.some((p) => p.kind === kind && p.key === key);
export const lineFor = (r, prefix) => r.lines.find((l) => l.startsWith(prefix));
export const base7 = (sha) => sha.slice(0, 7);
export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Registry bytes of every file under the folder, for no-change assertions.
export function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const n of readdirSync(abs)) {
      const r = `${rel}/${n}`;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else out[r] = read(dir, r);
    }
  };
  walk(R.slice(0, -1));
  return out;
}
