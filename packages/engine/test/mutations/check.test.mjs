// INFRA-26a CM-1..CM-12, CM-B1, CM-L1, CM-F1..CM-F10. Run by `pnpm test:tools`.
// Every case builds a throwaway git repo under os.tmpdir() and calls
// checkRegistry / fixRegistry with an explicit root and base, so nothing touches
// this repo and no stack is needed. Titles start with the contract id and a
// space (`--test-name-pattern='^CM-F1 '`). Expected values come from
// docs/tasks/contracts/INFRA-26a.md section 2.0, 2.1, 2.6 and section 0R.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  R,
  area,
  patch,
  sqlEntry,
  unguarded,
  SRC_A,
  TEST_A,
  put,
  mk,
  check,
  text,
  has,
  lineFor,
  base7,
  esc,
  snapshot,
} from './__tests__/check-mutations.helpers.mjs';

test('CM-1 a base live find that occurs 0 or 2 times is stale; once is clean', () => {
  const { dir, base } = mk({
    'src/once.ts': 'return 1;\n',
    'src/zero.ts': 'nothing here\n',
    'src/twice.ts': 'return 1;\nreturn 1;\n',
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M1': patch({ file: 'src/once.ts' }),
      'FU1/M2': patch({ file: 'src/zero.ts' }),
      'FU1/M3': patch({ file: 'src/twice.ts' }),
    }),
  });
  const r = check(dir, base);
  assert.equal(r.code, 1);
  assert.deepEqual(
    r.problems.map((p) => `${p.kind}:${p.key}`),
    ['stale:FU1/M2', 'stale:FU1/M3'],
  );
  assert.match(
    lineFor(r, 'stale: FU1/M2'),
    /^stale: FU1\/M2 find occurs 0 times in src\/zero\.ts/,
  );
  assert.match(
    lineFor(r, 'stale: FU1/M3'),
    /^stale: FU1\/M3 find occurs 2 times in src\/twice\.ts/,
  );

  const ok = mk({
    'src/once.ts': 'return 1;\n',
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({ 'FU1/M1': patch({ file: 'src/once.ts' }) }),
  });
  const clean = check(ok.dir, ok.base);
  assert.equal(clean.code, 0, text(clean));
  assert.deepEqual(clean.problems, []);
  assert.match(
    clean.lines.at(-1),
    /^check:mutations: 1 entries \(1 live, 0 retired\) in 1 files, 0 problem\(s\)$/,
  );
});

test('CM-2 a find that matches once only after whitespace runs collapse is clean', () => {
  const { dir, base } = mk({
    'src/ws.ts': 'if (n   ===\n    0)   throw forbidden;\n',
    'src/ws2.ts': 'const a =\n\n   1;\n',
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M1': patch({
        file: 'src/ws.ts',
        find: 'if (n === 0) throw forbidden;',
      }),
      'FU1/M2': patch({ file: 'src/ws2.ts', find: 'const a = 1;' }),
    }),
  });
  const r = check(dir, base);
  assert.equal(r.code, 0, text(r));
  assert.deepEqual(r.problems, []);
});

test('CM-3 find is counted inside the within block; an absent or repeated anchor is stale', () => {
  const { dir, base } = mk({
    'src/w.ts':
      'function f() {\n  return 1;\n}\nfunction g() {\n  return 1;\n}\n',
    'src/h.ts': 'function h() {\n  return 1;\n  return 1;\n}\n',
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M1': patch({ file: 'src/w.ts', within: 'function g() {' }),
      'FU1/M2': patch({ file: 'src/w.ts', within: 'function f() {' }),
      'FU1/M3': patch({ file: 'src/w.ts', within: 'function nope() {' }),
      'FU1/M4': patch({ file: 'src/h.ts', within: 'function h() {' }),
      'FU1/M5': patch({ file: 'src/w.ts', within: 'return 1;' }),
    }),
  });
  const r = check(dir, base);
  assert.equal(has(r, 'stale', 'FU1/M1'), false, text(r));
  assert.equal(has(r, 'stale', 'FU1/M2'), false, text(r));
  assert.equal(has(r, 'stale', 'FU1/M3'), true, 'anchor absent');
  assert.equal(has(r, 'stale', 'FU1/M4'), true, 'find twice inside the block');
  assert.equal(has(r, 'stale', 'FU1/M5'), true, 'anchor occurs twice');
  assert.equal(r.code, 1);
});

