import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sqlKind } from '../mutations/sql-kind.mjs';
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
