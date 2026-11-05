// Run by `pnpm test:tools`. Pure cases inject entries, hunks and files; MS-8
// builds a throwaway git repo under os.tmpdir() and passes its root, so nothing
// touches this repo.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  affected,
  parseHunks,
  parseNameStatus,
  selectChanged,
  selectEntries,
  splitServed,
  testBlocks,
} from '../../mutations/select.mjs';
import './__tests__/bind-consumer.mjs';

const SELECT = join(
  dirname(fileURLToPath(import.meta.url)),
  '__tests__/mutation-select.shim.mjs',
);
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// 12 lines; the guard `find` sits on line 6.
const GUARD_SRC = [
  'a',
  'b',
  'c',
  'd',
  'e',
  'if (n === 0) throw f;',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
].join('\n');
const patch = (over = {}) => ({
  kind: 'patch',
  protects: 'p',
  file: 'src/g.ts',
  find: 'if (n === 0) throw f;',
  replace: '',
  test: 'true',
  testFile: 'src/g.test.ts',
  ...over,
});
const rec = (entry, path = 'tools/mutation-registry/src.json') => ({
  path,
  line: 1,
  entry,
});
const reg = (o) =>
  new Map(Object.entries(o).map(([k, e]) => [k, e.entry ? e : rec(e)]));
const files = (o) => (p) => (p in o ? o[p] : null);
const run = (over) =>
  selectEntries({
    entries: new Map(),
    baseEntries: new Map(),
    hunks: new Map(),
    statuses: [],
    readFile: () => null,
    ...over,
  });
const keys = (sel) => sel.map((s) => s.key);

test('MS-1 a hunk within 3 lines of the find span selects the entry', () => {
  const entries = reg({ 'T/M1': patch() });
  const sel = (hunks) =>
    run({
      entries,
      baseEntries: entries,
      hunks,
      readFile: files({ 'src/g.ts': GUARD_SRC }),
    });
  // span is line 6: 3 lines above (hunk ends 3) selects, 4 (ends 2) does not
  assert.deepEqual(sel(new Map([['src/g.ts', [[1, 3]]]])), [
    { key: 'T/M1', rules: ['guard'] },
  ]);
  assert.deepEqual(sel(new Map([['src/g.ts', [[1, 2]]]])), []);
  assert.deepEqual(keys(sel(new Map([['src/g.ts', [[9, 9]]]]))), ['T/M1']);
  assert.deepEqual(sel(new Map([['src/g.ts', [[10, 12]]]])), []);
  // a pure deletion right above the guard is [c, c+1]
  const del = parseHunks('+++ b/src/g.ts\n@@ -5,2 +5,0 @@\n');
  assert.deepEqual(keys(sel(del)), ['T/M1']);
  assert.deepEqual(sel(new Map([['src/other.ts', [[6, 6]]]])), []);
  // zero or two matches: not this rule
  const dup = run({
    entries,
    baseEntries: entries,
    hunks: new Map([['src/g.ts', [[6, 6]]]]),
    readFile: files({ 'src/g.ts': `${GUARD_SRC}\n${GUARD_SRC}` }),
  });
  assert.deepEqual(dup, []);
});

const TEST_SRC = [
  "describe('outer', () => {",
  "  test('MS-A first', () => {",
  '    a();',
  '  });',
  '',
  "  test('MS-B second', () => {",
  '    b();',
  '  });',
  '});',
  "describe('MS-C group', () => {",
  "  it('child one', () => {});",
  "  it('child two', () => {});",
  '});',
].join('\n');

test('MS-2 a hunk in the testName block selects; one in the next sibling test does not', () => {
  assert.deepEqual(testBlocks(TEST_SRC, 'MS-A '), [[2, 5]]);
  assert.deepEqual(testBlocks(TEST_SRC, 'MS-B '), [[6, 9]]);
  assert.deepEqual(testBlocks(TEST_SRC, 'nope'), []);
  const mk = (testName, hunk) => {
    const entries = reg({ 'T/M1': patch({ file: 'src/other.ts', testName }) });
    return run({
      entries,
      baseEntries: entries,
      hunks: new Map([['src/g.test.ts', [hunk]]]),
      readFile: files({ 'src/g.test.ts': TEST_SRC, 'src/other.ts': 'x' }),
    });
  };
  assert.deepEqual(mk('MS-A ', [3, 3]), [{ key: 'T/M1', rules: ['test'] }]);
  assert.deepEqual(mk('MS-A ', [6, 7]), []);
  assert.deepEqual(mk('MS-B ', [7, 7]).length, 1);
  // a describe title spans its children
  assert.equal(mk('MS-C group', [12, 12]).length, 1);
  assert.equal(mk('MS-C group', [3, 3]).length, 0);
  // no testName: any hunk in testFile selects
  const entries = reg({ 'T/M1': patch({ file: 'src/other.ts' }) });
  const any = run({
    entries,
    baseEntries: entries,
    hunks: new Map([['src/g.test.ts', [[1, 1]]]]),
    readFile: files({ 'src/other.ts': 'x' }),
  });
  assert.equal(any.length, 1);
});

