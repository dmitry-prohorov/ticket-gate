// INFRA-46: the Salesforce gate config of agent-gate-extraction.md 4.8, loaded through the
// engine as-is (planFor, humanLinesFor), against a stub pack. The engine is not edited;
// every assertion reads what the landed planner and review map expose.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { enterScratchProject } from './scratch-project.mjs';

// plan.mjs and review-map.mjs load gate.config.mjs from the cwd at import: give them a scratch
// project so this file runs in any checkout of the engine.
enterScratchProject();
const { planFor } = await import('../plan.mjs');
const { humanLinesFor } = await import('../review-map.mjs');

register('./fixtures/salesforce/resolve-hooks.mjs', import.meta.url);
const { default: config } =
  await import('./fixtures/salesforce/gate.config.mjs');

const C = 'force-app/main/default/classes/Foo.cls';
const O =
  'force-app/main/default/objects/Account/fields/Tier__c.field-meta.xml';
const F = 'force-app/main/default/flows/Onboard.flow-meta.xml';
const FLOW_LINE =
  'open in Flow Builder on the scratch org: sf org open -o gate';

const plan = (paths) =>
  planFor(config, paths, { fresh: true, base: 'HEAD', exists: () => true });
const ids = (p) => p.steps.map((s) => s.id);
const stepOf = (p, id) => p.steps.find((s) => s.id === id);

test('INFRA-46 46-1 the 4.8 config loads through defineGate', () => {
  assert.deepEqual(
    config.steps.map((s) => s.id),
    [
      'deps',
      'code-analyzer',
      'lwc-jest',
      'bundle-vitest',
      'check',
      'deploy',
      'apex',
      'flow-tests',
      'agent-tests',
    ],
  );
  assert.equal(config.stacks.org.reset, undefined);
});

test('INFRA-46 46-2 classes/Foo.cls plans apex with unit FooTest', () => {
  const p = plan([C]);
  const apex = stepOf(p, 'apex');
  assert.ok(apex, `apex not planned: ${ids(p)}`);
  assert.equal(apex.selection.mode, 'affected');
  assert.deepEqual(
    apex.selection.units.map((u) => u.id),
    ['FooTest'],
  );
  assert.match(apex.cmd, /--tests FooTest\b/);
  for (const id of ['lwc-jest', 'bundle-vitest', 'flow-tests', 'agent-tests'])
    assert.ok(!ids(p).includes(id), `${id} must not be planned for a class`);
});

test('INFRA-46 46-3 objects/ plans apex full', () => {
  const apex = stepOf(plan([O]), 'apex');
  assert.ok(apex, 'apex not planned for an object field');
  assert.equal(apex.selection.mode, 'full');
  assert.match(apex.cmd, /RunLocalTests/);
  assert.doesNotMatch(apex.cmd, /--tests/);
});

test('INFRA-46 46-4 flows/ adds the Flow Builder human line', () => {
  assert.deepEqual(humanLinesFor(config.reviewMap.humanLines, [F]), [
    FLOW_LINE,
  ]);
  assert.ok(ids(plan([F])).includes('flow-tests'));
  assert.deepEqual(humanLinesFor(config.reviewMap.humanLines, [C]), []);
});

const FIXTURE_DIR = join(
  fileURLToPath(import.meta.url),
  '..',
  'fixtures',
  'salesforce',
);
const FORBIDDEN_IMPORT =
  /(?:from|import)\s*\(?\s*['"](?:node:)?(?:child_process|http|https|net|dgram|worker_threads)['"]|['"]undici['"]/;

test('INFRA-46 46-5 the stub pack makes no sf or network call', async () => {
  for (const f of readdirSync(FIXTURE_DIR)) {
    const text = readFileSync(join(FIXTURE_DIR, f), 'utf8');
    assert.doesNotMatch(
      text,
      FORBIDDEN_IMPORT,
      `${f} imports a process or network module`,
    );
    assert.ok(!text.includes('fetch('), `${f} calls fetch(`);
  }
  const real = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network call from the stub pack');
  };
  try {
    const { default: again } =
      await import('./fixtures/salesforce/gate.config.mjs?runtime-check');
    for (const paths of [[C], [O], [F]])
      planFor(again, paths, { fresh: true, base: 'HEAD', exists: () => true });
  } finally {
    globalThis.fetch = real;
  }
});

test('INFRA-46 46-6 stopOnRedBefore and the org stack reach the plan', () => {
  const p = plan([C]);
  assert.ok(p.stopBefore.includes('deploy'), `stopBefore: ${p.stopBefore}`);
  const health = stepOf(p, 'org:health');
  assert.ok(health, `org:health not planned: ${ids(p)}`);
  assert.equal(health.cmd, 'sf org display -o gate --json');
  assert.ok(ids(p).indexOf('org:health') < ids(p).indexOf('deploy'));
});
