// UK-1..UK-4: the `unguarded` mutation kind factory.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineGate } from '../../config.mjs';
import { unguardedKind } from '../../checks/assertions-unguarded.mjs';
import { toSpec } from '../../mutations/registry.mjs';

const kind = (over = {}) =>
  unguardedKind({
    from: /^tests\/.+\.test\.ts$/,
    fromHint: 'tests/<...>.test.ts',
    ...over,
  });
const entry = { from: 'tests/a.test.ts', title: 't', why: 'w' };

test('UK-1 shape requires from, title and why', () => {
  const k = kind();
  assert.deepEqual(k.shape(entry), []);
  for (const f of ['title', 'why', 'from']) {
    const out = k.shape({ ...entry, [f]: undefined });
    assert.deepEqual(out, [`${f} must be a non-empty string`]);
  }
  assert.deepEqual(k.shape({ ...entry, title: '  ' }), ['title must be a non-empty string']);
});

test('UK-2 strays rejects a from outside the configured shape', () => {
  const k = kind();
  assert.deepEqual(k.strays({ from: 'x.ts' }), ['from must match tests/<...>.test.ts']);
  assert.deepEqual(k.strays({}), []);
  assert.deepEqual(k.strays(entry), []);
});

test('UK-3 area is the prefix plus the from directory', () => {
  assert.equal(kind({ prefix: 'web/' }).area({ from: 'e2e/x.spec.ts' }, 'reg'), 'reg/web/e2e.json');
  assert.equal(kind().area({ from: 'e2e/x.spec.ts' }, 'reg'), 'reg/e2e.json');
});

test('UK-4 the kind never runs and defineGate accepts it', () => {
  const k = kind();
  assert.equal(k.runs, false);
  assert.equal(k.name, 'unguarded');
  assert.deepEqual(k.fields, ['title', 'why', 'from']);
  const setup = { kinds: new Map([['unguarded', k]]) };
  const spec = toSpec([['T-1/U1', { kind: 'unguarded', ...entry }]], 'T-1', setup);
  assert.deepEqual(spec.mutations, []);
  assert.doesNotThrow(() => defineGate({ mutations: { kinds: { unguarded: k } } }));
});