test('CM-4 a missing file is stale', () => {
  const { dir, base } = mk({
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({ 'FU1/M1': patch({ file: 'src/gone.ts' }) }),
  });
  const r = check(dir, base);
  assert.equal(r.code, 1);
  assert.equal(has(r, 'stale', 'FU1/M1'), true, text(r));
  assert.match(lineFor(r, 'stale: FU1/M1'), /src\/gone\.ts/);
});

test('CM-5 a missing testFile path is stale; an absent testFile field is a shape problem', () => {
  const noField = patch();
  delete noField.testFile;
  const { dir, base } = mk({
    'src/a.ts': SRC_A,
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M1': patch({ testFile: 'test/missing.test.mjs' }),
      'FU1/M2': noField,
    }),
  });
  const r = check(dir, base);
  assert.equal(has(r, 'stale', 'FU1/M1'), true, text(r));
  assert.match(lineFor(r, 'stale: FU1/M1'), /test\/missing\.test\.mjs/);
  assert.equal(has(r, 'shape', 'FU1/M2'), true, text(r));
  assert.equal(has(r, 'stale', 'FU1/M2'), false);
  assert.equal(has(r, 'shape', 'FU1/M1'), false);
});

test('CM-6 a filtering test needs testName, and testName must occur in testFile', () => {
  const filtered = (over = {}) =>
    patch({
      test: 'pnpm exec vitest run test/a.test.mjs -t "S1-2"',
      ...over,
    });
  const noName = filtered();
  const { dir, base } = mk({
    'src/a.ts': SRC_A,
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M1': filtered({ testName: 'S1-9' }),
      'FU1/M2': noName,
      'FU1/M3': filtered({ testName: 'S1-2' }),
    }),
  });
  const r = check(dir, base);
  assert.equal(has(r, 'stale', 'FU1/M1'), true, text(r));
  assert.match(lineFor(r, 'stale: FU1/M1'), /S1-9/);
  assert.equal(has(r, 'shape', 'FU1/M2'), true, text(r));
  assert.equal(has(r, 'stale', 'FU1/M3'), false, text(r));
  assert.equal(has(r, 'shape', 'FU1/M3'), false, text(r));
});

test('CM-7 an entry in the wrong area file is misfiled with its target; the right file is clean', () => {
  const entries = {
    patchSrc: ['src.json', 'FU1/M1', patch({ file: 'src/a.ts' })],
    patchTool: ['tools/x.json', 'FU1/M2', patch({ file: 'tools/x.mjs' })],
    patchRoot: ['_root.json', 'FU1/M3', patch({ file: 'package.json' })],
    sql: [
      'db/public.f.json',
      'FU1/M4',
      sqlEntry({ object: 'function public.f(uuid)' }),
    ],
    unguarded: [
      'apps/web/e2e.json',
      'FU1/M5',
      unguarded({ from: 'e2e/a.spec.ts' }),
    ],
  };
  const wrong = {
    patchSrc: 'other.json',
    patchTool: 'tools.json',
    patchRoot: 'src.json',
    sql: 'db/public.g.json',
    unguarded: '_root.json',
  };
  const bad = mk({});
  for (const [name, [, key, entry]] of Object.entries(entries))
    put(bad.dir, `${R}${wrong[name]}`, area({ [key]: entry }));
  const r = check(bad.dir, bad.base);
  assert.equal(r.code, 1);
  for (const [name, [target, key]] of Object.entries(entries)) {
    const want = new RegExp(
      `^misfiled: ${esc(key)} in ${esc(`${R}${wrong[name]}`)} - move to ${esc(`${R}${target}`)}$`,
    );
    assert.match(lineFor(r, `misfiled: ${key} `) ?? '', want, name);
  }

  const good = mk({});
  for (const [, [target, key, entry]] of Object.entries(entries))
    put(good.dir, `${R}${target}`, area({ [key]: entry }));
  const clean = check(good.dir, good.base);
  assert.equal(clean.code, 0, text(clean));
  assert.deepEqual(clean.problems, []);
});

