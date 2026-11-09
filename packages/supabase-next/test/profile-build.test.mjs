import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextProfiling } from '../profile-build.mjs';

test('NP-1 nextProfiling builds with profiling flags and starts in the app dir', () => {
  assert.deepEqual(nextProfiling({ app: 'web' }), {
    command: 'cd web && npx --no-install next build --profile --no-mangling',
    unmangle: '--no-mangling',
    start: 'cd web && npx --no-install next start',
    port: 3000,
    noBuildLabel: 'unknown (existing server on :3000)',
  });
});
