import assert from 'node:assert/strict';
import { test } from 'node:test';

import { disablesWithoutReason } from '../__tests__/demo.mjs';

test('MS-D1 a Stryker disable needs a stated reason', () => {
  const bad = [
    '// Stryker disable next-line all',
    '// Stryker disable next-line StringLiteral:',
    '// Stryker disable all',
  ];
  for (const l of bad)
    assert.deepEqual(disablesWithoutReason(l), [{ line: 1 }], l);
  const ok = [
    '// Stryker disable next-line ConditionalExpression: equivalent, re-checked in parse',
    '// Stryker disable all: generated table',
    '// Stryker restore all',
    'const x = 1;',
  ];
  for (const l of ok) assert.deepEqual(disablesWithoutReason(l), [], l);
  assert.deepEqual(disablesWithoutReason(`a\n${bad[0]}`), [{ line: 2 }]);
});
