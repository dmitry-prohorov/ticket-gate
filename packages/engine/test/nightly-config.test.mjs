// NC-1..NC-5: the `nightly` key of gate.config.mjs: validation, pack payloads, the gate readers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { enterScratchProject } from './scratch-project.mjs';

// The scratch project is a git repo, so the nightly dir is <project>/.turbo/nightly.
enterScratchProject();
execFileSync('git', ['init', '-q'], { cwd: process.cwd() });
const { defineGate, GATE_KEYS, step } = await import('../config.mjs');
const { ENGINE_COMMANDS } = await import('../commands-config.mjs');
const { nightlyLine, nightlyRecord } = await import('../nightly/gate.mjs');
const { nightlyDir, readNightly } = await import('../nightly/record.mjs');
const { statusLines } = await import('../nightly/status.mjs');

const suite = { name: 'web', runner: { run: async () => ({}) }, limitS: 60 };
const NIGHTLY = { suites: [suite], worktree: { dir: 'wt', install: ['node', '-e', '0'] } };
const payload = (name) => ({ name, preflight: async () => ({ ok: true }) });
const gate = (nightly, packs = []) =>
  defineGate({
    steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })],
    nightly,
    packs,
  });
const pack = (name, payloads) => ({ name, version: '0.0.0', nightlyPayloads: payloads });

test('NC-1 defineGate fills the nightly defaults and lists config payloads then each pack\'s nightlyPayloads in packs order', () => {
  const g = gate({ ...NIGHTLY, payloads: [payload('own')] }, [
    pack('pack-a', [payload('a1'), payload('a2')]),
    { name: 'pack-none', version: '0.0.0' },
    pack('pack-b', [payload('b1')]),
  ]);
  assert.equal(g.nightly.commands.status, 'ticket-gate nightly status');
  assert.equal(g.nightly.commands.run, 'ticket-gate nightly run');
  assert.deepEqual(g.nightly.window, { start: '00:50', end: '06:00', catchUpBy: '00:30' });
  assert.deepEqual(g.nightly.payloads.map((p) => p.name), ['own', 'a1', 'a2', 'b1']);
  assert.equal(gate(undefined).nightly, undefined);
  assert.equal(
    defineGate({ steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })] }).nightly,
    undefined,
  );
});

test('NC-2 one payload name from gate.config and a pack is a config error naming both', () => {
  assert.throws(
    () => gate({ ...NIGHTLY, payloads: [payload('x')] }, [pack('pack-a', [payload('x')])]),
    /gate\.config: nightly: payload "x" is given by gate\.config and pack-a$/,
  );
  assert.throws(
    () => gate(NIGHTLY, [pack('pack-a', [payload('x')]), pack('pack-b', [payload('x')])]),
    /payload "x" is given by pack-a and pack-b/,
  );
});

test('NC-3 a nightly the runner cannot honour fails load as gate.config: nightly: <reason>', () => {
  assert.throws(
    () => gate({ ...NIGHTLY, suites: [] }),
    /^Error: gate\.config: nightly: suites must list at least one suite$/,
  );
  assert.throws(() => gate('nope'), /gate\.config: nightly: must be an object/);
  assert.throws(() => gate([NIGHTLY]), /gate\.config: nightly: must be an object/);
  assert.throws(
    () => gate(NIGHTLY, [pack('pack-a', [{ preflight: async () => ({}) }])]),
    /gate\.config: nightly: payload from pack-a must be an object with a string name/,
  );
  assert.throws(
    () => gate({ ...NIGHTLY, payloads: [{ name: '' }] }),
    /gate\.config: nightly: payload from gate\.config must be an object with a string name/,
  );
});

test('NC-4 nightly is a known gate key and ENGINE_COMMANDS lists nightly', () => {
  assert.ok(GATE_KEYS.includes('nightly'));
  assert.ok(ENGINE_COMMANDS.includes('nightly'));
});

test('NC-5 nightlyLine and nightlyRecord read the gate\'s nightly dir only when the gate has nightly', () => {
  const NOW = Date.parse('2026-01-15T12:00:00Z');
  const sha = 'c'.repeat(40);
  const rec = {
    sha,
    status: 'green',
    reason: null,
    reachedPlaywright: true,
    ranAt: new Date(NOW - 3_600_000).toISOString(),
    endedAt: new Date(NOW - 1_800_000).toISOString(),
    stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 0 },
    redSpecs: [],
    flakySpecs: [],
    redTests: [],
  };
  mkdirSync(nightlyDir(), { recursive: true });
  writeFileSync(join(nightlyDir(), 'latest.json'), JSON.stringify(rec));
  writeFileSync(join(nightlyDir(), 'history.jsonl'), `${JSON.stringify(rec)}\n`);

  const g = gate(NIGHTLY);
  const want = statusLines({ ...readNightly(nightlyDir()), queued: 0 }, NOW, undefined, undefined, g.nightly)[0];
  assert.match(want, new RegExp(`green ${sha.slice(0, 12)}`));
  assert.equal(nightlyLine(g, NOW), want);
  assert.equal(nightlyRecord(g).latest.sha, sha);

  const bare = defineGate({ steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })] });
  assert.equal(nightlyLine(bare, NOW), null);
  assert.equal(nightlyRecord(bare), null);
  assert.equal(nightlyLine(undefined, NOW), null);
});
