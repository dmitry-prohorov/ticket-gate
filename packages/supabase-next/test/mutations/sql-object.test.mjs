// SO-1..SO-4. Pure functions: no
// repo, no stack. Run by `pnpm test:tools`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseObject } from '../../mutations/sql-kind.mjs';
import {
  checkProtects,
  expandSql,
  functionBody,
  PRIVILEGE_ONLY,
  sqlFindPattern,
  WHOLE_BODY,
} from '../../mutations/sql-object.mjs';

test('SO-1 parseObject accepts the five kinds and rejects the rest', () => {
  assert.deepEqual(parseObject('function public.f(uuid, text)'), {
    kind: 'function',
    schema: 'public',
    name: 'f',
    args: 'uuid, text',
  });
  assert.equal(parseObject('function public.f()').args, '');
  assert.deepEqual(parseObject('table public.t'), {
    kind: 'table',
    schema: 'public',
    name: 't',
  });
  for (const kind of ['trigger', 'policy', 'constraint'])
    assert.deepEqual(parseObject(`${kind} x_y on public.t`), {
      kind,
      name: 'x_y',
      schema: 'public',
      table: 't',
    });
  assert.equal(parseObject('cron notify-x').kind, 'cron');
  for (const bad of [
    'table t', // unqualified
    'function public.f', // no argument parens
    'function f(uuid)',
    'trigger x on t',
    'trigger x public.t',
    'index public.i',
    'public.f(uuid)',
    '',
    undefined,
  ])
    assert.equal(parseObject(bad), null, String(bad));
});

test('SO-2 functionBody returns the text between the dollar tags', () => {
  const snap = (tag) =>
    `-- Name: f(uuid); Type: FUNCTION; Schema: public; Owner: x\n\nCREATE FUNCTION public.f(p uuid) RETURNS int\n    LANGUAGE sql\n    AS ${tag}\nselect 1;\n${tag};\n`;
  assert.equal(functionBody(snap('$$')), '\nselect 1;\n');
  assert.equal(functionBody(snap('$_$')), '\nselect 1;\n');
  // The header and signature are outside the body.
  assert.ok(!functionBody(snap('$$')).includes('RETURNS'));
  // A different tag inside the body does not end it.
  assert.equal(
    functionBody('CREATE FUNCTION x() RETURNS int AS $fn$ a $$ b $$ c $fn$;'),
    ' a $$ b $$ c ',
  );
  assert.equal(functionBody('no body here'), null);
  assert.equal(functionBody('AS $$ never closed'), null);
});

test('SO-3 findPattern matches across whitespace and escapes metacharacters', () => {
  const pg = sqlFindPattern('a  b\n   c');
  assert.equal(pg, 'a[[:space:]]+b[[:space:]]+c');
  // The same pattern read as a JS RegExp (the class is POSIX; JS reads
  // [[:space:]] as a set of the characters : s p a c e, so map it for the check).
  const js = (p) => new RegExp(p.replaceAll('[[:space:]]', '\\s'));
  assert.match('a b c', js(pg));
  assert.match('a\n\tb \n  c', js(pg));
  assert.doesNotMatch('abc', js(pg));
  for (const ch of [
    '(',
    ')',
    '.',
    '[',
    ']',
    '$',
    '\\',
    '*',
    '+',
    '?',
    '^',
    '|',
    '{',
    '}',
  ]) {
    const p = sqlFindPattern(`x${ch}y`);
    assert.equal(p, `x\\${ch}y`, ch);
    assert.match(`x${ch}y`, js(p), ch);
    assert.doesNotMatch('xzy', js(p), ch);
  }
  assert.equal(sqlFindPattern('a.b').includes('.'), true);
  assert.doesNotMatch('axb', js(sqlFindPattern('a.b')));
});

const edit = (over = {}) => ({
  object: 'function public.f(uuid)',
  find: 'select 1',
  replace: 'select 2',
  ...over,
});

