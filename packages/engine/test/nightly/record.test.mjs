// T-1, T-2, T-3, T-8, T-9, T-10 (record and classification).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fixture,
  H,
  NOW,
  iso,
  line,
  flakyLine,
  SPEC,
  flakySummary,
  cleanSummary,
} from './__tests__/status-helpers.mjs';
import { mapDrift } from './__tests__/bound.mjs';
import { classifyRun, freshness } from '../../nightly/record.mjs';
import { summarizeReport } from '../../runners/playwright.mjs';

test('T-8 summarizeReport counts tests in nested suites and both projects, and the interrupted fixture gives no stats', () => {
  assert.deepEqual(summarizeReport(fixture('green')).stats, {
    expected: 4,
    unexpected: 0,
    flaky: 0,
    skipped: 1,
  });
  assert.deepEqual(summarizeReport(fixture('amber')).stats, {
    expected: 3,
    unexpected: 0,
    flaky: 1,
    skipped: 1,
  });
  const amber = summarizeReport(fixture('amber'));
  assert.deepEqual(amber.flakySpecs, [SPEC], 'a flaky test two suites deep');
  const red = summarizeReport(fixture('red'));
  assert.deepEqual(red.stats, {
    expected: 4,
    unexpected: 1,
    flaky: 0,
    skipped: 1,
  });
  assert.deepEqual(
    red.failedSpecs,
    ['auth.spec.ts'],
    'unexpected four suites deep',
  );
  assert.equal(red.redTests.length, 1);
  assert.equal(red.redTests[0].file, 'auth.spec.ts');
  assert.match(red.redTests[0].title, /accepts the code/);
  assert.equal(red.redTests[0].project, 'chromium');
  assert.match(red.redTests[0].error, /Expected: 5/);
  assert.ok(red.redTests[0].error.length <= 2000);
  const none = summarizeReport(fixture('interrupted'));
  assert.ok(
    none === null || none.stats === null,
    'no stats for an interrupted run',
  );
});

test('T-1 classifyRun: green, amber, red and error from the fixtures', () => {
  const run = (name, history = []) =>
    classifyRun({
      summary: summarizeReport(fixture(name)),
      reason: null,
      history,
    });
  const green = run('green');
  assert.equal(green.status, 'green');
  assert.equal(green.reason, null);
  assert.deepEqual(green.redSpecs, []);
  const amber = run('amber');
  assert.equal(amber.status, 'amber');
  assert.deepEqual(amber.flakySpecs, [SPEC]);
  assert.deepEqual(amber.redSpecs, []);
  const red = run('red');
  assert.equal(red.status, 'red');
  assert.equal(red.reason, 'failed');
  assert.deepEqual(red.redSpecs, ['auth.spec.ts']);
  const err = classifyRun({
    summary: null,
    reason: 'docker-down',
    history: [],
  });
  assert.equal(err.status, 'error');
  assert.equal(err.reason, 'docker-down');
  const interrupted = classifyRun({
    summary: summarizeReport(fixture('interrupted')),
    reason: 'cut-short',
    history: [],
  });
  assert.equal(interrupted.status, 'error');
  assert.equal(interrupted.reason, 'cut-short');
});

