import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { enterScratchProject } from '../scratch-project.mjs';

const leave = enterScratchProject();
after(leave);
const { packHooksAll } = await import('../../pack-hooks.mjs');
const { setupOf } = await import('../../mutations/gate.mjs');

const sqlKind = (by) => ({ name: 'sql', runs: false, shape: () => [], by });

test("PH-1 packHooksAll returns each pack's hook in packs order with by = name, skipping null", () => {
  const config = {
    packs: [
      { name: 'a', version: '1', hook: 1 },
      { name: 'b', version: '1', hook: null },
      { name: 'c', version: '1' },
      { name: 'd', version: '1', hook: 0 },
      { name: 'e', version: '1', hook: 'x' },
    ],
  };
  assert.deepEqual(packHooksAll('hook', config), [
    { by: 'a', value: 1 },
    { by: 'd', value: 0 },
    { by: 'e', value: 'x' },
  ]);
  assert.deepEqual(packHooksAll('hook', {}), []);
});

test('PH-2 two packs naming kind sql: setupOf throws naming both packs', () => {
  const pack = (name) => ({
    name,
    version: '1',
    mutationKinds: { sql: sqlKind(name) },
  });
  const gate = { packs: [pack('first'), pack('second')], commands: {} };
  assert.throws(
    () => setupOf(gate),
    /mutations config: kind "sql" is named by both first and second/,
  );
  const one = setupOf({ packs: [pack('first')], commands: {} });
  assert.equal(one.kinds.get('sql').by, 'first');
});
