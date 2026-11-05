// Spawns the engine bin in throwaway git projects whose gate.config.mjs sets (or omits) `mutations`.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CONFIG_URL,
  GUARD,
  PACK_URL,
  bin,
  entries,
  gateProject,
} from './__tests__/gate-project.mjs';

const configWith = (mutations, extra = '') =>
  `import { defineGate } from ${JSON.stringify(CONFIG_URL)};\n${extra}export default defineGate({ steps: [], ${mutations} });\n`;

test('SP-1 no packs, mutations.dir: mutate --registry --all kills the biting entry, reports the survivor, exit 1, tree byte-identical, receipt at .turbo/mutation-registry.json; mutations check exits 0', () => {
  const registry = {
    'T/M1': entries['T/M1'],
    'T/M2': entries['T/M2'],
  };
  const { dir, git } = gateProject({
    config: configWith("mutations: { dir: 'mutation-registry' }"),
    registry,
  });
  const before = git('status', '--porcelain').toString();
  const run = bin(dir, ['mutate', '--registry', '--all']);
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /T\/M1 killed/);
  assert.match(run.out, /T\/M2 survived/);
  assert.match(run.out, /mutate:check registry: 1\/2 killed, 1 survived/);
  assert.equal(readFileSync(join(dir, 'src/guard.mjs'), 'utf8'), GUARD);
  assert.equal(git('status', '--porcelain').toString(), before);
  const receipt = JSON.parse(
    readFileSync(join(dir, '.turbo/mutation-registry.json'), 'utf8'),
  );
  assert.equal(receipt.ok, false);
  assert.deepEqual(receipt.keys, ['T/M1', 'T/M2']);

  const check = bin(dir, ['mutations', 'check']);
  assert.equal(check.status, 0, check.out);
  assert.match(check.out, /check:mutations: 2 entries \(2 live, 0 retired\)/);
});

test('SP-2 --defer runs as --defer-playwright', () => {
  const { dir } = gateProject({ config: configWith('mutations: {}') });
  const r = bin(dir, ['mutate', '--registry', '--all', '--defer']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /--defer-playwright needs --changed/);
});

test('SP-3 a gate without mutations: mutate and mutations check exit 2 with the not-configured line', () => {
  const { dir } = gateProject({ config: configWith('') });
  for (const [args, cmd] of [
    [['mutate', '--registry', '--all'], 'mutate'],
    [['mutations', 'check'], 'mutations check'],
    [['mutations', 'select'], 'mutations select'],
  ]) {
    const r = bin(dir, args);
    assert.equal(r.status, 2, r.out);
    assert.match(
      r.out,
      new RegExp(
        `${cmd}: mutations is not configured; set mutations in gate.config.mjs`,
      ),
    );
  }
});

test('PH-3 a patch entry claimed by two harnesses: mutations check exits 2 naming both, no test ran', () => {
  const marker = 'ran.txt';
  const registry = {
    'T/M1': {
      ...entries['T/M1'],
      test: `node -e "require('fs').writeFileSync('${marker}','x')"`,
    },
  };
  const harness = (name) =>
    `{ name: ${JSON.stringify(name)}, claims: () => true }`;
  const config = configWith(
    `mutations: {}, packs: [{ name: 'one', version: '1', mutationHarnesses: [${harness('h1')}] }, { name: 'two', version: '1', mutationHarnesses: [${harness('h2')}] }]`,
  );
  const { dir } = gateProject({ config, registry });
  for (const args of [
    ['mutations', 'check'],
    ['mutate', '--registry', '--all'],
  ]) {
    const r = bin(dir, args);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /T\/M1 is claimed by both h1 and h2/);
    assert.equal(existsSync(join(dir, marker)), false, args.join(' '));
  }
});

test('SP-4 a scratch gate.config.mjs that builds supabaseNext({ mutations }) loads and mutations check exits 0', () => {
  const config = `import { defineGate } from ${JSON.stringify(CONFIG_URL)};
import { supabaseNext } from ${JSON.stringify(PACK_URL)};
const pack = supabaseNext({
  tools: {},
  mutations: {
    port: 3000,
    env: {},
    build: 'true',
    start: 'true',
    skipBuild: 'e2e/',
    claims: /playwright test/,
    defer: { label: 'Playwright-backed', to: 'the nightly' },
  },
});
export default defineGate({ steps: [], mutations: {}, packs: [pack] });
`;
  const { dir } = gateProject({ config });
  const r = bin(dir, ['mutations', 'check']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /check:mutations: 2 entries/);
});
