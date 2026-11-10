// DR-1..DR-6, config completeness, integer keep.reports, rotate-less runs.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { defineNightly } from '../../nightly/define.mjs';
import { retain } from '../../nightly/record.mjs';

const suite = (name, extra = {}) => ({
  name,
  runner: { run: () => ({}), statusLine: () => '' },
  limitS: 10,
  ...extra,
});
const base = () => ({
  worktree: { dir: '/x', install: ['pnpm', 'install'] },
  rotate: { command: ['pnpm', 'rotate'] },
  suites: [suite('e2e')],
});

test('DR-1 defineNightly without a worktree throws', () => {
  const { worktree: _w, ...cfg } = base();
  assert.throws(() => defineNightly(cfg), /worktree needs dir and install/);
});

test('DR-2 defineNightly with a rotate lacking command throws; no rotate is allowed and skips the rotation', () => {
  assert.throws(
    () => defineNightly({ ...base(), rotate: {} }),
    /rotate needs command/,
  );
  assert.throws(
    () => defineNightly({ ...base(), rotate: { command: [] } }),
    /rotate needs command/,
  );
  const { rotate: _r, ...cfg } = base();
  assert.doesNotThrow(() => defineNightly(cfg));
});

const dirs = (p) => readdirSync(p).sort();

test('DR-3 a non-first suite keep {reports:3} counts orphan dirs as oldest, each its own rank', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dr3-'));
  const root = join(dir, 'prof');
  const names = ['n-named', 'o1', 'o2', 'o3', 'o4', 'o5'];
  for (const n of names) mkdirSync(join(root, n), { recursive: true });
  const history = [{ suites: { prof: { report: 'prof/n-named' } } }];
  retain(dir, history, [suite('e2e'), suite('prof', { keep: { reports: 3 } })]);
  assert.deepEqual(dirs(root), ['n-named', 'o4', 'o5']);
});

test('DR-4 first suite integer keep.reports keeps the N newest history reports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dr4-'));
  const files = [
    'aaa-2026-01-01.json',
    'bbb-2026-01-02.json',
    'ccc-2026-01-03.json',
  ];
  for (const f of [...files, 'orphan-2026-01-04.json'])
    writeFileSync(join(dir, f), '{}');
  const history = files.map((report) => ({ report }));
  retain(dir, history, [suite('e2e', { keep: { reports: 2 } })]);
  assert.deepEqual(dirs(dir), ['bbb-2026-01-02.json', 'ccc-2026-01-03.json']);
});

test('DR-4b first suite rejects keep.traces; the config keep is the suite default', () => {
  assert.throws(
    () =>
      defineNightly({
        ...base(),
        suites: [suite('e2e', { keep: { traces: 2 } })],
      }),
    /first suite/,
  );
  const out = defineNightly({ ...base(), keep: { reports: 'all' } });
  assert.equal(out.suites[0].keep.reports, 'all');
});

test('DR-5 a config with no rotate records the mutation phase skipped/disabled and runs no mutate-check', async () => {
  const { world } = await import('./__tests__/world.mjs');
  const { runNightly } = await import('../../nightly/run.mjs');
  const { nightly } = await import('./__tests__/demo-nightly.mjs');
  const { rotate: _r, ...rest } = nightly;
  const entries = new Map([
    [
      'A/M1',
      {
        path: 'tools/mutation-registry/tools/x.json',
        line: 1,
        entry: {
          kind: 'patch',
          file: 'tools/A-M1.mjs',
          testFile: 'tools/A-M1.test.mjs',
        },
      },
    ],
  ]);
  const w = world({ entries });
  const r = await runNightly(w.io, { now: true, config: defineNightly(rest) });
  assert.deepEqual(
    [r.mutations.status, r.mutations.reason],
    ['skipped', 'disabled'],
  );
  assert.equal(w.mutateCalls.length, 0);
});

test('DR-6 defineNightly is idempotent with a top-level keep.traces', () => {
  const cfg = {
    ...base(),
    keep: { traces: 2 },
    suites: [suite('e2e'), suite('prof')],
  };
  const once = defineNightly(cfg);
  assert.deepEqual(defineNightly(once), once);
  assert.equal(once.suites[0].keep.traces, undefined);
  assert.equal(once.suites[1].keep.traces, 2);
});
