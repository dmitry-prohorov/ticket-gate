import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { enterScratchProject } from '../scratch-project.mjs';

// gate.mjs reaches project.mjs, which loads gate.config.mjs from the working directory at import.
const leave = enterScratchProject();
after(leave);
const { defineGate, MUTATION_COMMAND_KEYS } = await import(
  '../../config.mjs'
);
const { setupOf } = await import('../../mutations/gate.mjs');

const gate = (mutations, extra = {}) =>
  defineGate({ steps: [], mutations, ...extra });
const msg = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  return null;
};

test('MK-1 defineGate accepts mutations and rejects an unknown sub-key, packs and commands inside it', () => {
  assert.doesNotThrow(() => gate({}));
  assert.doesNotThrow(() =>
    gate({ dir: 'registry', childEnv: { drop: ['X'] }, reuseEnv: { A: '1' } }),
  );
  assert.equal(
    msg(() => gate({ bogus: 1 })),
    'gate.config: mutations.bogus: unknown key',
  );
  assert.equal(
    msg(() => gate({ packs: [] })),
    'gate.config: mutations.packs: unknown key',
  );
  assert.equal(
    msg(() => gate({ commands: {} })),
    'gate.config: mutations.commands: unknown key',
  );
  assert.equal(
    msg(() => gate('x')),
    'gate.config: mutations: must be an object',
  );
});

test('MK-2 mutations.dir must be a relative directory path', () => {
  for (const dir of ['/abs', 'a/../b', '', '..'])
    assert.equal(
      msg(() => gate({ dir })),
      'gate.config: mutations.dir: must be a relative directory path',
      JSON.stringify(dir),
    );
  assert.doesNotThrow(() => gate({ dir: 'tools/registry' }));
});

test('MK-3 a kind without name, runs or shape(entry) is a config error naming it', () => {
  const ok = { name: 'k', runs: true, shape: () => [] };
  assert.doesNotThrow(() => gate({ kinds: { k: ok } }));
  for (const bad of [
    { runs: true, shape: () => [] },
    { name: 'k', shape: () => [] },
    { name: 'k', runs: true },
  ])
    assert.equal(
      msg(() => gate({ kinds: { k: bad } })),
      'gate.config: mutations.kinds.k: needs name, runs and shape(entry)',
    );
});

test('MK-4 commands.mutate and the four other mutation keys pass validation and reach setupOf(gate).commands', () => {
  assert.equal(MUTATION_COMMAND_KEYS.length, 5);
  const commands = Object.fromEntries(
    MUTATION_COMMAND_KEYS.map((k) => [k, `run ${k}`]),
  );
  const g = gate({}, { commands });
  const setup = setupOf(g);
  for (const k of MUTATION_COMMAND_KEYS)
    assert.equal(setup.commands[k], `run ${k}`, k);
  assert.equal(setupOf(gate({})).commands.mutate, 'ticket-gate mutate');
});
