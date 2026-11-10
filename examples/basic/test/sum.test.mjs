import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sum } from '../src/sum.mjs';

test('sum adds two numbers', () => {
  assert.equal(sum(2, 3), 5);
});

test('sum refuses a non-number', () => {
  assert.throws(() => sum('2', 3), TypeError);
});
