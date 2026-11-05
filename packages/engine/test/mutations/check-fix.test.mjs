// INFRA-26a CM-1..CM-12, CM-B1, CM-L1, CM-F1..CM-F10. Run by `pnpm test:tools`.
// Every case builds a throwaway git repo under os.tmpdir() and calls
// checkRegistry / fixRegistry with an explicit root and base, so nothing touches
// this repo and no stack is needed. Titles start with the contract id and a
// space (`--test-name-pattern='^CM-F1 '`). Expected values come from
// docs/tasks/contracts/INFRA-26a.md section 2.0, 2.1, 2.6 and section 0R.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { fixRegistry, ticketFromBranch } from '../../mutations/check.mjs';
import {
  R,
  area,
  patch,
  sqlEntry,
  TEST_A,
  git,
  put,
  readJson,
  mk,
  check,
  text,
  snapshot,
} from './__tests__/check-mutations.helpers.mjs';

// --- --fix ---------------------------------------------------------------

const GUARD = 'if (n === 0) throw forbidden;';
const guardSrc = (tag = 'a') =>
  `// ${tag}\nexport function ${tag}(n) {\n  ${GUARD}\n  return n;\n}\n// ${tag} tail\n`;
const fixed = (r) => r.fixed.map((f) => f.key).sort();
const fix = (dir, base, ticket = 'FU7') =>
  fixRegistry({ root: dir, base, ticket });
const mkdirp = (dir, rel) => mkdirSync(join(dir, rel), { recursive: true });

function movedGuard() {
  const r = mk({
    'src/a.ts': guardSrc('a'),
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M1': patch({ file: 'src/a.ts', find: GUARD }),
    }),
  });
  mkdirp(r.dir, 'lib');
  git(r.dir, 'mv', 'src/a.ts', 'lib/a.ts');
  return r;
}

test('CM-F1 a git mv of a guarded file: file rewritten, reaimed appended, area moved, exit 0', () => {
  const { dir, base } = movedGuard();
  const r = fix(dir, base);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(fixed(r), ['FU1/M1']);
  assert.equal(existsSync(join(dir, `${R}src.json`)), false, 'emptied area');
  const e = readJson(dir, `${R}lib.json`)['FU1/M1'];
  assert.equal(e.file, 'lib/a.ts');
  assert.equal(e.find, GUARD);
  assert.deepEqual(e.reaimed, [
    { by: 'FU7', why: 'moved: src/a.ts -> lib/a.ts' },
  ]);
  assert.match(text(r), /check:mutations --fix: 1 re-aimed, 0 left/);
  assert.equal(check(dir, base).code, 0);
});

test('CM-F2 a directory rename with 3 entries in 2 files repairs all of them in one run', () => {
  const { dir, base } = mk({
    'src/a.ts': guardSrc('a'),
    'src/b.ts': guardSrc('b'),
    'src/sub/c.ts': guardSrc('c'),
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M1': patch({ file: 'src/a.ts', find: GUARD }),
      'FU1/M2': patch({ file: 'src/b.ts', find: GUARD }),
    }),
    [`${R}src/sub.json`]: area({
      'FU2/M1': patch({ file: 'src/sub/c.ts', find: GUARD }),
    }),
  });
  git(dir, 'mv', 'src', 'lib');
  const r = fix(dir, base);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(fixed(r), ['FU1/M1', 'FU1/M2', 'FU2/M1']);
  const lib = readJson(dir, `${R}lib.json`);
  assert.deepEqual(Object.keys(lib), ['FU1/M1', 'FU1/M2']);
  assert.equal(lib['FU1/M1'].file, 'lib/a.ts');
  assert.equal(lib['FU1/M2'].file, 'lib/b.ts');
  assert.equal(
    readJson(dir, `${R}lib/sub.json`)['FU2/M1'].file,
    'lib/sub/c.ts',
  );
  assert.equal(existsSync(join(dir, `${R}src.json`)), false);
  assert.equal(existsSync(join(dir, `${R}src/sub.json`)), false);
});

