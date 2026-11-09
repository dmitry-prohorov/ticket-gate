// dbReset tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dbReset } from '../profile-hooks.mjs';

test('PW-12 dbReset with a red stack throws and never resets', async () => {
  let ran = 0;
  await assert.rejects(
    dbReset({
      checkStack: async () => [
        'the stack is stopped: run `pnpm supabase start`',
      ],
      run: async () => {
        ran += 1;
        return { code: 0, timedOut: false, out: '' };
      },
    }),
    /^Error: dbReset: the stack is stopped/,
  );
  assert.equal(ran, 0);
});

test('PW-13 dbReset throws TIMEOUT when the reset is cut off, and runs bounded', async () => {
  const calls = [];
  await assert.rejects(
    dbReset({
      checkStack: async () => [],
      run: async (cmd, opts) => {
        calls.push([cmd, opts]);
        return { code: 124, timedOut: true, out: '' };
      },
    }),
    /TIMEOUT/,
  );
  assert.deepEqual(calls, [['pnpm db:reset', { limitS: 300 }]]);
});

test('PW-14 dbReset resolves on a clean reset', async () => {
  await dbReset({
    checkStack: async () => [],
    run: async () => ({ code: 0, timedOut: false, out: '' }),
  });
});

test('PW-15 dbReset throws when pnpm db:reset exits non-zero', async () => {
  await assert.rejects(
    dbReset({
      checkStack: async () => [],
      run: async () => ({ code: 1, timedOut: false, out: '' }),
    }),
    /pnpm db:reset exited 1/,
  );
});
