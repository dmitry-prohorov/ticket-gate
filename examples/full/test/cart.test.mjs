import assert from 'node:assert/strict';
import { test } from 'node:test';

import { total } from '../src/cart.mjs';

test('total sums the lines', () => {
  assert.equal(total([{ sku: 'apple', qty: 2 }, { sku: 'pear', qty: 1 }]), 170);
});

test('total takes 10% off from 10 items', () => {
  assert.equal(total([{ sku: 'plum', qty: 10 }]), 270);
});

test('total keeps the full price at 9 items', () => {
  assert.equal(total([{ sku: 'plum', qty: 9 }]), 270);
});
