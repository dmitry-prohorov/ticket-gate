import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LEAN_RESET, sqlKind } from '../mutations/sql-kind.mjs';
import { supabaseNext } from '../index.mjs';

test('SN-1 supabaseNext: no registry hook; mutationKinds.sql; one next-served harness with mutations opts, none without', () => {
  const without = supabaseNext();
  assert.equal('registry' in without, false);
  assert.equal(without.mutationKinds.sql, sqlKind);
  assert.deepEqual(without.mutationHarnesses, []);

  const opts = { port: 3123, env: { A: '1' } };
  const withOpts = supabaseNext({ mutations: opts });
  assert.equal('registry' in withOpts, false);
  assert.equal(withOpts.mutationHarnesses.length, 1);
  const [harness] = withOpts.mutationHarnesses;
  assert.equal(harness.name, 'next-served');
  assert.equal(harness.order, 1);
  assert.equal(harness.opts.port, 3123);
  assert.deepEqual(harness.opts.env, { A: '1' });
  assert.equal(typeof harness.ioMethods, 'function');
  assert.equal(typeof harness.precheck, 'function');
  assert.equal(typeof harness.typecheck.main, 'function');
});

const sqlIoOf = (sql) => {
  const calls = { sh: [], exec: [] };
  const h = {
    sh: async (cmd, limitS) => (calls.sh.push([cmd, limitS]), { code: 0, out: '' }),
    exec: async (file, args, o) => (
      calls.exec.push([file, args, o]), { code: 0, out: '' }
    ),
  };
  const io = supabaseNext(sql === undefined ? {} : { sql }).mutationKinds.sql.session.ioMethods(h);
  return { io, calls };
};

test('PO-1 sql.reset replaces the lean reset command of the sql session', async () => {
  const { io, calls } = sqlIoOf({ reset: 'echo r' });
  await io.resetDb();
  assert.equal(calls.sh.length, 1);
  assert.equal(calls.sh[0][0], 'echo r');
});

test('PO-2 sql.preflight replaces the preflight command, args and limit', async () => {
  const { io, calls } = sqlIoOf({
    preflight: { cmd: 'check-stack', args: ['--db'], limitS: 7 },
  });
  await io.preflight();
  assert.deepEqual(calls.exec, [['check-stack', ['--db'], { limitS: 7 }]]);
});

test("PO-3 no sql option keeps today's reset and preflight; an unknown sql key throws", async () => {
  for (const sql of [undefined, {}]) {
    const { io, calls } = sqlIoOf(sql);
    await io.resetDb();
    await io.preflight();
    assert.equal(calls.sh[0][0], LEAN_RESET);
    assert.deepEqual(calls.exec, [
      ['node', ['tools/stack-preflight.mjs', '--steps=db', '--wait=20'], { limitS: 30 }],
    ]);
  }
  assert.throws(
    () => supabaseNext({ sql: { rest: 'x' } }),
    /supabase-next: unknown sql option rest/,
  );
});