test('CM-8 keys out of order in an area file are unsorted; numeric runs sort numerically', () => {
  const bad = mk({});
  put(bad.dir, `${R}src.json`, area({ 'FU1/M10': patch(), 'FU1/M2': patch() }));
  const r = check(bad.dir, bad.base);
  assert.equal(r.code, 1);
  const p = r.problems.find((x) => x.kind === 'unsorted');
  assert.ok(p, text(r));
  assert.equal(p.path, `${R}src.json`);
  assert.match(
    lineFor(r, 'unsorted: ') ?? '',
    /^unsorted: tools\/mutation-registry\/src\.json - first out of order: FU1\/M(2|10)$/,
  );

  const good = mk({});
  put(
    good.dir,
    `${R}src.json`,
    area({ 'FU1/M2': patch(), 'FU1/M10': patch(), 'FU2/M1': patch() }),
  );
  const ok = check(good.dir, good.base);
  assert.equal(
    ok.problems.some((x) => x.kind === 'unsorted'),
    false,
    text(ok),
  );
});

test('CM-9 a base key deleted from the folder is vanished; the same key retired is clean', () => {
  const files = {
    'src/a.ts': SRC_A,
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({
      'FU1/M1': patch(),
      'FU1/M2': patch(),
    }),
  };
  const gone = mk(files);
  put(gone.dir, `${R}src.json`, area({ 'FU1/M1': patch() }));
  const r = check(gone.dir, gone.base);
  assert.equal(r.code, 1);
  assert.equal(has(r, 'vanished', 'FU1/M2'), true, text(r));
  assert.equal(has(r, 'vanished', 'FU1/M1'), false);
  assert.match(
    lineFor(r, 'vanished: FU1/M2'),
    new RegExp(
      `^vanished: FU1/M2 was in ${esc(`${R}src.json`)} at ${base7(gone.base)} - restore it and retire it with a citation`,
    ),
  );

  const kept = mk(files);
  put(
    kept.dir,
    `${R}src.json`,
    area({
      'FU1/M1': patch(),
      // a retired entry gets the shape check only: its find is nowhere
      'FU1/M2': patch({
        find: 'removed',
        retired: { by: 'FU1', why: 'obsolete per specs/x.md section 2' },
      }),
    }),
  );
  const ok = check(kept.dir, kept.base);
  assert.equal(has(ok, 'vanished', 'FU1/M2'), false, text(ok));
  assert.equal(has(ok, 'stale', 'FU1/M2'), false, text(ok));
  assert.equal(has(ok, 'retired', 'FU1/M2'), false, text(ok));
});

test('CM-10 a new key gets the shape check only: a missing file is clean, a missing testFile is shape', () => {
  const noTestFile = patch({ file: 'src/new.ts' });
  delete noTestFile.testFile;
  const { dir, base } = mk({
    'src/a.ts': SRC_A,
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({ 'FU1/M1': patch() }),
  });
  put(
    dir,
    `${R}src.json`,
    area({
      'FU1/M1': patch(),
      'FU2/M1': patch({ file: 'src/new-missing.ts', find: 'never there' }),
      'FU2/M2': noTestFile,
    }),
  );
  const r = check(dir, base);
  assert.equal(has(r, 'stale', 'FU2/M1'), false, text(r));
  assert.equal(has(r, 'shape', 'FU2/M1'), false, text(r));
  assert.equal(has(r, 'shape', 'FU2/M2'), true, text(r));
  assert.equal(r.code, 1);
});

test('CM-11 a retirement without by and why is retired; an unknown supersededBy is shape', () => {
  const { dir, base } = mk({});
  put(
    dir,
    `${R}src.json`,
    area({
      'FU1/M1': patch({ retired: { by: 'FU1' } }),
      'FU1/M2': patch({ retired: { by: 'FU1', why: '' } }),
      'FU1/M3': patch({
        retired: { by: 'FU1', why: 'moved', supersededBy: 'FU9/M9' },
      }),
      'FU1/M4': patch({
        retired: { by: 'FU1', why: 'moved', supersededBy: 'FU1/M5' },
      }),
      'FU1/M5': patch(),
    }),
  );
  const r = check(dir, base);
  assert.equal(has(r, 'retired', 'FU1/M1'), true, text(r));
  assert.equal(has(r, 'retired', 'FU1/M2'), true, text(r));
  assert.match(
    lineFor(r, 'retired: FU1/M1'),
    /^retired: FU1\/M1 needs retired\.by and retired\.why/,
  );
  assert.equal(has(r, 'shape', 'FU1/M3'), true, text(r));
  assert.equal(
    r.problems.filter((p) => ['FU1/M4', 'FU1/M5'].includes(p.key)).length,
    0,
    text(r),
  );
});