test('T-2 a spec flaky now and in 1 of the previous 6 reached runs is red flaky-2-of-7; flaky only now stays amber; flaky twice before but not now stays green (N-R2)', () => {
  const clean = (h) => line({ ranAt: iso(NOW - h * H) });
  const six = (withFlaky) => [
    ...withFlaky,
    ...[30, 40, 50, 60, 70, 80].slice(withFlaky.length).map(clean),
  ];

  const promoted = classifyRun({
    summary: flakySummary,
    reason: null,
    history: six([flakyLine(SPEC, 26)]),
  });
  assert.equal(promoted.status, 'red');
  assert.equal(promoted.reason, 'flaky-2-of-7');
  assert.ok(promoted.redSpecs.includes(SPEC));

  const onlyNow = classifyRun({
    summary: flakySummary,
    reason: null,
    history: six([]),
  });
  assert.equal(onlyNow.status, 'amber');
  assert.deepEqual(onlyNow.redSpecs, []);

  const fixedSince = classifyRun({
    summary: cleanSummary,
    reason: null,
    history: six([flakyLine(SPEC, 26), flakyLine(SPEC, 28)]),
  });
  assert.equal(
    fixedSince.status,
    'green',
    'a fixed flake must not keep main red',
  );

  // runs that never reached Playwright do not count toward the 2
  const unreached = classifyRun({
    summary: flakySummary,
    reason: null,
    history: six([
      flakyLine(SPEC, 26, {
        reachedPlaywright: false,
        status: 'error',
        reason: 'cut-short',
      }),
    ]),
  });
  assert.equal(unreached.status, 'amber');

  // a different spec flaking before is not this spec flaking again
  const otherSpec = classifyRun({
    summary: flakySummary,
    reason: null,
    history: six([flakyLine('family.spec.ts', 26)]),
  });
  assert.equal(otherSpec.status, 'amber');

  // a real failure stays 'failed' even with flaky history
  const failing = classifyRun({
    summary: {
      stats: { expected: 3, unexpected: 1, flaky: 1, skipped: 0 },
      failedSpecs: ['auth.spec.ts'],
      flakySpecs: [SPEC],
      redTests: [],
    },
    reason: null,
    history: six([flakyLine(SPEC, 26)]),
  });
  assert.equal(failing.status, 'red');
  assert.equal(failing.reason, 'failed');
});

test('T-3 freshness skips error and skipped-busy lines and reports the newest reached run; stale past 36 h', () => {
  const reached = line({ ranAt: iso(NOW - 10 * H) });
  const history = [
    reached,
    line({
      ranAt: iso(NOW - 1 * H),
      status: 'error',
      reason: 'docker-down',
      reachedPlaywright: false,
      stats: null,
    }),
    line({
      ranAt: iso(NOW - 0.5 * H),
      status: 'skipped-busy',
      reason: null,
      reachedPlaywright: false,
      stats: null,
    }),
  ];
  const f = freshness(history, NOW);
  assert.equal(f.ranAt, reached.ranAt);
  assert.equal(f.ageMs, 10 * H);
  assert.equal(f.stale, false);

  const old = freshness([line({ ranAt: iso(NOW - 37 * H) })], NOW);
  assert.equal(old.ageMs, 37 * H);
  assert.equal(old.stale, true);
  assert.equal(
    freshness([line({ ranAt: iso(NOW - 36 * H) })], NOW).stale,
    false,
  );

  assert.equal(
    freshness([history[1], history[2]], NOW),
    null,
    'only unreached lines: no fresh run on record',
  );
  assert.equal(freshness([], NOW), null);
});

// ---- navigation recorder summary and map-drift (T-9, T-10) ----
const navTest = (file, title, status, { onTest = [], onResult = [] } = {}) => ({
  title,
  file,
  tags: [],
  tests: [
    {
      projectName: 'chromium',
      status,
      annotations: onTest.map((description) => ({
        type: 'e2e-nav',
        description,
      })),
      results: [
        {
          status: status === 'unexpected' ? 'failed' : 'passed',
          annotations: onResult.map((description) => ({
            type: 'e2e-nav',
            description,
          })),
          errors: [],
        },
      ],
    },
  ],
});
const navReport = (specs) => {
  const stats = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  for (const s of specs) for (const t of s.tests) stats[t.status] += 1;
  return {
    stats,
    suites: specs.map((s) => ({
      title: s.file,
      file: s.file,
      specs: [],
      suites: [{ title: 'd', file: s.file, specs: [s], suites: [] }],
    })),
  };
};
const HEADERS = new Map([
  ['calendar.spec.ts', ['calendar']],
  ['multi.spec.ts', ['calendar', 'timetable']],
  ['family.spec.ts', ['family']],
]);

