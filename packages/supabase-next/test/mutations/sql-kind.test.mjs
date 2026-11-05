// Run by `pnpm test:tools`. Function cases inject fakes (no shell, pnpm or
// stack); CLI cases spawn the script in a throwaway repo under os.tmpdir() with
// plain shell test commands, so nothing touches this repo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { compareKeys } from '#engine/mutations/registry.mjs';
import {
  finalOutcome,
  interruptHandler,
  runMutations,
  summaryLine,
} from '#engine/mutations/run.mjs';
import {
  LEAN_RESET,
  objectKind,
  parseObject,
  snapshotPath,
} from '../../mutations/sql-kind.mjs';
import { validateSpec } from '#engine/mutations/validate.mjs';
import { checkSqlEntry, expandSql } from '../../mutations/sql-object.mjs';
import { uncoveredStatement } from '../../mutations/snapshot.mjs';
import {
  ORIGINAL,
  repo,
  patch,
  scratch,
  sql,
  world,
  bites,
  green,
  whileMutated,
  policyObj,
} from '../../../engine/test/mutations/__tests__/mutate-check.helpers.mjs';

test('MC-5 applySql failing -> error, lean reset follows, digest checked', async () => {
  const w = world(green);
  const apply = w.io.applySql;
  w.io.applySql = (s) => {
    apply(s);
    return { code: 1, out: 'syntax error' };
  };
  const r = await runMutations({ mutations: [sql('M1')] }, w.io);
  assert.equal(r.results[0].status, 'error');
  assert.match(r.results[0].detail, /apply failed/);
  assert.match(r.results[0].detail, /restored by reset \(apply failed\)$/);
  const i = w.log.indexOf('reset');
  assert.ok(i > 0);
  assert.equal(w.log[i + 1], 'digest');
  assert.equal(r.ok, false);
});

test('MC-11 lean reset failing after a fallback -> error, fatal, run stops', async () => {
  const w = world(bites());
  w.digestFn = (n) => (n === 0 ? 'BASE' : 'OTHER');
  w.io.resetDb = () => ({ code: 1, out: 'docker down' });
  const r = await runMutations({ mutations: [sql('M1'), sql('M2')] }, w.io);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'error');
  assert.match(r.results[0].detail, /db:reset failed/);
  assert.match(r.fatal, /baseline not reproducible/);
  assert.equal(r.ok, false);
});

test('MC-2 unproven after both restore passes: one reset, killed, restored by reset (policy)', async () => {
  const w = world(whileMutated);
  w.digestFn = (n) =>
    n === 0 ? 'BASE' : n === 1 || n === 2 ? 'OTHER' : 'BASE';
  w.snapFn = (n) => (n === 0 ? [] : [policyObj()]);
  const r = await runMutations({ mutations: [sql('M1')] }, w.io);
  assert.equal(r.results[0].status, 'killed');
  assert.equal(
    r.results[0].detail.split('\n').at(-1),
    'restored by reset (policy)',
  );
  assert.equal(w.log.filter((l) => l === 'reset').length, 2); // fallback + final
  assert.equal(r.fatal, undefined);
  // pass 1 and pass 2 applied a generated restore
  assert.equal(
    w.log.filter((l) => l.startsWith('sql:do $mutate_check_restore$')).length,
    2,
  );
});

test('MC-3 digest still differs after the reset: fatal, M2 never applied, no receipt', async () => {
  const w = world(whileMutated);
  w.digestFn = (n) => (n === 0 ? 'BASE' : 'OTHER');
  const r = await runMutations({ mutations: [sql('M1'), sql('M2')] }, w.io);
  assert.match(r.fatal, /baseline not reproducible/);
  assert.equal(w.log.filter((l) => l === "sql:select 'M2';").length, 0);
  assert.equal(w.log.filter((l) => l === 'reset').length, 1); // no final reset
  assert.equal(r.ok, false);
  assert.deepEqual(finalOutcome(r, []), { code: 1, writeReceipt: false });
});

test('MC-4 explicit restore replaces the automatic one; unproven digest then resets', async () => {
  const w = world(whileMutated);
  const m = { ...sql('M1'), restore: 'select 1 /* undo */;' };
  const r = await runMutations({ mutations: [m] }, w.io);
  const afterTest = w.log.slice(w.log.indexOf("sql:select 'M1';") + 2);
  assert.ok(w.log.includes('sql:select 1 /* undo */;'));
  assert.equal(afterTest.includes('snapshot'), false);
  assert.ok(afterTest.includes('digest'));
  assert.equal(r.results[0].status, 'killed');

  const w2 = world(whileMutated);
  w2.digestFn = (n) => (n === 1 ? 'OTHER' : 'BASE');
  const r2 = await runMutations({ mutations: [m] }, w2.io);
  assert.equal(
    r2.results[0].detail.split('\n').at(-1),
    'restored by reset (restore failed)',
  );
  assert.equal(w2.log.filter((l) => l === 'reset').length, 2);
});

