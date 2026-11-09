// NS-F1: `status` over recorded fixtures prints the recorded lines and exit codes.
// The expected.json files were captured before the seam, never from the seam under test.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { statusLines } from './__tests__/bound.mjs';
import { BIN, fakeGit, scratchProject } from './__tests__/status-helpers.mjs';
import { readNightly } from '../../nightly/record.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = scratchProject().dir;
const FIXTURES = join(HERE, '__tests__', 'fixtures', 'status');
const NOW = Date.parse('2026-01-15T12:00:00Z');
const MERGES = [
  {
    sha: 'm3'.padEnd(40, '3'),
    subject: 'Merge pull request #3 from fix/auth-e2e',
    files: ['apps/web/e2e/auth.spec.ts'],
  },
  {
    sha: 'm2'.padEnd(40, '2'),
    subject: 'Merge pull request #2 from feat/theme',
    files: ['apps/web/app/theme.css'],
  },
  {
    sha: 'm1'.padEnd(40, '1'),
    subject: 'Merge pull request #1 from chore/e2e-config',
    files: ['apps/web/playwright.config.ts'],
  },
];
const CASES = ['green', 'amber', 'red-seed', 'error', 'skipped-busy', 'none'];

test('NS-F1 status over the recorded fixtures prints BASE lines and exit codes', () => {
  assert.deepEqual(
    readdirSync(FIXTURES).sort(),
    [...CASES].sort(),
    'the six recorded cases',
  );
  for (const name of CASES) {
    const dir = join(FIXTURES, name);
    const expected = JSON.parse(
      readFileSync(join(dir, 'expected.json'), 'utf8'),
    );
    const lines = statusLines(
      { ...readNightly(dir), queued: 0 },
      NOW,
      fakeGit(MERGES),
    );
    assert.deepEqual(lines, expected.lines, `${name}: lines`);
    const cli = spawnSync(process.execPath, [BIN, 'nightly', 'status'], {
      cwd: PROJECT,
      encoding: 'utf8',
      env: { ...process.env, FP_NIGHTLY_DIR: dir, FP_STACK_LOCK_OWNER: '' },
    });
    assert.equal(cli.status, expected.exit, `${name}: exit\n${cli.stderr}`);
  }
});
