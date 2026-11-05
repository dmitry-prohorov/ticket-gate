// Which lines of a migration a human must read: everything outside the function statements the
// schema snapshot already shows. Pure string work, so the cases are plain SQL text.
import assert from "node:assert/strict";
import { test } from "node:test";

import { migrationReadRanges } from "../sql-ranges.mjs";

const sql = (...l) => l.join("\n") + "\n";

test("RM-MR-3 a tagged dollar-quote is closed by its own tag only", () => {
  const t = sql(
    "create or replace function f() returns void language plpgsql as $fn$",
    "begin",
    "  perform $$inner$$;",
    "end $fn$;",
    "",
    "revoke all on function f() from public;",
  );
  assert.deepEqual(migrationReadRanges(t), [[5, 6]]);
});

test("RM-MR-5a a file with no function statement reads whole", () => {
  const none = sql(
    "alter table t add column c int;",
    "revoke all on t from x;",
  );
  assert.equal(migrationReadRanges(none), null);
});

test("RM-MR-5b a file of nothing but functions reads whole", () => {
  const only = sql(
    "create function a() returns int language sql as $$ select 1 $$;",
  );
  assert.equal(migrationReadRanges(only), null);
});

test("RM-MR-6 an unparseable file reads whole instead of listing fewer lines", () => {
  const unclosed = sql(
    "alter table t add column c int;",
    "create function a() returns int language sql as $$ select 1;",
  );
  const quoted = sql(
    "alter table t add column c int;",
    "create function a() returns int language sql as 'select 1';",
  );
  const comment = sql("alter table t add column c int;", "/* never closed");
  for (const text of [unclosed, quoted, comment])
    assert.equal(migrationReadRanges(text), null);
});

test("RM-MR-7 function starts are case-insensitive and multi-line; procedures stay", () => {
  const fn = (head) =>
    sql("select 1;", head, "  returns int language sql as $$ select 1 $$;");
  for (const head of [
    "CREATE OR REPLACE FUNCTION f()",
    "Create Function f()",
    "create or replace\n  function f()",
  ])
    assert.deepEqual(migrationReadRanges(fn(head)), [[1, 1]], head);
  const proc = sql(
    "select 1;",
    "create procedure p() language plpgsql as $$ begin end $$;",
    "create function f() returns int language sql as $$ select 1 $$;",
  );
  assert.deepEqual(migrationReadRanges(proc), [[1, 2]]);
});
