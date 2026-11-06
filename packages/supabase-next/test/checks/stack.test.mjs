// SK-1..SK-3: the supabase-next stack factories thread their options.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { stackPreflight } from '../../checks/stack-preflight.mjs';
import { supabaseStack } from '../../checks/stack.mjs';

const P = 'proj';
const UP = 'Up 5 minutes (healthy)';

function setup(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'infra75-'));
  mkdirSync(join(root, 'w'));
  writeFileSync(join(root, 'w/.env.example'), '# K=no\nK=abc\nOTHER=x\n');
  const sp = stackPreflight({
    services: { db: ['db'], e2e: ['db', 'auth'] },
    root,
    cli: 'supabase',
    webEnv: { file: 'w/.env.local', missing: 'NO-ENV' },
    anonKey: { file: 'w/.env.example', name: 'K' },
    usage: 'U',
    ...extra,
  });
  return { root, sp };
}

const fakeIo = (text) => ({
  projectId: () => P,
  dockerPs: async () => ({ ok: true, text }),
  probe: async () => 200,
  tcp: async () => true,
  portHolder: async () => null,
  hasWebEnv: () => false,
  anonKey: () => 'anon',
});

test('SK-1 stackPreflight threads services, cli, webEnv and usage', async () => {
  const { sp } = setup();
  assert.deepEqual(sp.REQUIRED, { db: ['db'], e2e: ['db', 'auth'] });

  const stopped = await sp.checkStack({ steps: ['db'] }, fakeIo(''));
  assert.deepEqual(stopped.problems, [
    'the stack is stopped: run `supabase start`',
  ]);

  const dbOnly = `supabase_db_${P}\t${UP}`;
  const r = await sp.checkStack({ steps: ['e2e'] }, fakeIo(dbOnly));
  assert.ok(
    r.problems.includes(
      'service auth is missing (no container): run `supabase stop && supabase start`',
    ),
    r.problems.join('\n'),
  );
  assert.ok(r.problems.includes('NO-ENV'), r.problems.join('\n'));

  assert.deepEqual(sp.parseArgs(['--steps=x']), {
    error: 'unknown step id x: use db, e2e',
  });

  const errors = [];
  const code = await sp.main(['--bogus'], fakeIo(dbOnly), {
    log: () => {},
    error: (m) => errors.push(m),
  });
  assert.equal(code, 2);
  assert.deepEqual(errors, ['unknown argument --bogus\nU']);
});

test('SK-3 realIo reads the anon key and the web env from the configured files', () => {
  const { root, sp } = setup();
  const io = sp.realIo();
  assert.equal(io.anonKey(), 'abc');
  assert.equal(io.hasWebEnv(), false);
  writeFileSync(join(root, 'w/.env.local'), '');
  assert.equal(sp.realIo().hasWebEnv(), true);
});

test('SK-2 supabaseStack builds the health commands from cmd and waits', () => {
  const S = { db: ['db'] };
  const R = { step: 'seed' };
  const r = supabaseStack({ services: S, cmd: 'node x.mjs', reset: R });
  assert.equal(r.services, S);
  assert.equal(r.reset, R);
  assert.equal(r.health.step, 'preflight');
  assert.equal(
    r.health.preflight(['db', 'seed']),
    'node x.mjs --wait=20 --steps=db,seed',
  );
  assert.equal(r.health.ready(['e2e']), 'node x.mjs --wait=90 --steps=e2e');

  const w = supabaseStack({
    services: S,
    cmd: 'c',
    waits: { preflight: 5, ready: 7 },
  });
  assert.equal(w.health.preflight(['a']), 'c --wait=5 --steps=a');
  assert.equal(w.health.ready(['a']), 'c --wait=7 --steps=a');
  assert.equal('reset' in w, false);
  assert.equal(w.services, S);
});
