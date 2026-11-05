import assert from 'node:assert/strict';
import { test } from 'node:test';

import {} from './__tests__/survivors.helpers.mjs';
import { baseToHeadLines, parseChangedLines } from './__tests__/demo.mjs';

test('MS-LM baseToHeadLines shifts untouched lines past each hunk and drops rewritten ones', () => {
  // base 1..10; lines 3-4 rewritten as 3 lines, 2 lines inserted after base 7, base 9 deleted.
  const map = baseToHeadLines(
    '@@ -3,2 +3,3 @@\n@@ -7,0 +9,2 @@\n@@ -9 +10,0 @@\n',
  );
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(map), [
    1,
    2,
    null,
    null,
    6,
    7,
    8,
    11,
    null,
    12,
  ]);
  assert.equal(baseToHeadLines('')(42), 42);
});

test('MS-L parseChangedLines reads new-side lines and ignores deletions', () => {
  assert.deepEqual(
    [...parseChangedLines('@@ -10,2 +12,3 @@ x')].sort((a, b) => a - b),
    [12, 13, 14],
  );
  assert.equal(parseChangedLines('@@ -20 +20,0 @@').size, 0);
  assert.deepEqual([...parseChangedLines('@@ -5 +5 @@')], [5]);
  assert.deepEqual(
    [...parseChangedLines('@@ -1 +1 @@\n x\n@@ -9,0 +9,2 @@\n')].sort(
      (a, b) => a - b,
    ),
    [1, 9, 10],
  );
});