test('MC-6 interruptHandler: sql applied -> reset then exit 130; patch -> file restored, no reset', async () => {
  const calls = [];
  const io = {
    resetDb: () => {
      calls.push('reset');
      return { code: 0, out: '' };
    },
  };
  await interruptHandler({ sqlApplied: true }, io, (c) =>
    calls.push(`exit:${c}`),
  );
  assert.deepEqual(calls, ['reset', 'exit:130']);

  const c2 = [];
  const io2 = { resetDb: () => (c2.push('reset'), { code: 0, out: '' }) };
  await interruptHandler(
    { restore: () => c2.push('restored'), sqlApplied: false },
    io2,
    (c) => c2.push(`exit:${c}`),
  );
  assert.deepEqual(c2, ['restored', 'exit:130']);

  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(m);
  try {
    await interruptHandler(
      { sqlApplied: true },
      { resetDb: () => ({ code: 1, out: '' }) },
      () => {},
    );
  } finally {
    console.error = orig;
  }
  assert.deepEqual(errs, ['run pnpm db:reset']);
});

test('MC-6b Ctrl-C during the final or pollution re-run reset still resets', async () => {
  for (const pollute of [false, true]) {
    const w = world(whileMutated);
    let runs = 0;
    if (pollute) {
      // Green before and red after M1, then red in the pollution guard.
      const base = w.io.run;
      w.io.run = (cmd) =>
        ++runs >= 3 ? (base(cmd), { code: 1, out: 'red' }) : base(cmd);
    }
    const state = {};
    w.io.state = state;
    const reset = w.io.resetDb;
    let fired = false;
    w.io.resetDb = async () => {
      const r = reset();
      if (!fired) {
        fired = true;
        await interruptHandler(state, w.io, (c) => w.log.push(`exit:${c}`));
      }
      return r;
    };
    await runMutations({ mutations: [sql('M1')] }, w.io);
    const i = w.log.indexOf('exit:130');
    assert.ok(i > 0, `pollute=${pollute}`);
    assert.deepEqual(
      w.log.slice(i - 2, i),
      ['reset', 'reset'],
      `pollute=${pollute}`,
    );
  }
});

test('MC-7 restore failure and enum diff both reset with their reason', async () => {
  const w = world(whileMutated);
  w.snapFn = (n) => (n === 0 ? [] : [policyObj()]);
  const apply = w.io.applySql;
  w.io.applySql = (s) =>
    s.startsWith('do $mutate_check_restore$')
      ? (apply(s), { code: 1, out: 'boom' })
      : apply(s);
  const r = await runMutations({ mutations: [sql('M1')] }, w.io);
  assert.equal(r.results[0].status, 'killed');
  assert.equal(
    r.results[0].detail.split('\n').at(-1),
    'restored by reset (restore failed)',
  );

  const w2 = world(whileMutated);
  w2.snapFn = (n) =>
    n === 0
      ? []
      : [{ kind: 'enum', key: 'public.e', fp: 'a', create: null, drop: null }];
  const r2 = await runMutations({ mutations: [sql('M1')] }, w2.io);
  assert.equal(
    r2.results[0].detail.split('\n').at(-1),
    'restored by reset (enum)',
  );
  assert.equal(
    w2.log.filter((l) => l.startsWith('sql:do $mutate_check_restore$')).length,
    0,
  );
});

