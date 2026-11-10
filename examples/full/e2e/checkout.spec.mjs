// e2e-areas: checkout
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { checkoutPage } from '../app/checkout.mjs';

const cart = JSON.parse(readFileSync(new URL('./fixtures/cart.json', import.meta.url), 'utf8'));

test('checkout shows the discounted total', () => {
  assert.equal(checkoutPage(cart), 'Total: 4.05');
});