test('SO-4 expandSql chains edits on one object and picks unused dollar tags', () => {
  // No find: the apply as is.
  assert.equal(
    expandSql({ apply: 'drop trigger t on public.x;' }),
    'drop trigger t on public.x;',
  );
  // Two edits on one object: one pg_get_functiondef, one execute, two edits.
  const two = expandSql(edit({ also: [edit({ find: 'a', replace: 'b' })] }));
  assert.equal(two.match(/pg_get_functiondef/g).length, 1);
  assert.equal(two.match(/execute h \|\| b \|\| t;/g).length, 1);
  assert.equal(two.match(/regexp_replace\(/g).length, 2);
  // A second object gets its own definition.
  const other = expandSql(
    edit({ also: [edit({ object: 'function public.g(text)' })] }),
  );
  assert.equal(other.match(/pg_get_functiondef/g).length, 2);
  assert.match(other, /'public\.g\(text\)'::regprocedure/);
  // A find holding the default tag moves the quoting to another one.
  const tagged = expandSql(edit({ replace: 'x $m1$ y $m$ z' }));
  assert.match(tagged, /^do \$m2\$ declare/);
  assert.ok(!/\$m\$ y/.test(tagged.replace(/x \$m1\$ y \$m\$ z/, '')));
  // Backslashes in replace are doubled (regexp_replace reads \\1 and \\&).
  assert.match(expandSql(edit({ replace: 'a\\1b' })), /a\\\\1b/);
  // The raise message is a literal: % in an object is doubled.
  assert.match(
    expandSql(edit({ object: 'function public.f(uuid)' })),
    /mutation find occurs % times in function public\.f\(uuid\)/,
  );
  // A leading apply (a grant) runs first.
  const grant = 'grant execute on function public.f(uuid) to authenticated;';
  assert.ok(expandSql(edit({ apply: grant })).startsWith(`${grant}\n`));
});

test('SO-5 WHOLE_BODY, PRIVILEGE_ONLY and checkProtects classify their inputs', () => {
  assert.ok(WHOLE_BODY.test('create or replace function x() returns int'));
  assert.ok(WHOLE_BODY.test("execute 'CREATE PROCEDURE p()'"));
  assert.ok(WHOLE_BODY.test('select pg_get_functiondef(1)'));
  assert.ok(!WHOLE_BODY.test('alter policy p on public.t using (true);'));
  for (const ok of [
    'grant execute on function public.f(uuid) to authenticated;',
    'revoke all on public.t from anon; grant select on public.t to anon;',
    "select cron.schedule('j', '* * * * *', $$select 1$$);",
    "do $m$ begin execute 'grant execute on function public.f() to anon'; perform pg_notify('pgrst', 'reload schema'); end $m$;",
    "do $m$ begin execute 'grant update on public.t to authenticated'; end $m$;",
  ])
    assert.ok(PRIVILEGE_ONLY.test(ok), ok);
  for (const no of [
    'drop trigger t on public.x;',
    'grant select on public.t to anon; drop policy p on public.t;',
    '',
  ])
    assert.ok(!PRIVILEGE_ONLY.test(no), no);
  assert.equal(checkProtects('3#1'), 'protects has 1 words, needs 4 or more');
  assert.equal(
    checkProtects('one two three four'),
    'protects names no contract row or spec id',
  );
  assert.equal(checkProtects('3#1 a policy guards rows'), null);
});

test('SO-6 find also in the signature counts and edits the body only', () => {
  // A find such as "uuid[]" sits in the header and the body; check side counts
  // the body, so the run side must too, or the check passes and the run raises.
  const sql = expandSql(
    edit({
      object: 'function private.f(jsonb, uuid[])',
      find: 'uuid[]',
      replace: 'x',
    }),
  );
  assert.match(
    sql,
    /select prosrc from pg_proc where oid = 'private\.f\(jsonb, uuid\[\]\)'::regprocedure/,
  );
  assert.match(sql, /regexp_count\(b, /);
  assert.doesNotMatch(sql, /regexp_count\(d, /);
  assert.doesNotMatch(sql, /regexp_replace\(d, /);
});