test('CM-12 the same key in two area files is duplicate', () => {
  const { dir, base } = mk({});
  put(dir, `${R}src.json`, area({ 'FU1/M1': patch() }));
  put(dir, `${R}lib.json`, area({ 'FU1/M1': patch({ file: 'lib/x.ts' }) }));
  const r = check(dir, base);
  assert.equal(r.code, 1);
  assert.equal(has(r, 'duplicate', 'FU1/M1'), true, text(r));
  assert.match(
    lineFor(r, 'duplicate: FU1/M1'),
    /^duplicate: FU1\/M1 in \S+\.json and \S+\.json$/,
  );
});

const legacy = (ticket, mutations) =>
  `${JSON.stringify({ ticket, mutations }, null, 2)}\n`;
const old = (id, over = {}) => ({
  id,
  protects: `3 ${id} guard holds for row 1`,
  kind: 'patch',
  file: 'src/a.ts',
  find: 'return 1;',
  replace: 'return 2;',
  test: 'node --test test/a.test.mjs',
  ...over,
});

test('CM-B1 a base without the folder reads its legacy contracts file: a missing key is vanished, a stale find is stale', () => {
  const { dir, base } = mk({
    'src/a.ts': SRC_A,
    'test/a.test.mjs': TEST_A,
    'docs/tasks/contracts/FU9.mutations.json': legacy('FU9', [
      old('M1'),
      old('M2'),
    ]),
  });
  rmSync(join(dir, 'docs/tasks/contracts/FU9.mutations.json'));
  put(
    dir,
    `${R}src.json`,
    area({ 'FU9/M1': patch({ find: 'no such text anywhere' }) }),
  );
  const r = check(dir, base);
  assert.equal(r.code, 1);
  assert.equal(has(r, 'vanished', 'FU9/M2'), true, text(r));
  assert.match(
    lineFor(r, 'vanished: FU9/M2'),
    new RegExp(
      `was in docs/tasks/contracts/FU9\\.mutations\\.json at ${base7(base)}`,
    ),
  );
  assert.equal(has(r, 'stale', 'FU9/M1'), true, text(r));
});

test('CM-L1 a non-.old. contracts mutations file in the tree is legacy; an .old. file is ignored', () => {
  const { dir, base } = mk({});
  put(dir, 'docs/tasks/contracts/X.mutations.json', legacy('X', [old('M1')]));
  put(
    dir,
    'docs/tasks/contracts/Y.old.mutations.json',
    legacy('Y', [old('M1')]),
  );
  put(dir, 'docs/tasks/contracts/Y.old-receipt.json', '{}\n');
  const r = check(dir, base);
  assert.equal(r.code, 1);
  const legacies = r.problems.filter((p) => p.kind === 'legacy');
  assert.equal(legacies.length, 1, text(r));
  assert.equal(legacies[0].path, 'docs/tasks/contracts/X.mutations.json');
  assert.match(
    lineFor(r, 'legacy: '),
    /^legacy: docs\/tasks\/contracts\/X\.mutations\.json - move its entries into tools\/mutation-registry\/ \(README\)$/,
  );
  assert.equal(text(r).includes('Y.old'), false, text(r));
});

// INFRA-26b CM-13..CM-18: the sql `object` form against the schema snapshot
// (contracts/INFRA-26b.md sections 2 and 5).
const fnSnap = (name, args, body) =>
  `--\n-- Name: ${name}(${args}); Type: FUNCTION; Schema: public; Owner: postgres\n--\n\nCREATE FUNCTION public.${name}(p uuid) RETURNS int\n    LANGUAGE sql\n    AS $$${body}$$;\n`;
const tblSnap =
  'CREATE TABLE public.tbl (\n    id uuid,\n    avatar_url text,\n    CONSTRAINT tbl_avatar_url_check CHECK ((avatar_url IS NULL))\n);\n\n--\n-- Name: tbl tbl_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres\n--\n\nALTER TABLE ONLY public.tbl\n    ADD CONSTRAINT tbl_pkey PRIMARY KEY (id);\n\n--\n-- Name: tbl tbl_guard; Type: TRIGGER; Schema: public; Owner: postgres\n--\n\n--\n-- Name: tbl tbl_read; Type: POLICY; Schema: public; Owner: postgres\n--\n';
const fnEdit = (over = {}) =>
  sqlEntry({
    find: 'select 1',
    replace: 'select 2',
    apply: undefined,
    ...over,
  });

