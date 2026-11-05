// Run by `pnpm test:tools`. Pure functions only: no stack, no docker, no shell.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CREATE_ORDER,
  DIGEST_SQL,
  DROP_ORDER,
  OBJECTS_SQL,
  SNAPSHOT_SQL,
  buildRestore,
  dbContainer,
  diffCatalog,
  parseDigest,
  parseSnapshot,
  splitStatements,
  toPlpgsql,
  uncoveredStatement,
  wrapForCli,
} from '../../mutations/snapshot.mjs';

test('MS-1 splitStatements: quoted, dollar-quoted and commented semicolons do not split', () => {
  const cases = [
    [`select 'a;b'`, 1],
    [String.raw`select E'a\';b'`, 1],
    [`select "x;y" from t`, 1],
    [`do $$ begin x; y; end $$`, 1],
    [
      `create function f() returns int as $f$ select 1; select 2; $f$ language sql`,
      1,
    ],
    [`select 1 -- ; here\n`, 1],
    [`select 1 /* a /* ; */ ; */`, 1],
    [`select 'it''s;ok'`, 1],
  ];
  for (const [sql, n] of cases)
    assert.equal(splitStatements(sql).length, n, sql);
  assert.deepEqual(
    splitStatements(`select 1; select 2;\n  ;\n-- tail\n/* c */`),
    ['select 1', 'select 2'],
  );
  assert.deepEqual(splitStatements(`drop trigger a on t; select 'x;y'`), [
    'drop trigger a on t',
    `select 'x;y'`,
  ]);
});

test('MS-2 wrapForCli wraps once, leaves a single statement and a do block alone', () => {
  const two = `drop trigger t on public.x;\ncreate or replace function f() returns int language sql as $$ select 1; $$;`;
  const w = wrapForCli(two);
  assert.match(w, /^do \$mutate_check_wrap\$ begin\n/);
  assert.match(w, /end \$mutate_check_wrap\$;$/);
  assert.ok(w.includes('drop trigger t on public.x;'));
  assert.ok(w.includes('as $$ select 1; $$;'));
  assert.equal(wrapForCli(w), w);
  const one = 'drop trigger t on public.x;';
  assert.equal(wrapForCli(one), one);
  const doBlock = `do $m$ begin execute 'select 1'; perform 2; end $m$;`;
  assert.equal(wrapForCli(doBlock), doBlock);
  assert.match(
    wrapForCli(
      `select cron.schedule('a','* * * * *','select 1'); drop trigger t on public.x`,
    ),
    /perform cron\.schedule/,
  );
  assert.throws(
    () => wrapForCli(`begin; drop trigger t on public.x; commit;`),
    /cannot wrap for the CLI channel/,
  );
  assert.throws(
    () => wrapForCli(`select 1; do $$ begin end $$`),
    /cannot wrap for the CLI channel/,
  );
  assert.equal(toPlpgsql('  select 1;'), 'perform 1');
});

test('MS-3 parsers read psql, CLI text and CLI json output; markers are required', () => {
  const hex = 'a'.repeat(32);
  for (const out of [
    `MCDIGEST:${hex}:MCDIGEST\n`,
    `| col |\n|-----|\n| MCDIGEST:${hex}:MCDIGEST |\n`,
    JSON.stringify({ rows: [{ x: `MCDIGEST:${hex}:MCDIGEST` }] }),
  ])
    assert.equal(parseDigest(out), hex);
  assert.throws(() => parseDigest('nothing'), /MCDIGEST/);
  const objs = [
    {
      kind: 'policy',
      key: 'public.t.p',
      fp: 'f',
      create: 'c',
      drop: 'd',
      extra: { owner: 'o' },
    },
  ];
  const b64 = Buffer.from(JSON.stringify(objs)).toString('base64');
  for (const out of [
    `MCSNAP:${b64}:MCSNAP\n`,
    `| MCSNAP:${b64}:MCSNAP |`,
    JSON.stringify([{ s: `MCSNAP:${b64}:MCSNAP` }]),
  ]) {
    const [o] = parseSnapshot(out);
    assert.equal(o.key, 'public.t.p');
    assert.equal(o.owner, 'o');
    assert.equal(o.extra, undefined);
  }
  assert.throws(() => parseSnapshot('nothing'), /MCSNAP/);
  assert.ok(DIGEST_SQL.includes(OBJECTS_SQL));
  assert.ok(SNAPSHOT_SQL.includes(OBJECTS_SQL));
  assert.ok(
    DIGEST_SQL.includes('MCDIGEST:') && SNAPSHOT_SQL.includes('MCSNAP:'),
  );
});