test('T-9 a spec visiting an undeclared area gives red map-drift; session paths and unmapped paths do not', () => {
  const report = navReport([
    navTest('calendar.spec.ts', 'a', 'expected', {
      onTest: ['/calendar/2026-01 /sign-in /'],
      onResult: ['/timetable /auth/callback /check-email /nonsense/page'],
    }),
    navTest('calendar.spec.ts', 'b', 'expected', {
      onTest: ['/invite/abc /calendar/2026-01'],
    }),
    navTest('multi.spec.ts', 'c', 'expected', {
      onTest: ['/calendar /timetable'],
    }),
    navTest('family.spec.ts', 'd', 'expected', { onTest: ['/family/invite'] }),
    navTest('nohdr.spec.ts', 'e', 'expected', { onTest: ['/timetable'] }),
  ]);
  const summary = summarizeReport(report);
  assert.deepEqual(summary.navigation['calendar.spec.ts'], [
    '/calendar/2026-01',
    '/sign-in',
    '/',
    '/timetable',
    '/auth/callback',
    '/check-email',
    '/nonsense/page',
    '/invite/abc',
  ]);
  assert.deepEqual(summary.navigation['multi.spec.ts'], [
    '/calendar',
    '/timetable',
  ]);

  const byPath = (a, b) => a.pathname.localeCompare(b.pathname);
  assert.deepEqual(
    mapDrift(summary.navigation, HEADERS).sort(byPath),
    [
      { file: 'family.spec.ts', pathname: '/family/invite', area: 'invite' },
      { file: 'calendar.spec.ts', pathname: '/invite/abc', area: 'invite' },
      { file: 'calendar.spec.ts', pathname: '/timetable', area: 'timetable' },
    ].sort(byPath),
  );

  const drift = mapDrift(summary.navigation, HEADERS);
  const red = classifyRun({ summary, reason: null, history: [], drift });
  assert.equal(red.status, 'red');
  assert.equal(red.reason, 'map-drift');
  assert.ok(red.redSpecs.includes('calendar.spec.ts'));
  assert.ok(red.redSpecs.includes('family.spec.ts'));

  // only session paths and unmapped paths: no drift, run stays green
  const quiet = summarizeReport(
    navReport([
      navTest('calendar.spec.ts', 'a', 'expected', {
        onTest: ['/ /sign-in /check-email /auth/callback /unmapped'],
      }),
    ]),
  );
  const none = mapDrift(quiet.navigation, HEADERS);
  assert.deepEqual(none, []);
  const green = classifyRun({
    summary: quiet,
    reason: null,
    history: [],
    drift: none,
  });
  assert.equal(green.status, 'green');
  assert.equal(green.reason, null);
});

test('T-10 a failed run stays reason failed when drift is also present; drift outranks flaky promotion and amber', () => {
  const drift = [
    { file: 'calendar.spec.ts', pathname: '/timetable', area: 'timetable' },
  ];
  const failing = classifyRun({
    summary: {
      stats: { expected: 3, unexpected: 1, flaky: 0, skipped: 0 },
      failedSpecs: ['auth.spec.ts'],
      flakySpecs: [],
      redTests: [],
    },
    reason: null,
    history: [],
    drift,
  });
  assert.equal(failing.status, 'red');
  assert.equal(failing.reason, 'failed');
  assert.ok(failing.redSpecs.includes('auth.spec.ts'));

  const history = [
    flakyLine(SPEC, 26),
    ...[30, 40, 50, 60, 70].map((h) => line({ ranAt: iso(NOW - h * H) })),
  ];
  const promoted = classifyRun({
    summary: flakySummary,
    reason: null,
    history,
    drift,
  });
  assert.equal(promoted.status, 'red');
  assert.equal(promoted.reason, 'map-drift');

  const amber = classifyRun({
    summary: flakySummary,
    reason: null,
    history: [],
    drift,
  });
  assert.equal(amber.status, 'red');
  assert.equal(amber.reason, 'map-drift');
});

// The drift record on `latest` and its status lines.
