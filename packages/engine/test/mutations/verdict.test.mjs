// Run by `pnpm test:tools`. Function cases inject fakes (no shell, pnpm or
// stack); CLI cases spawn the script in a throwaway repo under os.tmpdir() with
// plain shell test commands, so nothing touches this repo.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exec } from '../../mutations/exec.mjs';
import { runMutations } from '../../mutations/run.mjs';
import { zeroTestRun } from '../../mutations/verdict.mjs';
import {
  ORIGINAL,
  patch,
  world,
  V_NOMATCH,
  V_NOFILE,
  V_OK,
  serveWorld,
} from './__tests__/mutate-check.helpers.mjs';

const V_SKIP_TODO = `
 ↓ skip.test.ts (2 tests | 2 skipped)

 Test Files  1 skipped (1)
      Tests  1 skipped | 1 todo (2)
`;
const V_MIXED = `
 ❯ mixed.test.ts (2 tests | 1 failed) 9ms

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
`;
const V_LOAD = `
 FAIL  load.test.ts [ load.test.ts ]
Error: Cannot find module './missing-zzz'

 Test Files  1 failed (1)
      Tests  no tests
`;
const J_SKIP = `
Test Suites: 1 passed, 1 total
Tests:       2 skipped, 2 total
Snapshots:   0 total
Ran all test suites matching /x/i with tests matching "^x 1".
`;
const J_SKIP_ONE = `
Test Suites: 1 skipped, 0 of 1 total
Tests:       1 skipped, 1 total
`;
const J_NOFILE = `
No tests found, exiting with code 1
Run with \`--passWithNoTests\` to exit with code 0
`;
const J_MIXED = `
Test Suites: 1 passed, 1 total
Tests:       1 skipped, 1 passed, 2 total
`;
const J_LOAD = `
FAIL iOS components/MemberAvatar.test.tsx
  ● Test suite failed to run

Test Suites: 1 failed, 1 total
Tests:       0 total
`;
const NODE_SUMMARY = (tests, pass, fail = 0, skipped = 0) =>
  `ℹ tests ${tests}\nℹ suites 0\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled 0\nℹ skipped ${skipped}\nℹ todo 0\nℹ duration_ms 106.2\n`;
const TAP_SUMMARY = (tests, pass, fail = 0) =>
  `1..${tests}\n# tests ${tests}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 106.2\n`;

test('ZT-1 vitest zero-test shapes', () => {
  const cmd = 'pnpm -F @demo/core exec vitest run src/domain/agenda.test.ts';
  for (const out of [V_NOMATCH, V_NOFILE, V_SKIP_TODO])
    assert.match(zeroTestRun(cmd, out) ?? '', /^vitest: /, out);
  assert.equal(zeroTestRun(cmd, V_NOFILE), 'vitest: No test files found');
  assert.equal(zeroTestRun(cmd, V_NOMATCH), 'vitest: Tests  3 skipped (3)');
  for (const out of [V_OK, V_MIXED, V_LOAD])
    assert.equal(zeroTestRun(cmd, out), null, out);
});

test('ZT-2 jest zero-test shapes', () => {
  const cmd = 'pnpm -F @demo/mobile exec jest components/MemberAvatar.test.tsx';
  for (const out of [J_SKIP, J_SKIP_ONE, J_NOFILE])
    assert.match(zeroTestRun(cmd, out) ?? '', /^jest: /, out);
  assert.equal(zeroTestRun(cmd, J_NOFILE), 'jest: No tests found');
  assert.equal(
    zeroTestRun(cmd, J_SKIP),
    'jest: Tests:       2 skipped, 2 total',
  );
  for (const out of [J_MIXED, J_LOAD])
    assert.equal(zeroTestRun(cmd, out), null, out);
});