test('CM-F3 a move across areas keeps the key and its sorted place in the target file', () => {
  const { dir, base } = mk({
    'src/a.ts': guardSrc('a'),
    'lib/x.ts': guardSrc('x'),
    'lib/y.ts': guardSrc('y'),
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M2': patch({ file: 'src/a.ts', find: GUARD }),
    }),
    [`${R}lib.json`]: area({
      'FU1/M1': patch({ file: 'lib/x.ts', find: GUARD }),
      'FU1/M10': patch({ file: 'lib/y.ts', find: GUARD }),
    }),
  });
  git(dir, 'mv', 'src/a.ts', 'lib/a.ts');
  const r = fix(dir, base);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(Object.keys(readJson(dir, `${R}lib.json`)), [
    'FU1/M1',
    'FU1/M2',
    'FU1/M10',
  ]);
});

test('CM-F4 a move after which find occurs twice is left unchanged and listed, exit 1', () => {
  const { dir, base } = movedGuard();
  put(dir, 'lib/a.ts', `${guardSrc('a')}${GUARD}\n`);
  const before = snapshot(dir);
  const r = fix(dir, base);
  assert.equal(r.code, 1, text(r));
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(
    r.left.map((l) => l.key),
    ['FU1/M1'],
  );
  assert.match(text(r), /left: FU1\/M1 /);
  assert.deepEqual(snapshot(dir), before);
});

test('CM-F5 a renamed testFile is rewritten and testName re-verified; a title missing at the new path is left', () => {
  const entry = {
    'FU1/M1': patch({
      file: 'src/a.ts',
      find: GUARD,
      test: 'pnpm exec vitest run -t "S1-2"',
      testName: 'S1-2',
    }),
  };
  const body = (title) =>
    `${Array.from({ length: 20 }, (_, i) => `// line ${i}`).join('\n')}\n${title}\n`;
  const files = {
    'src/a.ts': guardSrc('a'),
    'test/a.test.mjs': body("test('S1-2 guard', () => {});"),
    [`${R}src.json`]: area(entry),
  };
  const ok = mk(files);
  git(ok.dir, 'mv', 'test/a.test.mjs', 'test/b.test.mjs');
  const r = fix(ok.dir, ok.base);
  assert.equal(r.code, 0, text(r));
  const e = readJson(ok.dir, `${R}src.json`)['FU1/M1'];
  assert.equal(e.testFile, 'test/b.test.mjs');
  assert.deepEqual(e.reaimed, [
    { by: 'FU7', why: 'moved: test/a.test.mjs -> test/b.test.mjs' },
  ]);

  const miss = mk(files);
  git(miss.dir, 'mv', 'test/a.test.mjs', 'test/b.test.mjs');
  put(miss.dir, 'test/b.test.mjs', body("test('renamed title', () => {});"));
  const before = snapshot(miss.dir);
  const m = fix(miss.dir, miss.base);
  assert.equal(m.code, 1, text(m));
  assert.deepEqual(
    m.left.map((l) => l.key),
    ['FU1/M1'],
  );
  assert.deepEqual(snapshot(miss.dir), before);
});

test('CM-F6 a function snapshot renamed a.f -> b.g rewrites object, apply, restore and the area file', () => {
  const header = (n) =>
    `--\n-- Name: ${n}(uuid); Type: FUNCTION; Schema: x; Owner: postgres\n--\n\nCREATE FUNCTION x.${n}(uuid) RETURNS int\n    LANGUAGE sql\n    AS $$ select 1;\n${'-- pad\\n'.repeat(20)}$$;\n`;
  const { dir, base } = mk({
    'supabase/schema/functions/a.f.sql': header('f'),
    'test/a.test.mjs': TEST_A,
    [`${R}db/a.f.json`]: area({
      'FU1/M1': sqlEntry({
        object: 'function a.f(uuid)',
        find: 'select 1',
        replace: 'select 2',
        apply: 'grant execute on function a.f(uuid) to authenticated;',
        restore: 'revoke execute on function a.f(uuid) from authenticated;',
      }),
    }),
  });
  git(
    dir,
    'mv',
    'supabase/schema/functions/a.f.sql',
    'supabase/schema/functions/b.g.sql',
  );
  put(dir, 'supabase/schema/functions/b.g.sql', header('g'));
  const r = fix(dir, base);
  assert.equal(r.code, 0, text(r));
  assert.equal(existsSync(join(dir, `${R}db/a.f.json`)), false);
  const e = readJson(dir, `${R}db/b.g.json`)['FU1/M1'];
  assert.equal(e.object, 'function b.g(uuid)');
  assert.equal(
    e.apply,
    'grant execute on function b.g(uuid) to authenticated;',
  );
  assert.equal(
    e.restore,
    'revoke execute on function b.g(uuid) from authenticated;',
  );
  assert.equal(e.reaimed.length, 1);
});