test('MC-8 pollution: a kill that does not reproduce on a reset db is re-run and reported', async () => {
  const w = world((cmd, w) => {
    w.tests = (w.tests ?? 0) + 1;
    // 1 baseline green, 2 killed by M1, 3 red after the loop, 4 (re-run after reset) green
    return w.tests === 2 || w.tests === 3
      ? { code: 1, out: 'FAIL' }
      : { code: 0, out: 'ok' };
  });
  const r = await runMutations({ mutations: [sql('M1')] }, w.io);
  assert.equal(r.rerun, 1);
  assert.equal(r.results[0].status, 'survived');
  const runs = w.log
    .map((l, i) => (l.startsWith('run:') ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(w.log[runs[2] + 1], 'reset');
  assert.ok(
    summaryLine('T', r.results, r.rerun).endsWith(', 1 re-run after pollution'),
  );
  assert.equal(r.ok, false);
});

test('MC-8b sql pollution re-run also re-runs a killed patch that shares the test', async () => {
  // The db stays polluted after M1's apply until a reset; P1 (a patch) shares the test.
  let polluted = false;
  const w = world((_cmd, ww) => {
    ww.tests = (ww.tests ?? 0) + 1;
    return ww.tests > 1 && polluted
      ? { code: 1, out: 'FAIL polluted' }
      : { code: 0, out: 'ok' };
  });
  const apply = w.io.applySql;
  const reset = w.io.resetDb;
  w.io.applySql = (q) => {
    polluted = true;
    return apply(q);
  };
  w.io.resetDb = () => {
    polluted = false;
    return reset();
  };
  w.digestFn = () => 'BASE';
  w.snapFn = () => [];
  const r = await runMutations(
    { mutations: [sql('M1', 'shared'), patch('P1', { test: 'shared' })] },
    w.io,
  );
  assert.equal(r.results.find((x) => x.id === 'P1').status, 'survived');
  assert.equal(r.rerun, 2);
});

test('MC-9 LEAN_RESET is the lean command, not pnpm db:reset', () => {
  assert.equal(
    LEAN_RESET,
    'pnpm supabase db reset && pnpm supabase db query --local -f tools/local-vault.sql',
  );
  assert.doesNotMatch(LEAN_RESET, /db:types|db:schema|db:reset/);
});

test('MC-10 final reset not proven -> fatal (final)', async () => {
  const w = world(whileMutated);
  // 0 baseline, 1 proven after the restore, 2 final
  w.digestFn = (n) => (n === 2 ? 'OTHER' : 'BASE');
  const r = await runMutations({ mutations: [sql('M1')] }, w.io);
  assert.equal(r.fatal, 'baseline not reproducible (final)');
  assert.equal(r.ok, false);
});

test('MC-12 an uncovered apply resets without a snapshot', async () => {
  const w = world(whileMutated);
  const m = {
    ...sql('M1'),
    apply: "select 'M1'; alter table t alter column c drop not null;",
  };
  const r = await runMutations({ mutations: [m] }, w.io);
  assert.equal(
    r.results[0].detail.split('\n').at(-1),
    'restored by reset (uncovered: alter column)',
  );
  assert.equal(w.log.filter((l) => l === 'snapshot').length, 1); // baseline only
});

test('MC-14 summaryLine is unchanged without a re-run', () => {
  const results = [
    { id: 'M1', status: 'killed' },
    { id: 'M2', status: 'survived' },
    { id: 'M3', status: 'error' },
  ];
  const today = 'mutate:check T: 1/3 killed, 1 survived, 1 error';
  assert.equal(summaryLine('T', results), today);
  assert.equal(summaryLine('T', results, 0), today);
});

test('R4 an unreadable baseline is fatal and applies nothing', async () => {
  const w = world(whileMutated);
  w.io.digest = () => {
    throw new Error('no marker');
  };
  const r = await runMutations({ mutations: [sql('M1')] }, w.io);
  assert.match(r.fatal, /^baseline not readable: no marker/);
  assert.equal(w.log.filter((l) => l.startsWith('sql:')).length, 0);
});

test('a lossy write-back -> error naming the byte-identical check', async () => {
  const w = world(bites());
  const write = w.io.writeFile;
  let n = 0;
  w.io.writeFile = (p, s) => write(p, n++ === 0 ? s : s.slice(0, -1));
  const r = await runMutations({ mutations: [patch('M1')] }, w.io);
  assert.equal(r.results[0].status, 'error');
  assert.match(r.results[0].detail, /byte-identical/);
  assert.equal(r.ok, false);
});

test('MC-O1 parseObject, objectKind, snapshotPath and compareKeys follow the kind-prefixed grammar', () => {
  const fn = parseObject('function b.g(uuid, text)');
  assert.equal(fn.kind, 'function');
  assert.equal(fn.schema, 'b');
  assert.equal(fn.name, 'g');
  assert.ok(String(fn.args).includes('uuid'));
  const tbl = parseObject('table public.b');
  assert.deepEqual([tbl.kind, tbl.schema, tbl.name], ['table', 'public', 'b']);
  const typ = parseObject('type public.t');
  assert.deepEqual([typ.kind, typ.schema, typ.name], ['type', 'public', 't']);
  const cron = parseObject('cron nightly-job');
  assert.deepEqual([cron.kind, cron.name], ['cron', 'nightly-job']);
  for (const bad of ['', 'public.b', 'function', 'bogus x.y', 'table'])
    assert.equal(parseObject(bad), null, bad);
  assert.equal(objectKind('function b.g(uuid)'), 'function');
  assert.equal(objectKind('cron nightly-job'), 'cron');
  assert.equal(objectKind('nonsense'), null);
  assert.ok(
    snapshotPath('function b.g(uuid)').includes(
      'supabase/schema/functions/b.g.sql',
    ),
  );
  assert.ok(
    snapshotPath('table public.b').includes(
      'supabase/schema/tables/public.b.sql',
    ),
  );
  assert.ok(
    snapshotPath('type public.t').includes(
      'supabase/schema/types/public.t.sql',
    ),
  );
  assert.ok(
    snapshotPath('cron nightly-job').includes('supabase/schema/cron/jobs.sql'),
  );
  assert.deepEqual(
    ['T110/M10', 'T110/M2', 'T9/M1', 'T110/M1'].sort(compareKeys),
    ['T9/M1', 'T110/M1', 'T110/M2', 'T110/M10'],
  );
  assert.equal(compareKeys('T1/M2', 'T1/M2'), 0);
});

// MC-R6, MC-R7: the sql `object` form in a run.
const FN_SNAP =
  '--\n-- Name: f(uuid); Type: FUNCTION; Schema: public; Owner: postgres\n--\n\nCREATE FUNCTION public.f(p uuid) RETURNS int\n    LANGUAGE sql\n    AS $$ select 1 from t $$;\n';
const objectForm = (id, over = {}) => {
  const { apply: _apply, ...rest } = sql(id);
  return {
    ...rest,
    object: 'function public.f(uuid)',
    find: 'select 1',
    replace: 'select 2',
    ...over,
  };
};

test('MC-R6 object form expands into the pg_get_functiondef block and restores by digest', async () => {
  const m = objectForm('M1');
  const sqlText = expandSql(m);
  assert.match(
    sqlText,
    /pg_get_functiondef\('public\.f\(uuid\)'::regprocedure\)/,
  );
  assert.match(sqlText, /regexp_count\(b, [^)]*\) <> 1 then raise exception/);
  assert.match(sqlText, /if n = b then raise exception/);
  assert.equal(uncoveredStatement(sqlText), null);
  const w = world(whileMutated);
  w.io.applySql = (s) => {
    w.log.push(`sql:${s}`);
    w.mutated = true;
    return { code: 0, out: '' };
  };
  w.snapFn = () => [];
  // Nothing to undo in the catalog: the digest read after the test is the proof.
  w.digestFn = (n) => {
    if (n > 0) w.mutated = false;
    return 'BASE';
  };
  assert.deepEqual(
    validateSpec({ mutations: [m] }, () => FN_SNAP),
    [],
  );
  const r = await runMutations({ mutations: [m] }, w.io);
  assert.equal(r.results[0].status, 'killed', JSON.stringify(r.results[0]));
  assert.ok(w.log.includes(`sql:${sqlText}`));
  // Only the end-of-run reset: the mutation itself was restored in place.
  assert.equal(w.log.filter((l) => l === 'reset').length, 1);
  assert.doesNotMatch(r.results[0].detail ?? '', /restored by reset/);
  assert.ok(w.log.filter((l) => l === 'digest').length >= 2);
  // An object entry that also carries a grant applies the grant first.
  const grant = 'grant execute on function public.f(uuid) to authenticated;';
  assert.ok(expandSql({ ...m, apply: grant }).startsWith(grant));
});

test('MC-R7 a run validates sql objects against the snapshot first', () => {
  const stale = objectForm('M1', { find: 'select 9' });
  const errs = validateSpec({ mutations: [stale] }, () => FN_SNAP);
  assert.equal(errs.length, 1, errs.join('\n'));
  assert.match(
    errs[0],
    /find occurs 0 times in the body of function public\.f\(uuid\)/,
  );
  const missing = validateSpec({ mutations: [objectForm('M1')] }, () => {
    throw new Error('ENOENT');
  });
  assert.match(missing.join('\n'), /unknown object .*does not exist/);

  // CLI: exit 2, the test command never ran, nothing applied.
  const dir = repo(ORIGINAL, {
    'supabase/schema/functions/public.f.sql': FN_SNAP,
  });
  writeFileSync(
    join(dir, 'm.json'),
    scratch([objectForm('M1', { find: 'select 9', test: 'touch ran' })]),
  );
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json'],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(p.status, 2, p.stdout + p.stderr);
  assert.match(p.stdout + p.stderr, /find occurs 0 times in the body of/);
  assert.equal(existsSync(join(dir, 'ran')), false);
});
