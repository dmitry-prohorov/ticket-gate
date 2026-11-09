// T-6, T-7 (CLI), drift lines (status rendering).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  H,
  NOW,
  iso,
  line,
  SPEC,
  fakeGit,
  cliRepo,
  cli,
  nightlyDir,
} from './__tests__/status-helpers.mjs';
import { statusLines } from './__tests__/bound.mjs';
import { moveToCi } from '../../nightly/status.mjs';

test('T-6 statusLines prints move-to-ci 1 (max wall, busy nights) and move-to-ci 2 (n/a with no gate e2e runs, queued)', () => {
  const day = (d) => new Date(2026, 0, d, 12, 0, 0).getTime();
  const history = [
    line({ ranAt: iso(day(10)), ms: 5 * H }),
    line({ ranAt: iso(day(11)), ms: 2 * H }),
    line({
      ranAt: iso(day(12)),
      status: 'skipped-busy',
      reachedPlaywright: false,
      stats: null,
      ms: 0,
    }),
    line({
      ranAt: iso(day(13)),
      status: 'skipped-busy',
      reachedPlaywright: false,
      stats: null,
      ms: 0,
    }),
    line({ ranAt: iso(day(14)), status: 'green', ms: 3 * H }),
  ];
  const latest = { ...history.at(-1), redTests: [] };
  const lines = statusLines({ latest, history, queued: 4 }, NOW, fakeGit([]));
  assert.match(lines[0], /green/i, 'line 0 is the one-line status');
  const one = lines.find((l) => /move-to-ci 1:/.test(l));
  assert.ok(one, lines.join('\n'));
  assert.match(one, /5(\.0)?\s?h|300\s?min|18,?000/, 'max wall of 5 h');
  assert.match(one, /\b2\b/, '2 busy nights');
  const two = lines.find((l) => /move-to-ci 2:/.test(l));
  assert.ok(two, lines.join('\n'));
  assert.match(two, /n\/a \(no gate e2e runs in 14 days\)/);
  assert.match(two, /\b4\b/, 'the queued count');

  const redLines = statusLines(
    {
      latest: {
        ...line({
          status: 'red',
          reason: 'failed',
          redSpecs: ['auth.spec.ts'],
        }),
        redTests: [],
      },
      history,
      queued: 0,
    },
    NOW,
    fakeGit([]),
  );
  assert.match(redLines[0], /red/i);
  assert.match(redLines[0], /auth\.spec\.ts/);
});

test('T-6 moveToCi: trigger 1 above 4 h or 2 busy nights in 7 days; trigger 2 at 3 queued; forcedShare null', () => {
  const day = (d, h = 12) => new Date(2026, 0, d, h, 0, 0).getTime();
  const wall = (d, ms) => line({ ranAt: iso(day(d)), ms });
  const busy = (d, over = {}) =>
    line({
      ranAt: iso(day(d)),
      status: 'skipped-busy',
      reachedPlaywright: false,
      stats: null,
      ms: 0,
      ...over,
    });

  const long = moveToCi({
    history: [wall(10, 5 * H), wall(11, 2 * H)],
    nowMs: NOW,
    queued: 2,
  });
  assert.equal(long.t1.maxWallMs, 5 * H);
  assert.equal(long.t1.busyNights, 0);
  assert.equal(long.t1.met, true);
  assert.equal(long.t2.forcedShare, null);
  assert.equal(long.t2.queued, 2);
  assert.equal(long.t2.met, false);

  const short = moveToCi({
    history: [wall(10, 3 * H), busy(12)],
    nowMs: NOW,
    queued: 3,
  });
  assert.equal(short.t1.maxWallMs, 3 * H);
  assert.equal(short.t1.busyNights, 1);
  assert.equal(short.t1.met, false);
  assert.equal(short.t2.met, true);

  // two busy lines on one date are one night; a cut-short reason is a busy night
  const nights = moveToCi({
    history: [
      busy(12),
      busy(12, { ranAt: iso(day(12, 13)) }),
      line({
        ranAt: iso(day(13)),
        status: 'error',
        reason: 'cut-short',
        reachedPlaywright: false,
        stats: null,
      }),
    ],
    nowMs: NOW,
    queued: 0,
  });
  assert.equal(nights.t1.busyNights, 2);
  assert.equal(nights.t1.met, true);

  // older than 7 days is ignored
  const stale = moveToCi({
    history: [wall(2, 9 * H), busy(3), busy(4)],
    nowMs: NOW,
    queued: 0,
  });
  assert.ok(!stale.t1.maxWallMs, 'no run inside the 7 days');
  assert.equal(stale.t1.busyNights, 0);
  assert.equal(stale.t1.met, false);
});

test('T-7 the CLI exits 0 green, 0 amber, 1 red, 3 error and 3 with no runs', () => {
  const repo = cliRepo();
  const green = cli(repo, nightlyDir(repo, {}));
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /green/i);
  assert.match(green.stdout, /move-to-ci 1:/);
  assert.match(green.stdout, /move-to-ci 2:/);

  const amber = cli(
    repo,
    nightlyDir(repo, {
      status: 'amber',
      stats: { expected: 3, unexpected: 0, flaky: 1, skipped: 1 },
      flakySpecs: [SPEC],
    }),
  );
  assert.equal(amber.status, 0, amber.stderr);
  assert.match(amber.stdout, /amber/i);

  const red = cli(
    repo,
    nightlyDir(repo, {
      status: 'red',
      reason: 'failed',
      stats: { expected: 4, unexpected: 1, flaky: 0, skipped: 1 },
      redSpecs: ['auth.spec.ts'],
      redTests: [
        { file: 'auth.spec.ts', title: 't', project: 'chromium', error: 'e' },
      ],
    }),
  );
  assert.equal(red.status, 1, red.stderr);
  assert.match(red.stdout, /red/i);
  assert.match(red.stdout, /auth\.spec\.ts/);

  const err = cli(
    repo,
    nightlyDir(repo, {
      status: 'error',
      reason: 'docker-down',
      reachedPlaywright: false,
      stats: null,
    }),
  );
  assert.equal(err.status, 3, err.stderr);
  assert.match(err.stdout, /docker-down/);

  const none = cli(repo, nightlyDir(repo, null));
  assert.equal(none.status, 3, none.stderr);

  const usage = cli(repo, nightlyDir(repo, {}), '--bogus');
  assert.equal(usage.status, 2, usage.stderr);
});

test('drift on latest prints one "drift:" line per entry; absent drift prints none', () => {
  const drift = [
    { file: 'calendar.spec.ts', pathname: '/timetable', area: 'timetable' },
    { file: 'family.spec.ts', pathname: '/invite/abc', area: 'invite' },
  ];
  const latest = {
    status: 'red',
    reason: 'map-drift',
    sha: 'a'.repeat(40),
    ranAt: iso(NOW),
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    redSpecs: ['calendar.spec.ts', 'family.spec.ts'],
    flakySpecs: [],
    redTests: [],
    drift,
  };
  const git = () => '';
  const lines = statusLines({ latest, history: [], queued: 0 }, NOW, git);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('  drift:')),
    [
      '  drift: calendar.spec.ts visited /timetable (timetable) not in its header',
      '  drift: family.spec.ts visited /invite/abc (invite) not in its header',
    ],
  );
  const clean = statusLines(
    { latest: { ...latest, drift: undefined }, history: [], queued: 0 },
    NOW,
    git,
  );
  assert.equal(clean.filter((l) => l.includes('drift:')).length, 0);
});

// The mutation phase on the status output.
