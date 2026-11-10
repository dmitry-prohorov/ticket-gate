// The react pack: the profile command is added only on request, and the presets and the
// config check are plain functions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { defineGate } from '../../engine/config.mjs';
import { reactPack } from '../index.mjs';
import { profile, viteProfiling } from '../profile.mjs';
import { makeProject, traces } from './profiler/__tests__/profile-project.mjs';

const configOf = async ({ lock = false, trace = traces.synthetic } = {}) => {
  const { dir } = makeProject({ lock, trace });
  return (await import(pathToFileURL(join(dir, 'profile.config.mjs')).href)).default;
};

/** Runs the command with console output captured and the exit code restored. */
async function runCommand(cfg, args) {
  const errors = [];
  const { log, table, error } = console;
  console.log = () => {};
  console.table = () => {};
  console.error = (...a) => errors.push(a.map(String).join(' '));
  const before = process.exitCode;
  try {
    const code = await reactPack({ profile: async () => cfg }).packCommands.profile(args);
    return { code, stderr: errors.join('\n') };
  } finally {
    Object.assign(console, { log, table, error });
    process.exitCode = before;
  }
}

test('PA-1 reactPack adds profile only when given a loader', () => {
  assert.deepEqual(reactPack().packCommands, {});
  assert.throws(() => reactPack({ profile: {} }), TypeError);
  assert.equal(typeof reactPack({ profile: async () => ({}) }).packCommands.profile, 'function');
  assert.doesNotThrow(() =>
    defineGate({ steps: [], packs: [reactPack({ profile: async () => ({}) })] }),
  );
});

test('PA-2 the command returns 1 over budget', async () => {
  const cfg = await configOf();
  const { code } = await runCommand(cfg, ['--runs=1', '--max-renders=home:0']);
  assert.equal(code, 1);
});

test('PA-3 the command reports a thrown error and returns 1', async () => {
  const cfg = await configOf();
  const { code, stderr } = await runCommand(cfg, ['--bogus']);
  assert.equal(code, 1);
  assert.match(stderr, /usage:/);
});

test('VP-1 viteProfiling names the two commands and the preview port', () => {
  assert.deepEqual(viteProfiling({ cmd: 'b', preview: 'p' }), {
    command: 'b',
    unmangle: 'esbuild.keepNames in the Vite config',
    start: 'p',
    port: 4173,
    noBuildLabel: 'unknown (existing server on :4173)',
  });
});

test('PR-2 profile refuses a missing lock and a build without a port', async () => {
  const cfg = await configOf();
  const { lock: _lock, ...noLock } = cfg;
  assert.throws(() => profile(noLock), TypeError);
  assert.throws(() => profile({ ...cfg, lock: '' }), TypeError);
  const { port: _port, ...noPort } = cfg.build;
  assert.throws(() => profile({ ...cfg, build: noPort }), TypeError);
  assert.doesNotThrow(() => profile({ ...cfg, lock: false }));
});
