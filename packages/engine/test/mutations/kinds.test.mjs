// INFRA-57 KS-1..KS-4 (contracts/INFRA-57.md section 5): the setup a project
// hands the engine. Each test builds its own setup from section 2 names only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { patch, world } from './__tests__/mutate-check.helpers.mjs';
import { localHarness, sessionOf } from '../../mutations/harness.mjs';
import { ENGINE_DEFAULTS, resolveSetup } from '../../mutations/kinds.mjs';
import { runMutations } from '../../mutations/run.mjs';
import { zeroTestRun } from '../../mutations/verdict.mjs';

const kind = (name) => ({
  name,
  runs: false,
  fields: [],
  shape: () => [],
});
const pack = (name, kinds = {}, harnesses = []) => ({
  name,
  mutationKinds: kinds,
  mutationHarnesses: harnesses,
});

test('KS-1 two packs naming one kind is a config error naming both', () => {
  const x = kind('x');
  assert.throws(
    () => resolveSetup({ packs: [pack('a', { x }), pack('b', { x })] }),
    (e) => e.message === 'mutations config: kind "x" is named by both a and b',
  );
  // The engine's own `patch` kind counts as a namer.
  assert.throws(
    () => resolveSetup({ packs: [pack('a', { patch: kind('patch') })] }),
    (e) =>
      e.message ===
      'mutations config: kind "patch" is named by both engine and a',
  );
  // config.kinds is checked against the packs too.
  assert.throws(
    () => resolveSetup({ kinds: { x }, packs: [pack('a', { x })] }),
    (e) =>
      e.message === 'mutations config: kind "x" is named by both a and config',
  );
  // Control: distinct names resolve, in order engine, packs, config.
  const ok = resolveSetup({
    kinds: { z: kind('z') },
    packs: [pack('a', { x }), pack('b', { y: kind('y') })],
  });
  assert.deepEqual([...ok.kinds.keys()], ['patch', 'x', 'y', 'z']);
});

test('KS-2 a patch entry claimed by two harnesses is a config error naming both', async () => {
  const inline = (name, claims) => ({
    name,
    order: 1,
    inline: true,
    claims,
    runOne: async (m) => ({ id: m.id, status: 'killed', detail: '' }),
  });
  const setupOf = (...hs) => resolveSetup({ packs: [pack('p', {}, hs)] });
  const w = world();
  const calls = [];
  for (const k of Object.keys(w.io)) {
    const f = w.io[k];
    w.io[k] = (...a) => (calls.push(k), f(...a));
  }
  const both = setupOf(
    inline('h1', () => true),
    inline('h2', () => true),
  );
  await assert.rejects(
    runMutations({ mutations: [patch('M1')] }, w.io, both),
    (e) => e.message === 'mutations config: M1 is claimed by both h1 and h2',
  );
  assert.deepEqual(calls, [], 'no io call may happen before the claim check');
  assert.deepEqual(w.log, []);
  assert.throws(
    () => sessionOf(patch('M1'), both),
    /M1 is claimed by both h1 and h2/,
  );

  // Control: one claimant runs the entry through that harness.
  const one = setupOf(
    inline('h1', () => true),
    inline('h2', () => false),
  );
  const r = await runMutations({ mutations: [patch('M1')] }, w.io, one);
  assert.equal(r.results[0].status, 'killed');
});

test('KS-3 a harness zeroTests parser turns a 0 tests ran baseline into error', async () => {
  const p = (_cmd, out) =>
    /0 tests ran/.test(out) ? 'fake: 0 tests ran' : null;
  assert.equal(zeroTestRun('fake x', '0 tests ran', [p]), 'fake: 0 tests ran');
  assert.equal(zeroTestRun('fake x', '0 tests ran'), null);
  assert.equal(zeroTestRun('fake x', 'all fine', [p]), null);
  // A built-in reason still wins over a parser.
  assert.match(
    zeroTestRun('x', 'No test files found, exiting with code 1', [() => 'p']),
    /^vitest: /,
  );

  const grouped = [];
  const h = {
    name: 'zg',
    order: 1,
    claims: () => true,
    zeroTests: p,
    open: async () => ({
      baselines: new Map([['fake test', { code: 0, out: '0 tests ran' }]]),
    }),
    group: (entries) => entries.map((e) => ({ key: e.id, entries: [e] })),
    run: async (groups) => {
      grouped.push(...groups.flatMap((g) => g.entries.map((e) => e.id)));
      return {};
    },
    close: async () => ({}),
  };
  const w = world();
  const report = await runMutations(
    { mutations: [patch('M1')] },
    w.io,
    resolveSetup({ packs: [pack('p', {}, [h])] }),
  );
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].id, 'M1');
  assert.equal(report.results[0].status, 'error');
  assert.match(
    report.results[0].detail,
    /^ran zero tests before the mutation \(fake: 0 tests ran\)/,
  );
  assert.equal(report.ok, false);
  assert.ok(!grouped.includes('M1'), 'a zero baseline must not reach run()');
});

test('KS-4 resolveSetup with no config gives the engine defaults', () => {
  const expected = {
    dir: 'mutation-registry',
    receipts: {
      ticket: '.turbo/mutation-check.json',
      registry: '.turbo/mutation-registry.json',
    },
    rebuild: [],
    childEnv: { drop: [] },
    legacy: null,
    commands: {
      mutate: 'ticket-gate mutate',
      checkMutations: 'ticket-gate mutations check',
      checkMutationsScript: 'ticket-gate mutations check',
      afterFatal: 'restore the tree, then re-run',
      restoreHint: 'git checkout on the file',
    },
  };
  for (const source of [ENGINE_DEFAULTS, resolveSetup()]) {
    for (const [k, v] of Object.entries(expected))
      assert.deepEqual(source[k], v, `default ${k}`);
    assert.equal(
      source.area({ file: 'a/b/c.mjs' }),
      'mutation-registry/a/b.json',
    );
    assert.equal(
      source.area({ file: 'top.mjs' }),
      'mutation-registry/_root.json',
    );
  }
  const setup = resolveSetup();
  assert.deepEqual([...setup.kinds.keys()], ['patch']);
  assert.equal(setup.harnesses.at(-1), localHarness, 'localHarness is last');
  assert.equal(
    resolveSetup({
      packs: [pack('p', {}, [{ name: 'h', claims: () => false }])],
    }).harnesses.at(-1),
    localHarness,
    'localHarness stays last behind pack harnesses',
  );
});