test('MS-3 a changed entry is selected, a retired one is not', () => {
  const base = reg({
    'T/M1': patch(),
    'T/M2': patch(),
    'T/M3': patch(),
    'T/M4': patch(),
    'T/M5': patch(),
  });
  const tree = reg({
    // in-place re-aim
    'T/M1': patch({ find: 'if (n === 1) throw f;' }),
    // test command changed
    'T/M2': patch({ test: 'node --test other.test.mjs' }),
    // gained retired, and its find changed: only the retired skip keeps it out
    'T/M3': patch({
      find: 'if (n === 3) throw f;',
      retired: { by: 'X', why: 'obsolete' },
    }),
    // unchanged
    'T/M4': patch(),
    // moved to another area file with only bookkeeping changed: same run
    'T/M5': rec(
      patch({ protects: 'reworded', reaimed: [{ by: 'X', why: 'moved' }] }),
      'tools/mutation-registry/lib.json',
    ),
  });
  const sel = run({ entries: tree, baseEntries: base });
  assert.deepEqual(sel, [
    { key: 'T/M1', rules: ['entry'] },
    { key: 'T/M2', rules: ['entry'] },
  ]);
});

test('MS-4 a changed supabase/schema object selects its sql entries', () => {
  const sqlEntry = (object, over = {}) => ({
    kind: 'sql',
    protects: 'p',
    object,
    find: 'x',
    replace: 'y',
    test: 'true',
    testFile: 't.ts',
    ...over,
  });
  const entries = reg({
    'T/M1': rec(
      sqlEntry('function private.block_plan_error(uuid)'),
      'tools/mutation-registry/db/private.block_plan_error.json',
    ),
    'T/M2': rec(
      sqlEntry('function private.other(uuid)'),
      'tools/mutation-registry/db/private.other.json',
    ),
    'T/M3': rec(
      sqlEntry('function private.third(uuid)', {
        also: [
          {
            object: 'function private.block_plan_error(uuid)',
            find: 'a',
            replace: 'b',
          },
        ],
      }),
      'tools/mutation-registry/db/private.third.json',
    ),
  });
  const sel = run({
    entries,
    baseEntries: entries,
    hunks: new Map([
      ['supabase/schema/functions/private.block_plan_error.sql', [[3, 4]]],
    ]),
  });
  assert.deepEqual(sel, [
    { key: 'T/M1', rules: ['schema'] },
    { key: 'T/M3', rules: ['schema'] },
  ]);
  assert.deepEqual(
    run({
      entries,
      baseEntries: entries,
      hunks: new Map([['supabase/schema/functions/private.zzz.sql', [[1, 1]]]]),
    }),
    [],
  );
});

test('MS-5 a renamed, added or deleted file or testFile selects the entry', () => {
  const entries = reg({
    'T/M1': patch({ file: 'src/new.ts' }),
    'T/M2': patch({ file: 'src/a.ts', testFile: 'src/new.test.ts' }),
    'T/M3': patch({ file: 'src/c.ts' }),
  });
  const added = run({
    entries,
    baseEntries: entries,
    statuses: [
      { status: 'A', path: 'src/new.ts' },
      { status: 'R', path: 'src/new.test.ts', from: 'src/old.test.ts' },
    ],
  });
  assert.deepEqual(keys(added), ['T/M1', 'T/M2']);
  const base = reg({
    'T/M1': patch({ file: 'src/gone.ts' }),
    'T/M2': patch({ file: 'src/b.ts', testFile: 'src/was.test.ts' }),
    'T/M3': patch({ file: 'src/c.ts' }),
  });
  const tree = reg({
    'T/M1': patch({ file: 'src/gone.ts' }),
    'T/M2': patch({ file: 'src/b.ts', testFile: 'src/was.test.ts' }),
    'T/M3': patch({ file: 'src/c.ts' }),
  });
  const gone = run({
    entries: tree,
    baseEntries: base,
    statuses: [
      { status: 'D', path: 'src/gone.ts' },
      { status: 'R', path: 'src/now.test.ts', from: 'src/was.test.ts' },
      { status: 'M', path: 'src/c.ts' },
    ],
  });
  assert.deepEqual(keys(gone), ['T/M1', 'T/M2']);
  assert.deepEqual(
    parseNameStatus('A\tx.ts\nM\ty.ts\nD\tz.ts\nR100\told.ts\tnew.ts\n'),
    [
      { status: 'A', path: 'x.ts' },
      { status: 'M', path: 'y.ts' },
      { status: 'D', path: 'z.ts' },
      { status: 'R', path: 'new.ts', from: 'old.ts' },
    ],
  );
});