/** One live sql entry (at the base) over `files`; the check's lines. */
function sqlRun(entry, files = {}, stem = 'public.f') {
  const { dir, base } = mk({
    'test/a.test.mjs': TEST_A,
    ...files,
    [`${R}db/${stem}.json`]: area({ 'FU1/M1': entry }),
  });
  return check(dir, base);
}
const FN_F = {
  'supabase/schema/functions/public.f.sql': fnSnap(
    'f',
    'uuid',
    ' select 1 from t',
  ),
};

test('CM-13 sql find not exactly once in the snapshot body is stale', () => {
  const once = sqlRun(fnEdit(), FN_F);
  assert.equal(once.code, 0, text(once));
  const zero = sqlRun(fnEdit({ find: 'select 9' }), FN_F);
  assert.ok(has(zero, 'stale', 'FU1/M1'), text(zero));
  assert.match(
    text(zero),
    /find occurs 0 times in the body of function public\.f\(uuid\)/,
  );
  const twice = sqlRun(fnEdit(), {
    'supabase/schema/functions/public.f.sql': fnSnap(
      'f',
      'uuid',
      ' select 1 from t; select 1 from u',
    ),
  });
  assert.match(text(twice), /find occurs 2 times in the body of/);
  // A find that only the header (or the signature line) holds is 0 in the body.
  const header = sqlRun(fnEdit({ find: 'RETURNS int' }), FN_F);
  assert.match(text(header), /find occurs 0 times in the body of/);
  // Whitespace runs match across lines.
  const ws = sqlRun(fnEdit({ find: 'select\n   1  from' }), FN_F);
  assert.equal(ws.code, 0, text(ws));
});

test('CM-14 unknown object: missing snapshot file, wrong args, unknown table-level name', () => {
  const noFile = sqlRun(fnEdit(), {});
  assert.match(
    text(noFile),
    /unknown object function public\.f\(uuid\): supabase\/schema\/functions\/public\.f\.sql does not exist/,
  );
  const args = sqlRun(
    fnEdit({ object: 'function public.f(uuid, text)' }),
    FN_F,
  );
  assert.match(
    text(args),
    /unknown object function public\.f\(uuid, text\): no "-- Name: f\(uuid, text\); Type: FUNCTION;"/,
  );
  const TBL = { 'supabase/schema/tables/public.tbl.sql': tblSnap };
  const tl = (object, apply) =>
    sqlRun(sqlEntry({ object, apply }), TBL, 'public.tbl');
  for (const [object, apply] of [
    [
      'trigger tbl_guard on public.tbl',
      'drop trigger tbl_guard on public.tbl;',
    ],
    ['policy tbl_read on public.tbl', 'drop policy tbl_read on public.tbl;'],
    [
      'constraint tbl_pkey on public.tbl',
      'alter table public.tbl drop constraint tbl_pkey;',
    ],
    [
      'constraint tbl_avatar_url_check on public.tbl',
      'alter table public.tbl drop constraint tbl_avatar_url_check;',
    ],
  ]) {
    const ok = tl(object, apply);
    assert.equal(ok.code, 0, `${object}: ${text(ok)}`);
  }
  for (const [object, apply] of [
    ['trigger nope on public.tbl', 'drop trigger nope on public.tbl;'],
    ['policy nope on public.tbl', 'drop policy nope on public.tbl;'],
    [
      'constraint nope on public.tbl',
      'alter table public.tbl drop constraint nope;',
    ],
    // the right name under the wrong kind
    ['policy tbl_guard on public.tbl', 'drop policy tbl_guard on public.tbl;'],
  ]) {
    const bad = tl(object, apply);
    assert.match(
      text(bad),
      new RegExp(
        `unknown object ${esc(object)} in supabase/schema/tables/public\\.tbl\\.sql`,
      ),
      object,
    );
    assert.ok(has(bad, 'stale', 'FU1/M1'));
  }
});

