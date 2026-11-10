import assert from 'node:assert/strict';
import { test } from 'node:test';

import { priceOf } from '../src/catalog.mjs';

test('priceOf knows the catalog', () => {
  assert.equal(priceOf('apple'), 50);
});

test('priceOf refuses an unknown sku', () => {
  assert.throws(() => priceOf('kiwi'), RangeError);
});