test('MS-6 a key absent at base is never selected', () => {
  const entries = reg({ 'T/M1': patch(), 'T/M2': patch() });
  const baseEntries = reg({ 'T/M1': patch() });
  const sel = run({
    entries,
    baseEntries,
    hunks: new Map([['src/g.ts', [[6, 6]]]]),
    readFile: files({ 'src/g.ts': GUARD_SRC }),
  });
  assert.deepEqual(keys(sel), ['T/M1']);
});

test('MS-7 mutations:affected lists live entries by file, testFile and directory', () => {
  const entries = reg({
    'T/M1': patch({ file: 'tools/a.mjs', testFile: 'tools/a.test.mjs' }),
    'T/M2': patch({
      file: 'tools/a.mjs',
      retired: { by: 'X', why: 'obsolete' },
    }),
    'T/M3': patch({ file: 'src/b.ts', testFile: 'src/b.test.ts' }),
    'T/M4': rec(
      {
        kind: 'sql',
        protects: 's',
        object: 'function private.f(uuid)',
        find: 'x',
        replace: 'y',
        test: 't',
        testFile: 'supabase/tests/f.test.ts',
      },
      'tools/mutation-registry/db/private.f.json',
    ),
  });
  assert.deepEqual(keys(affected(['tools/a.mjs'], entries)), ['T/M1']);
  assert.deepEqual(keys(affected(['tools/a.test.mjs'], entries)), ['T/M1']);
  assert.deepEqual(keys(affected(['tools/'], entries)), ['T/M1']);
  assert.deepEqual(keys(affected(['src/b'], entries)), []);
  assert.deepEqual(keys(affected(['src/'], entries)), ['T/M3']);
  assert.deepEqual(
    keys(affected(['supabase/schema/functions/private.f.sql'], entries)),
    ['T/M4'],
  );
  assert.deepEqual(affected(['src/b.ts'], entries)[0], {
    key: 'T/M3',
    path: 'src/b.ts',
    protects: 'p',
  });
  const noPaths = spawnSync('node', [SELECT, '--affected'], {
    encoding: 'utf8',
  });
  assert.equal(noPaths.status, 2);
  assert.match(noPaths.stderr, /--paths=/);
});

test('MS-8 selectChanged reads the working tree: an uncommitted hunk and an untracked test file both select', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-select-'));
  dirs.push(dir);
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  const put = (rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  git('init', '-q', '-b', 'main');
  put('src/g.ts', GUARD_SRC);
  put('src/h.ts', 'keep\nreturn 5;\n');
  const area = (o) => `${JSON.stringify(o, null, 2)}\n`;
  put(
    'tools/mutation-registry/src.json',
    area({
      'T/M1': patch(),
      'T/M2': patch({
        file: 'src/h.ts',
        find: 'return 5;',
        testFile: 'src/h.test.ts',
        test: 'true',
      }),
      'T/M3': patch({
        file: 'src/h.ts',
        find: 'keep',
        testFile: 'src/untracked.test.ts',
      }),
    }),
  );
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  // uncommitted, unstaged edit next to M1's guard; M3's test file is untracked and new
  put('src/g.ts', GUARD_SRC.replace('\ng\n', '\nG\n'));
  put('src/untracked.test.ts', "test('x', () => {});\n");
  const sel = selectChanged({ base, root: dir });
  assert.deepEqual(sel, [
    { key: 'T/M1', rules: ['guard'] },
    { key: 'T/M3', rules: ['test', 'moved'] },
  ]);
  // nothing changed in the tree: nothing selected
  git('stash', '-u', '-q');
  assert.deepEqual(selectChanged({ base, root: dir }), []);
});

test('MS-9 splitServed leaves Playwright-backed entries to the nightly and keeps the rest, in order', () => {
  const entries = new Map([
    ['A/M1', rec(patch({ test: 'pnpm -F @demo/core test x' }))],
    [
      'A/M2',
      rec(patch({ test: 'pnpm -F web exec playwright test e2e/x.spec.ts' })),
    ],
    ['A/M3', rec(patch({ test: 'node --test tools/x.test.mjs' }))],
    ['A/M4', rec(patch({ test: 'pnpm --filter web exec playwright test' }))],
  ]);
  const sel = ['A/M1', 'A/M2', 'A/M3', 'A/M4', 'GONE/M1'].map((key) => ({
    key,
    rules: ['guard'],
  }));
  const { run, deferred } = splitServed(sel, entries);
  assert.deepEqual(
    run.map((s) => s.key),
    ['A/M1', 'A/M3', 'GONE/M1'],
  );
  assert.deepEqual(
    deferred.map((s) => s.key),
    ['A/M2', 'A/M4'],
  );
  assert.deepEqual(splitServed([], entries), { run: [], deferred: [] });
});