test('MS-4 diffCatalog classes, omission and order', () => {
  const o = (kind, key, fp) => ({ kind, key, fp });
  const base = [
    o('trigger', 'b', '1'),
    o('policy', 'z', '1'),
    o('policy', 'a', '1'),
    o('index', 'i', '1'),
  ];
  const now = [
    o('policy', 'a', '2'),
    o('policy', 'z', '1'),
    o('function', 'f', '1'),
    o('index', 'i', '1'),
  ];
  const d = diffCatalog(base, now);
  assert.deepEqual(
    d.map((x) => `${x.kind}:${x.key}:${x.change}`),
    ['function:f:appeared', 'policy:a:changed', 'trigger:b:missing'],
  );
  assert.equal(d[1].base.fp, '1');
  assert.equal(d[1].now.fp, '2');
  assert.equal(d[0].base, undefined);
});

const fn = (key, body, extra = {}) => ({
  kind: 'function',
  key,
  fp: body,
  create: `create or replace function ${key} ${body}`,
  drop: `drop function ${key} cascade`,
  args: 'a integer',
  result: 'integer',
  owner: 'postgres',
  acl: ['postgres|EXECUTE|false', 'PUBLIC|EXECUTE|false'],
  ...extra,
});
const obj = (kind, key, fp, extra = {}) => ({
  kind,
  key,
  fp,
  create: `create ${kind} ${key} ${fp}`,
  drop: `drop ${kind} ${key}`,
  ...extra,
});

test('MS-5 buildRestore orders drops then creates and ends with the pgrst reload', () => {
  const diff = diffCatalog(
    [
      obj('policy', 'public.t.p', '1'),
      obj('trigger', 'public.t.trg', '1'),
      obj('constraint', 'public.t.fk', '1', { contype: 'f' }),
      obj('constraint', 'public.t.ck', '1', { contype: 'c' }),
      obj('index', 'public.ix', '1'),
      fn('public.f(a integer)', 'v1'),
      {
        kind: 'table',
        key: 'public.t',
        fp: 'a',
        relkind: 'r',
        rls: true,
        force: false,
        owner: 'postgres',
        acl: ['postgres|SELECT|false'],
      },
    ],
    [
      obj('policy', 'public.t.p', '2'),
      obj('trigger', 'public.t.trg', '2'),
      obj('constraint', 'public.t.fk', '2', { contype: 'f' }),
      obj('constraint', 'public.t.ck', '2', { contype: 'c' }),
      obj('index', 'public.ix', '2'),
      fn('public.f(a integer)', 'v2', { result: 'text' }),
      {
        kind: 'table',
        key: 'public.t',
        fp: 'b',
        relkind: 'r',
        rls: false,
        force: false,
        owner: 'postgres',
        acl: ['postgres|SELECT|false'],
      },
    ],
  );
  const { sql, unrestorable } = buildRestore(diff);
  assert.deepEqual(unrestorable, []);
  assert.match(sql, /^do \$mutate_check_restore\$ begin\n/);
  assert.match(
    sql,
    /perform pg_notify\('pgrst', 'reload schema'\);\nend \$mutate_check_restore\$;$/,
  );
  const at = (s) => {
    const i = sql.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };
  const drops = [
    'drop policy',
    'drop trigger',
    'drop constraint public.t.fk',
    'drop constraint public.t.ck',
    'drop index',
    'drop function',
  ].map(at);
  assert.deepEqual(
    [...drops],
    [...drops].sort((a, b) => a - b),
  );
  const creates = [
    'create or replace function',
    'enable row level security',
    'create index public.ix',
    'create constraint public.t.ck',
    'create constraint public.t.fk',
    'create trigger',
    'create policy',
  ].map(at);
  assert.deepEqual(
    [...creates],
    [...creates].sort((a, b) => a - b),
  );
  assert.ok(drops.at(-1) < creates[0]);
  assert.deepEqual(DROP_ORDER, [
    'policy',
    'trigger',
    'constraint',
    'index',
    'cron',
    'function',
  ]);
  assert.deepEqual(CREATE_ORDER, [
    'function',
    'table',
    'index',
    'constraint',
    'trigger',
    'policy',
    'cron',
  ]);
  assert.equal(buildRestore([]).sql, null);
});

