// e2e-areas: catalog
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { catalogPage } from '../app/catalog.mjs';

test('catalog lists every item with its price', () => {
  assert.equal(catalogPage(), 'apple 50\npear 70\nplum 30');
});
