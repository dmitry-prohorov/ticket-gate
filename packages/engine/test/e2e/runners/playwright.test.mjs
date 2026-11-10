// E-10, E-11: shadowOf and testListLines.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shadowOf, testListLines } from '../__tests__/bound.mjs';

const test1 = (file, title, status, tags = []) => ({
  title,
  file,
  tags,
  tests: [{ projectName: 'chromium', status, annotations: [], results: [] }],
});
const reportOf = (specs) => {
  const byFile = new Map();
  for (const s of specs) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  return {
    stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [...byFile].map(([file, ss]) => ({
      title: file,
      file,
      specs: [],
      suites: [{ title: 'describe', file, specs: ss, suites: [] }],
    })),
  };
};

test('E-10 shadowOf: an unexpected test in an unselected file is missed; smoke-tagged, seed-integrity and selected files are not; full gives []; null report gives missed null', () => {
  const affected = {
    mode: 'affected',
    why: 'affected: 1 areas, 1 specs',
    areas: ['calendar'],
    specs: ['calendar.spec.ts'],
  };
  const miss = shadowOf(
    affected,
    reportOf([
      test1('timetable.spec.ts', 'drags', 'unexpected'),
      test1('calendar.spec.ts', 'shows', 'unexpected'),
    ]),
  );
  assert.equal(miss.mode, 'affected');
  assert.deepEqual(miss.selected, ['calendar.spec.ts']);
  assert.deepEqual(miss.missed, ['timetable.spec.ts']);

  const notMissed = shadowOf(
    affected,
    reportOf([
      test1('calendar.spec.ts', 'shows', 'unexpected'),
      test1('auth.spec.ts', 'signs in', 'unexpected', ['@smoke']),
      test1('invite.spec.ts', 'accepts', 'unexpected', ['smoke']),
      test1('seed-integrity.setup.ts', 'seed ok', 'unexpected'),
      test1('seed-integrity.teardown.ts', 'seed ok', 'unexpected'),
      test1('family.spec.ts', 'flaked then passed', 'flaky'),
      test1('telegram.spec.ts', 'passes', 'expected'),
    ]),
  );
  assert.deepEqual(notMissed.missed, []);

  const full = shadowOf(
    { mode: 'full', why: 'supabase/seed.sql: trigger', areas: [], specs: [] },
    reportOf([test1('timetable.spec.ts', 'drags', 'unexpected')]),
  );
  assert.equal(full.mode, 'full');
  assert.deepEqual(full.missed, []);

  const none = shadowOf(affected, null);
  assert.equal(none.missed, null);
  assert.equal(none.error, 'no-report');
});

test('E-11 testListLines lists every test of a selected file plus smoke tests from others; full gives null', () => {
  const list = reportOf([
    test1('calendar.spec.ts', 'shows the week', 'expected'),
    test1('calendar.spec.ts', 'adds an event', 'expected'),
    test1('timetable.spec.ts', 'drags a block', 'expected'),
    test1('auth.spec.ts', 'signs in', 'expected', ['@smoke']),
  ]);
  const lines = testListLines(list, {
    mode: 'affected',
    why: 'affected: 1 areas, 1 specs',
    areas: ['calendar'],
    specs: ['calendar.spec.ts'],
  });
  assert.equal(lines.length, 3);
  for (const l of lines) assert.ok(l.includes(' › '), l);
  const has = (file, title) =>
    lines.some((l) => l.startsWith(`${file} › `) && l.includes(title));
  assert.ok(has('calendar.spec.ts', 'shows the week'));
  assert.ok(has('calendar.spec.ts', 'adds an event'));
  assert.ok(
    has('auth.spec.ts', 'signs in'),
    'smoke test from an unselected file',
  );
  assert.ok(!lines.some((l) => l.includes('drags a block')));

  assert.equal(
    testListLines(list, {
      mode: 'full',
      why: 'turbo.json: trigger',
      areas: [],
      specs: [],
    }),
    null,
  );
});
