// The test-only db-schema binding binds the pack's tool name, so a one-argument normalise() names the shim.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalise } from './__tests__/db-schema-cli.mjs';

test('DSH-1 shim normalise(dump) names tools/db-schema.mjs in its pg_dump-noise error', () => {
  assert.throws(
    () => normalise('garbage line\n'),
    /in tools\/db-schema\.mjs if it is pg_dump noise/,
  );
});