test('CM-15 apply limits: whole-body, pg_get_functiondef, object-less DDL rejected; grants and cron pass', () => {
  const shape = (over, files = FN_F, stem = 'public.f') =>
    sqlRun(sqlEntry(over), files, stem);
  for (const apply of [
    'create or replace function public.f(uuid) returns int language sql as $$ select 1 $$;',
    "do $m$ begin execute 'create or replace function public.f() returns int language sql as $x$ select 1 $x$'; end $m$;",
    "do $m$ declare d text; begin d := pg_get_functiondef('public.f(uuid)'::regprocedure); execute d; end $m$;",
  ]) {
    const r = shape({ apply });
    assert.match(text(r), /shape: FU1\/M1 whole-body apply/, apply);
  }
  const bare = sqlEntry({ apply: 'drop trigger t on public.tbl;' });
  delete bare.object;
  const nameless = sqlRun(bare, {}, 'public.tbl');
  assert.match(
    text(nameless),
    /apply without object: only grants, revokes and cron are object-less/,
  );
  const grant = shape({
    apply: 'grant execute on function public.f(uuid) to authenticated;',
  });
  assert.equal(grant.code, 0, text(grant));
  const cron = sqlRun(
    sqlEntry({
      object: 'cron notify-x',
      apply: "select cron.schedule('notify-x', '* * * * *', $$select 1$$);",
    }),
    { 'supabase/schema/cron/jobs.sql': "select cron.schedule('notify-x');\n" },
    'cron.notify-x',
  );
  assert.equal(cron.code, 0, text(cron));
  // A function object cannot carry an arbitrary apply without a find.
  const loose = shape({ apply: 'select 1;' });
  assert.match(text(loose), /function object without find/);
  // A table-level entry takes no find.
  const tf = sqlRun(
    sqlEntry({
      object: 'trigger tbl_guard on public.tbl',
      apply: 'drop trigger tbl_guard on public.tbl;',
      find: 'x',
      replace: 'y',
    }),
    { 'supabase/schema/tables/public.tbl.sql': tblSnap },
    'public.tbl',
  );
  assert.match(text(tf), /only a function object takes find, replace or also/);
});

test('CM-16 protects without a row or spec id, or under 4 words, rejected', () => {
  const one = (protects) =>
    sqlRun(sqlEntry({ protects }), {
      ...FN_F,
    });
  for (const bad of ['3#1', '3#15 avatar_url bound']) {
    const r = one(bad);
    assert.match(
      text(r),
      /shape: FU1\/M1 protects has \d words, needs 4 or more/,
      bad,
    );
  }
  const noRef = one('no reference in this text');
  assert.match(text(noRef), /protects names no contract row or spec id/);
  for (const good of [
    'phone-swipe-paging.spec.ts :: Day view swipe',
    'rule 6 / 5.2 outsider lists nothing',
  ]) {
    const r = one(good);
    assert.equal(r.code, 0, `${good}: ${text(r)}`);
  }
  // A patch entry is held to the same rule.
  const { dir, base } = mk({
    'src/a.ts': SRC_A,
    'test/a.test.mjs': TEST_A,
    [`${R}src.json`]: area({ 'FU1/M1': patch({ protects: '3#1' }) }),
  });
  assert.match(text(check(dir, base)), /protects has 1 words/);
});

test('CM-17 a new key gets the shape rules only', () => {
  const put1 = (entry) => {
    const { dir, base } = mk({ 'test/a.test.mjs': TEST_A });
    put(dir, `${R}db/public.f.json`, area({ 'FU9/M1': entry }));
    return check(dir, base);
  };
  const unknown = put1(fnEdit());
  assert.equal(unknown.code, 0, text(unknown));
  assert.match(
    text(
      put1(
        sqlEntry({
          apply:
            'create or replace function public.f() returns int language sql as $$ select 1 $$;',
        }),
      ),
    ),
    /whole-body apply/,
  );
  assert.match(text(put1(fnEdit({ protects: '3#1' }))), /protects has 1 words/);
});

test('CM-18 an sql entry is filed by its object', () => {
  const place = (entry, stem) => sqlRun(entry, FN_F, stem);
  const ok = place(fnEdit(), 'public.f');
  assert.equal(ok.code, 0, text(ok));
  const wrong = place(fnEdit(), 'public.tbl');
  assert.match(
    text(wrong),
    /misfiled: FU1\/M1 in .*db\/public\.tbl\.json - move to .*db\/public\.f\.json/,
  );
  // A table-level object is filed by its table, not by its own name.
  const tl = sqlRun(
    sqlEntry({
      object: 'trigger tbl_guard on public.tbl',
      apply: 'drop trigger tbl_guard on public.tbl;',
    }),
    { 'supabase/schema/tables/public.tbl.sql': tblSnap },
    'public.tbl',
  );
  assert.equal(tl.code, 0, text(tl));
  // `also` objects do not change the area.
  const also = place(
    fnEdit({
      also: [{ object: 'function public.g(uuid)', find: 'a', replace: 'b' }],
    }),
    'public.f',
  );
  assert.ok(!has(also, 'misfiled', 'FU1/M1'), text(also));
});
