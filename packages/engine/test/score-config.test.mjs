// The `score` key of defineGate: validation, defaults and freezing. Synthetic values only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defineGate } from '../config.mjs';
import { stryker } from '../score/adapters/stryker.mjs';
import { NEW_FILE_MIN, SCORE_DEFAULTS } from '../score-config.mjs';

const adapter = stryker({
  branchCmd: ['npx', 'stryker', 'run'],
  packageDir: 'pkg',
  config: 'stryker.config.mjs',
  reportPath: '.turbo/mutation/report.json',
});
const good = (over = {}) => ({
  scope: /^pkg\/src\//,
  packageDir: 'pkg',
  adapter,
  baseInstall: {
    cmd: 'npm',
    args: ['ci'],
    label: 'npm ci',
    hint: 'npm ci',
    marker: '.install-done',
  },
  ...over,
});
const throws = (score, re) =>
  assert.throws(() => defineGate({ score }), re);

test('GS-1 defineGate rejects a score without an adapter', () => {
  const { adapter: _drop, ...rest } = good();
  throws(rest, /gate\.config: score\.adapter: needs a string name/);
});

test('GS-2 an unknown score key throws naming it', () => {
  throws(good({ scoreFloor: 1 }), /gate\.config: score\.scoreFloor: unknown key/);
});

test('GS-3 an adapter missing runBase throws', () => {
  const { runBase: _drop, ...partial } = adapter;
  throws(good({ adapter: partial }), /gate\.config: score\.adapter: .*runBase/);
});

test('GS-4 a global or sticky scope regex throws', () => {
  throws(good({ scope: /^pkg\//g }), /gate\.config: score\.scope: .*g or y/);
  throws(good({ scope: /^pkg\//y }), /gate\.config: score\.scope: .*g or y/);
  throws(good({ excluded: /x/g }), /gate\.config: score\.excluded/);
  throws(good({ scope: 'pkg/' }), /gate\.config: score\.scope/);
});

test('GS-5 defaults are filled and given values kept; the gate\'s score is frozen', () => {
  const gate = defineGate({ score: good() });
  const s = gate.score;
  assert.equal(s.newFileMin, 80);
  assert.equal(s.newFileMin, NEW_FILE_MIN);
  assert.deepEqual(s.extra, []);
  assert.equal(s.commands.score, 'ticket-gate score');
  assert.equal(s.noTargets, 'no file in the score scope changed');
  assert.equal(s.survivors, '.turbo/mutation-survivors.md');
  assert.equal(s.worktreeDir, SCORE_DEFAULTS.worktreeDir);
  assert.equal(s.excluded.test('anything'), false);
  const given = defineGate({
    score: good({
      newFileMin: 90,
      extra: ['pkg/a.ts'],
      noTargets: 'nothing',
      commands: { score: 'run score' },
    }),
  }).score;
  assert.equal(given.newFileMin, 90);
  assert.deepEqual(given.extra, ['pkg/a.ts']);
  assert.equal(given.noTargets, 'nothing');
  assert.equal(given.commands.score, 'run score');
  assert.ok(Object.isFrozen(s));
  assert.ok(Object.isFrozen(s.commands));
  assert.equal('score' in defineGate({}), false);
});

test('GS-6 packageDir "", "/abs" and "../x"; a baseInstall without marker; a two-segment worktreeDir each throw', () => {
  for (const packageDir of ['', '/abs', '../x', 'a/../b', 'lib/', 'a//b', undefined])
    throws(good({ packageDir }), /gate\.config: score\.packageDir/);
  const { marker: _drop, ...noMarker } = good().baseInstall;
  throws(good({ baseInstall: noMarker }), /gate\.config: score\.baseInstall/);
  throws(
    good({ baseInstall: { ...good().baseInstall, marker: 'a/b' } }),
    /gate\.config: score\.baseInstall/,
  );
  throws(good({ worktreeDir: 'a/b' }), /gate\.config: score\.worktreeDir/);
  throws(good({ newFileMin: 101 }), /gate\.config: score\.newFileMin/);
  throws(good({ noTargets: 'a\nb' }), /gate\.config: score\.noTargets/);
  throws(good({ commands: { score: '' } }), /gate\.config: score\.commands\.score/);
  throws(good({ survivors: '/abs/x' }), /gate\.config: score\.survivors/);
});

test('GS-7 packageDir "." is accepted for a package at the repo root', () => {
  assert.equal(defineGate({ score: good({ packageDir: '.' }) }).score.packageDir, '.');
});
