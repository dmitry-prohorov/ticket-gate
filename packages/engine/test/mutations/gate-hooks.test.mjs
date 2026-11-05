import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';

import {
  CONFIG_URL,
  bin,
  entries,
  gateProject,
} from './__tests__/gate-project.mjs';

const configWith = (mutations) =>
  `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};\nexport default defineGate({ steps: [step({ id: 'a', when: true, cmd: 'true', reuse: false })], ${mutations} });\n`;

// The registry lives in custom-reg/; mutation-registry/ holds a decoy key that must never be read.
const { dir } = gateProject({
  config: configWith("mutations: { dir: 'custom-reg' }"),
  registry: { 'D/M1': entries['T/M1'] },
  files: { 'custom-reg/src.json': JSON.stringify({ 'T/M1': entries['T/M1'] }) },
});
// ROOT is fixed when root.mjs is first imported: enter the project before importing the hooks.
process.chdir(dir);
after(() => process.chdir(tmpdir()));
const { defineGate } = await import('../../config.mjs');
const { registryHooks, registryPlan, registryDryLine } = await import(
  '../../mutations/gate.mjs'
);

test('GH-1 registryHooks is null without mutations; verify --dry-run prints no mutation-registry line', () => {
  assert.equal(registryHooks(defineGate({ steps: [] })), null);
  assert.notEqual(registryHooks(defineGate({ steps: [], mutations: {} })), null);

  const plain = gateProject({ config: configWith('') });
  const off = bin(plain.dir, ['verify', '--dry-run', '--base=main']);
  assert.equal(off.status, 0, off.out);
  assert.doesNotMatch(off.out, /mutation-registry:/);

  const on = gateProject({ config: configWith('mutations: {}') });
  const line = bin(on.dir, ['verify', '--dry-run', '--base=main']);
  assert.equal(line.status, 0, line.out);
  assert.match(line.out, /mutation-registry: 0 selected/);
});

test('GH-2 a throwing selector selects the step (when: true, error set)', () => {
  const plan = registryPlan(
    'main',
    () => {
      throw new Error('registry invalid: boom');
    },
    () => new Map(),
  );
  assert.deepEqual(plan, {
    when: true,
    keys: [],
    error: 'registry invalid: boom',
  });
  assert.equal(
    registryDryLine(plan),
    'mutation-registry: selection failed (registry invalid: boom); the step runs',
  );
});

test('GH-3 entries(), load() and ticketFromBranch() read the configured dir; precheck ids come from it', () => {
  const hooks = registryHooks(
    defineGate({ steps: [], mutations: { dir: 'custom-reg' } }),
  );
  assert.deepEqual([...hooks.entries().keys()], ['T/M1']);
  assert.deepEqual([...hooks.load(dir).entries.keys()], ['T/M1']);
  assert.deepEqual([...hooks.at('main', dir).entries.keys()], ['T/M1']);
  assert.deepEqual([...hooks.entriesAt('main').keys()], ['T/M1']);
  assert.equal(hooks.ticketFromBranch('chore/TKT-9-x'), 'TKT-9');
  assert.equal(hooks.ticketFromBranch('feat'), null);

  // The precheck keeps a ticket id only when the configured registry knows it.
  const check = `precheck: [(ctx) => [{ id: 'ids', cmd: 'test "' + ctx.ids.join(',') + '" = T', fix: 'n/a' }]],`;
  const p = gateProject({
    config: configWith(`${check} mutations: { dir: 'custom-reg' }`),
    registry: { 'D/M1': entries['T/M1'] },
    files: { 'custom-reg/src.json': JSON.stringify({ 'T/M1': entries['T/M1'] }) },
  });
  const known = bin(p.dir, ['verify', '--precheck', '--base=main', '--ticket=T']);
  assert.equal(known.status, 0, known.out);
  assert.match(known.out, /precheck ids: ok/);
  const decoy = bin(p.dir, ['verify', '--precheck', '--base=main', '--ticket=D']);
  assert.equal(decoy.status, 1, decoy.out);
  assert.match(decoy.out, /precheck ids: FAIL/);
});
