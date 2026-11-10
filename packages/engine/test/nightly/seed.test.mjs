// T-4, T-5 (fixSeed).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  NOW,
  line,
  fakeGit,
  GREEN_SHA,
  RED_SHA,
} from './__tests__/status-helpers.mjs';
import { fixSeed, statusLines } from './__tests__/bound.mjs';

test('T-4 fixSeed lists merges since the last green sha with suspects first (fake git)', () => {
  const merges = [
    { sha: 'm1', subject: 'docs only', files: ['docs/x.md'] },
    {
      sha: 'm2',
      subject: 'touches the red spec',
      files: ['packages/core/a.ts', 'apps/web/e2e/auth.spec.ts'],
    },
    { sha: 'm3', subject: 'core only', files: ['packages/core/b.ts'] },
    {
      sha: 'm4',
      subject: 'playwright config',
      files: ['apps/web/playwright.config.ts'],
    },
    {
      sha: 'm5',
      subject: 'e2e helper',
      files: ['apps/web/e2e/fixtures/seed-copy.ts'],
    },
  ];
  const calls = [];
  const seed = fixSeed({
    latest: {
      ...line({
        sha: RED_SHA,
        status: 'red',
        reason: 'failed',
        redSpecs: ['auth.spec.ts'],
      }),
      redTests: [
        { file: 'auth.spec.ts', title: 't', project: 'chromium', error: 'e' },
      ],
    },
    history: [line({ sha: GREEN_SHA, status: 'green' })],
    git: fakeGit(merges, { onCall: (a) => calls.push(a) }),
  });
  assert.equal(seed.lastGreenSha, GREEN_SHA);
  assert.deepEqual(seed.redSpecs, ['auth.spec.ts']);
  assert.equal(seed.redTests.length, 1);
  assert.deepEqual(
    seed.merges.map((m) => [m.sha, m.suspect]),
    [
      ['m2', true],
      ['m4', true],
      ['m5', true],
      ['m1', false],
      ['m3', false],
    ],
  );
  assert.equal(seed.merges[0].subject, 'touches the red spec');
  const log = calls.find((a) => a.includes('log'));
  assert.ok(log.includes('--first-parent') && log.includes('--merges'));
  assert.ok(log.includes(`${GREEN_SHA}..${RED_SHA}`), log.join(' '));
});

test('T-5 fixSeed with no green on record lists the newest 20 merges and says so', () => {
  const merges = Array.from({ length: 25 }, (_, i) => ({
    sha: `n${i}`,
    subject: `merge ${i}`,
    files: ['packages/core/x.ts'],
  }));
  const latest = line({
    sha: RED_SHA,
    status: 'red',
    reason: 'failed',
    redSpecs: ['auth.spec.ts'],
  });
  const input = {
    latest: { ...latest, redTests: [] },
    history: [line({ status: 'red', reason: 'failed' })],
    git: fakeGit(merges),
  };
  const seed = fixSeed(input);
  assert.equal(seed.lastGreenSha, null);
  assert.equal(seed.merges.length, 20);
  assert.deepEqual(
    seed.merges.map((m) => m.sha),
    merges.slice(0, 20).map((m) => m.sha),
  );
  const lines = statusLines(
    { latest: input.latest, history: input.history, queued: 0 },
    NOW,
    input.git,
  );
  assert.ok(
    lines.some((l) => /no green/i.test(l)),
    lines.join('\n'),
  );
});
