import assert from 'node:assert/strict';
import { test } from 'node:test';

import {} from './__tests__/survivors.helpers.mjs';
import { mutationTargets, testedModule } from './__tests__/demo.mjs';

test('MS-T testedModule maps a test file to the longest existing module beside it', () => {
  const D = 'packages/core/src/domain/';
  const has =
    (...f) =>
    (p) =>
      f.map((x) => D + x).includes(p);
  assert.equal(
    testedModule(`${D}calendar.test.ts`, has('calendar.ts')),
    `${D}calendar.ts`,
  );
  assert.equal(
    testedModule(`${D}calendar-drag.case.test.ts`, has('calendar-drag.ts')),
    `${D}calendar-drag.ts`,
  );
  assert.equal(
    testedModule(`${D}a.b.c.test.ts`, has('a.ts', 'a.b.ts')),
    `${D}a.b.ts`,
  );
  assert.equal(testedModule(`${D}orphan.test.ts`, has()), null);
  assert.equal(testedModule(`${D}calendar.ts`, has('calendar.ts')), null);
});

test("MS-T2 mutationTargets selects a test file's module once, and still excludes tests, index and constants", () => {
  const D = 'packages/core/src/domain/';
  const exists = (p) =>
    [`${D}calendar.ts`, `${D}index.ts`, `${D}constants.ts`].includes(p);
  assert.deepEqual(
    mutationTargets(
      [
        `${D}calendar.ts`,
        `${D}calendar.test.ts`,
        `${D}calendar.other.test.ts`,
        `${D}index.test.ts`,
        `${D}constants.test.ts`,
        `${D}orphan.test.ts`,
      ],
      exists,
    ),
    [`${D}calendar.ts`],
  );
});