test('MS-6 function paths and ACL lines', () => {
  const key = 'public.f(a integer)';
  const body = buildRestore(diffCatalog([fn(key, 'v1')], [fn(key, 'v2')])).sql;
  assert.ok(body.includes('create or replace function public.f(a integer) v1'));
  assert.ok(!body.includes('drop function'));
  for (const changed of [{ result: 'text' }, { args: 'a bigint' }]) {
    const sql = buildRestore(
      diffCatalog([fn(key, 'v1')], [fn(key, 'v1x', changed)]),
    ).sql;
    assert.ok(
      sql.indexOf(`drop function ${key} cascade`) <
        sql.indexOf('create or replace function'),
      JSON.stringify(changed),
    );
  }
  const over = buildRestore(
    diffCatalog([], [fn('public.f(b text)', 'v1')]),
  ).sql;
  assert.ok(over.includes('drop function public.f(b text) cascade'));
  assert.ok(!over.includes('create or replace'));
  const base = fn(key, 'v1', {
    acl: [
      'postgres|EXECUTE|false',
      'authenticated|EXECUTE|true',
      'PUBLIC|EXECUTE|false',
    ],
  });
  const now = fn(key, 'v2', {
    acl: ['postgres|EXECUTE|false', 'anon|EXECUTE|false'],
  });
  const sql = buildRestore(diffCatalog([base], [now])).sql;
  assert.ok(
    sql.includes(
      `revoke all on function ${key} from public, anon, authenticated;`,
    ),
  );
  assert.ok(
    sql.includes(
      `grant execute on function ${key} to authenticated with grant option;`,
    ),
  );
  assert.ok(sql.includes(`grant execute on function ${key} to public;`));
  assert.ok(
    !/postgres[,;\s]/.test(
      sql
        .split('perform pg_notify')[0]
        .replace(/create or replace function[^\n]*\n?/, ''),
    ),
  );
  const own = buildRestore(
    diffCatalog([fn(key, 'v1')], [fn(key, 'v1', { owner: 'other' })]),
  );
  assert.equal(own.sql, null);
});

test('MS-7 cron, enum and appeared-table handling', () => {
  const job = (active) => ({
    kind: 'cron',
    key: 'nightly',
    fp: 'x',
    jobid: 7,
    create: active
      ? `select cron.schedule('nightly', '0 1 * * *', 'select 1')`
      : `select cron.alter_job(cron.schedule('nightly', '0 1 * * *', 'select 1'), active := false)`,
    drop: 'select cron.unschedule(7::bigint)',
  });
  const missing = buildRestore(diffCatalog([job(false)], [])).sql;
  assert.ok(missing.includes(`perform cron.alter_job(`));
  assert.ok(missing.includes('active := false'));
  const appeared = buildRestore(diffCatalog([], [job(true)])).sql;
  assert.ok(appeared.includes('perform cron.unschedule(7::bigint);'));
  const e = buildRestore(
    diffCatalog(
      [{ kind: 'enum', key: 'public.e', fp: 'a,b' }],
      [{ kind: 'enum', key: 'public.e', fp: 'a,b,c' }],
    ),
  );
  assert.deepEqual(e, { sql: null, unrestorable: ['enum'] });
  assert.deepEqual(
    buildRestore(
      diffCatalog([], [{ kind: 'table', key: 'public.new', fp: 'x' }]),
    ).unrestorable,
    ['table'],
  );
});

test('MS-9 dbContainer reads the first uncommented project_id', () => {
  const toml = `# project_id = "x"\n  project_id = "demo-project"\n# project_id = "y"\n`;
  assert.equal(dbContainer(toml), 'supabase_db_demo-project');
  assert.equal(
    dbContainer(`# project_id = "x"\nproject_id = "real"\n`),
    'supabase_db_real',
  );
  assert.throws(() => dbContainer('# project_id = "x"\n'), /project_id/);
});