test('CM-F7 a renamed table snapshot is left: the entry is unchanged and listed', () => {
  const { dir, base } = mk({
    'supabase/schema/tables/public.a.sql': 'create table public.a (id int);\n',
    'test/a.test.mjs': TEST_A,
    [`${R}db/public.a.json`]: area({
      'FU1/M1': sqlEntry({
        object: 'table public.a',
        apply: 'alter table public.a disable row level security;',
      }),
    }),
  });
  git(
    dir,
    'mv',
    'supabase/schema/tables/public.a.sql',
    'supabase/schema/tables/public.b.sql',
  );
  const before = snapshot(dir);
  const r = fix(dir, base);
  assert.equal(r.code, 1, text(r));
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(
    r.left.map((l) => l.key),
    ['FU1/M1'],
  );
  assert.deepEqual(snapshot(dir), before);
});

test('CM-F8 a guard copied to a new file while the old file stays: left with the added-file hint, entry unchanged', () => {
  const { dir, base } = mk({
    'src/a.ts': guardSrc('a'),
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M1': patch({ file: 'src/a.ts', find: GUARD }),
    }),
  });
  put(dir, 'src/a.ts', 'export function a() {}\n');
  put(dir, 'src/b.ts', guardSrc('b'));
  git(dir, 'add', 'src/b.ts');
  const before = snapshot(dir);
  const r = fix(dir, base);
  assert.equal(r.code, 1, text(r));
  assert.deepEqual(r.fixed, []);
  assert.equal(r.left.length, 1);
  assert.equal(r.left[0].key, 'FU1/M1');
  assert.match(String(r.left[0].hint), /find occurs once in added src\/b\.ts/);
  assert.deepEqual(snapshot(dir), before, 'the hint is never applied');
});

test('CM-F9 a second --fix run changes no byte and leaves reaimed at length 1', () => {
  const { dir, base } = movedGuard();
  assert.equal(fix(dir, base).code, 0);
  const after1 = snapshot(dir);
  const second = fix(dir, base);
  assert.equal(second.code, 0, text(second));
  assert.deepEqual(second.fixed, []);
  assert.deepEqual(snapshot(dir), after1);
  assert.equal(readJson(dir, `${R}lib.json`)['FU1/M1'].reaimed.length, 1);
});

test('CM-F10 a new key is never re-aimed; no --ticket on a non-ticket branch is exit 2', () => {
  const { dir, base } = mk({
    'src/a.ts': guardSrc('a'),
    'test/a.test.mjs': TEST_A,
  });
  mkdirp(dir, 'lib');
  git(dir, 'mv', 'src/a.ts', 'lib/a.ts');
  put(
    dir,
    `${R}src.json`,
    area({ 'FU1/M1': patch({ file: 'src/a.ts', find: GUARD }) }),
  );
  const before = snapshot(dir);
  const r = fix(dir, base);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(r.fixed, []);
  assert.deepEqual(snapshot(dir), before);

  const noTicket = fixRegistry({ root: dir, base });
  assert.equal(noTicket.code, 2, text(noTicket));
  assert.deepEqual(snapshot(dir), before);
});

test('CM-F10b ticketFromBranch reads the ticket id of a branch name', () => {
  assert.equal(
    ticketFromBranch('chore/INFRA-26-28-mutation-registry'),
    'INFRA-26',
  );
  assert.equal(ticketFromBranch('feat/INFRA-26a-x'), 'INFRA-26a');
  assert.equal(ticketFromBranch('feat/P3-02-foo'), 'P3-02');
  assert.equal(ticketFromBranch('fix/FU110'), 'FU110');
  assert.equal(ticketFromBranch('main'), null);
  assert.equal(ticketFromBranch('feat'), null);
});