test('ZT-3 node --test zero-test shapes', () => {
  const one = 'node --test --test-name-pattern=zzz tools/tree-hash.test.mjs';
  const two = "node --test 'tools/a.test.mjs' tools/b.test.mjs";
  const spec1 = `✔ tools/tree-hash.test.mjs (96.6ms)\n${NODE_SUMMARY(1, 1)}`;
  const spec2 = `✔ tools/a.test.mjs (9ms)\n✔ tools/b.test.mjs (9ms)\n${NODE_SUMMARY(2, 2)}`;
  const tap1 = `ok 1 - tools/tree-hash.test.mjs\n${TAP_SUMMARY(1, 1)}`;
  const zeroTests = NODE_SUMMARY(0, 0);
  const skipped = `﹣ x (0.1ms) # SKIP\n${NODE_SUMMARY(1, 0, 0, 1)}`;
  assert.match(zeroTestRun(one, spec1) ?? '', /^node --test: tests 1$/);
  assert.match(zeroTestRun(two, spec2) ?? '', /^node --test: /);
  assert.match(zeroTestRun(one, tap1) ?? '', /^node --test: /);
  assert.match(zeroTestRun(one, zeroTests) ?? '', /^node --test: tests 0$/);
  assert.match(zeroTestRun(one, skipped) ?? '', /^node --test: /);
  const real = `✔ TH-3 a commit touching only docs (286ms)\n${NODE_SUMMARY(1, 1)}`;
  assert.equal(zeroTestRun(one, real), null);
  const nested = `▶ db-schema\n  ✔ DS-2 a (1ms)\n✔ db-schema (2ms)\n${NODE_SUMMARY(2, 2)}`;
  assert.equal(zeroTestRun('node --test tools/db.test.mjs', nested), null);
  const failed = `✖ tools/tree-hash.test.mjs (9ms)\n${NODE_SUMMARY(1, 0, 1)}`;
  assert.equal(zeroTestRun(one, failed), null);
  // The same line is a real test when the command does not name that file.
  assert.equal(zeroTestRun('node --test tools/other.test.mjs', spec1), null);
});

test('ZT-4 ANSI-colored summaries parse', () => {
  const cmd = 'vitest run x';
  const colored = V_NOMATCH.replace(
    '      Tests  3 skipped (3)',
    '\x1b[2m      Tests \x1b[22m \x1b[33m3 skipped\x1b[39m\x1b[90m (3)\x1b[39m',
  );
  assert.match(zeroTestRun(cmd, colored) ?? '', /^vitest: Tests {2}3 skipped/);
  const dim = V_NOFILE.replace(
    'No test files found, exiting with code 1',
    '\x1b[2mNo test files found, exiting with code 1\x1b[22m',
  );
  assert.equal(zeroTestRun(cmd, dim), 'vitest: No test files found');
  for (const out of ['', 'ok', 'FAIL'])
    assert.equal(zeroTestRun('true', out), null, out);
});

const PW_CMD = 'pnpm -F web exec playwright test e2e/x.spec.ts -g "y"';
const PW_ANSI = (t) => `\x1b[31m${t}\x1b[39m`;

test('MC-Z1 playwright "No tests found" is a zero-test run', () => {
  const body = (e) => `\n${e}\nNo tests found.\n`;
  for (const e of ['Error: No tests found', 'Error: No tests found.'])
    assert.equal(zeroTestRun(PW_CMD, body(e)), 'playwright: No tests found', e);
  assert.equal(
    zeroTestRun(PW_CMD, body(PW_ANSI('Error: No tests found.'))),
    'playwright: No tests found',
  );
});

test('MC-Z2 playwright webServer failures are a zero-test run', () => {
  for (const out of [
    'Error: Process from config.webServer was not able to start. Exit code: 1',
    'Error: Process from config.webServer exited early.',
    'Error: Timed out waiting 120000ms from config.webServer.',
  ])
    assert.equal(
      zeroTestRun(PW_CMD, out),
      'playwright: webServer did not start',
      out,
    );
});

test('MC-Z3 playwright skip-only summaries are zero', () => {
  assert.equal(zeroTestRun(PW_CMD, '\n  2 skipped\n'), 'playwright: 2 skipped');
  assert.equal(
    zeroTestRun(PW_CMD, '\n  1 did not run\n'),
    'playwright: 1 did not run',
  );
  assert.match(
    zeroTestRun(PW_CMD, '\n  2 skipped\n  1 did not run\n') ?? '',
    /^playwright: 2 skipped, 1 did not run$/,
  );
});

test('MC-Z4 playwright runs that ran something are not zero', () => {
  for (const out of [
    '\n  1 passed (3.2s)\n',
    '\n  1 failed\n',
    '\n  1 flaky\n',
    '\n  1 interrupted\n',
    '\n  1 skipped\n  1 passed (3.2s)\n',
  ])
    assert.equal(zeroTestRun(PW_CMD, out), null, out);
});

test('MC-Z6 a failed test followed by skipped is not zero-test', () => {
  assert.equal(
    zeroTestRun(PW_CMD, '  1 failed\n    [chromium] x\n  4 skipped'),
    null,
  );
});

test('MC-Z5 a webServer failure under the mutation is error, not killed', async () => {
  const w = serveWorld((cmd, wd) =>
    wd.file === ORIGINAL
      ? { code: 0, out: '\n  1 passed (3.2s)\n' }
      : {
          code: 1,
          out: 'Error: Process from config.webServer was not able to start. Exit code: 1',
        },
  );
  const r = await runMutations(
    { mutations: [patch('M1', { test: PW_CMD })] },
    w.io,
  );
  assert.equal(r.results[0].status, 'error');
  assert.match(r.results[0].detail, /webServer did not start/);
});

// A fake world with the build-once io: counts builds, starts and stops.
