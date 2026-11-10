// SS-1..SS-3: the Supabase stack payload the pack gives the nightly.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { supabaseNext } from '../../index.mjs';
import { dockerInfo, supabaseStack } from '../../nightly/stack-payload.mjs';

const ARGV = { preflight: ['check-stack', '--wait=1'], reset: ['reset-db', '--all'] };

test('SS-1 supabaseStack without preflight or reset argv throws TypeError', () => {
  for (const bad of [undefined, {}, { preflight: ARGV.preflight }, { reset: ARGV.reset }, { preflight: [], reset: ARGV.reset }, { preflight: ARGV.preflight, reset: [] }, { preflight: 'x', reset: ARGV.reset }])
    assert.throws(() => supabaseStack(bad), TypeError);
});

test('SS-2 supabaseNext gives nightlyPayloads [supabase-stack] only with nightlyStack and never a nightly hook', () => {
  const without = supabaseNext({ tools: {} });
  assert.equal('nightlyPayloads' in without, false);
  assert.equal('nightly' in without, false);
  const given = supabaseNext({ tools: {}, nightlyStack: ARGV });
  assert.deepEqual(given.nightlyPayloads.map((p) => p.name), ['supabase-stack']);
  assert.equal('nightly' in given, false);
});

test('SS-3 the payload runs preflight then reset in the worktree and reset in main, and carries io.dockerUp', async () => {
  const p = supabaseStack(ARGV);
  assert.equal(p.io.dockerUp, dockerInfo);
  const calls = [];
  const io = (codes) => ({
    dockerUp: async () => codes.docker ?? true,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, ...opts });
      return { code: codes[cmd] ?? 0 };
    },
  });
  assert.deepEqual(await p.preflight('/main', io({ docker: false })), { reason: 'docker-down' });
  assert.deepEqual(await p.preflight('/main', io({})), { ok: true });

  assert.deepEqual(await p.before('/wt', io({})), { ok: true });
  assert.deepEqual(calls, [
    { cmd: 'check-stack', args: ['--wait=1'], cwd: '/wt', limitS: 180 },
    { cmd: 'reset-db', args: ['--all'], cwd: '/wt', limitS: 600 },
  ]);
  calls.length = 0;
  assert.deepEqual(await p.before('/wt', io({ 'check-stack': 1 })), { reason: 'stack-down', runAfter: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(await p.before('/wt', io({ 'reset-db': 1 })), { reason: 'reset-failed', runAfter: true });

  calls.length = 0;
  assert.equal(await p.after('/main', io({})), 'pass');
  assert.deepEqual(calls, [{ cmd: 'reset-db', args: ['--all'], cwd: '/main', limitS: 600 }]);
  assert.equal(await p.after('/main', io({ 'reset-db': 1 })), 'fail');
});
