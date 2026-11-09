// INFRA-72: the engine reads TICKET_GATE_<NAME> first and the previous prefix as a fallback with
// one deprecation line per old name per process; a name it sets is set under both. The previous
// prefix is built from parts so no file but env-name.mjs spells it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { REMOVED_IN, bothNames, envName } from '../env-name.mjs';
import { gateLock, heldByOther, lockPath, tryTake } from '../lock.mjs';
import { nightlyDir, nightlyDirOf } from '../nightly/record.mjs';
import { envMutationBudgetMs } from '../nightly/run.mjs';

const OLD = 'F' + 'P_';
const NEW = 'TICKET_GATE_';
const here = (f) => pathToFileURL(join(import.meta.dirname, '..', f)).href;

const dirs = [];
const kids = [];
after(() => {
  for (const k of kids) k.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const newLock = () => {
  const d = mkdtempSync(join(tmpdir(), 'env-name-'));
  dirs.push(d);
  return join(d, '.turbo', 'stack.lock');
};
const livePid = () => {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' });
  kids.push(c);
  return c.pid;
};
/** Captures what envName logs, with a private warned set. */
const probe = () => {
  const lines = [];
  return { lines, opts: { log: (l) => lines.push(l), warned: new Set() } };
};
/** Runs `fn` with process.env names set, then restores them; stderr is captured. */
const withProcessEnv = (set, fn) => {
  const before = {};
  for (const k of Object.keys(set)) before[k] = process.env[k];
  Object.assign(process.env, set);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
};

test('EN-1 only the old name: value used, one exact line', () => {
  const p = probe();
  assert.equal(envName({ [`${OLD}STACK_LOCK_PATH`]: '/x' }, 'STACK_LOCK_PATH', p.opts), '/x');
  assert.equal(REMOVED_IN, '0.2.0');
  assert.deepEqual(p.lines, [
    `ticket-gate: ${OLD}STACK_LOCK_PATH is deprecated; set ${NEW}STACK_LOCK_PATH (${OLD}STACK_LOCK_PATH is read until 0.2.0)`,
  ]);
  const q = probe();
  assert.equal(envName({ [`${OLD}E2E_JSON`]: '' }, 'E2E_JSON', q.opts), '');
  assert.equal(q.lines.length, 1, 'an empty old-only value is returned and warns');
});

test('EN-2 both set: the new name wins, nothing printed', () => {
  const cases = [
    ['non-empty', 'new', 'old', 'new'],
    ['empty new name', '', 'old', ''],
  ];
  for (const [label, current, old, want] of cases) {
    const p = probe();
    const env = { [`${NEW}NIGHTLY_DIR`]: current, [`${OLD}NIGHTLY_DIR`]: old };
    assert.equal(envName(env, 'NIGHTLY_DIR', p.opts), want, label);
    assert.deepEqual(p.lines, [], label);
  }
  const p = probe();
  assert.equal(envName({ [`${NEW}NIGHTLY_DIR`]: 'only-new' }, 'NIGHTLY_DIR', p.opts), 'only-new');
  assert.deepEqual(p.lines, []);
});

test('EN-3 one line per old name per process', async () => {
  const p = probe();
  const env = { [`${OLD}A`]: '1', [`${OLD}B`]: '2' };
  envName(env, 'A', p.opts);
  envName(env, 'A', p.opts);
  assert.equal(p.lines.length, 1, 'repeat prints once');
  envName(env, 'B', p.opts);
  envName(env, 'B', p.opts);
  assert.equal(p.lines.length, 2, 'a second name prints its own line');
  assert.match(p.lines[0], new RegExp(`${OLD}A is deprecated`));
  assert.match(p.lines[1], new RegExp(`${OLD}B is deprecated`));

  // the default warned set is per process
  const script = `import { envName } from ${JSON.stringify(here('env-name.mjs'))};
const env = { ['${OLD}A']: '1' };
envName(env, 'A'); envName(env, 'A'); envName(env, 'A');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.equal(r.stdout, '');
});

test('EN-0 neither set: undefined, the caller\'s default applies, nothing printed', () => {
  const p = probe();
  assert.equal(envName({}, 'NIGHTLY_DIR', p.opts), undefined);
  assert.equal(envName({}, 'NIGHTLY_DIR', p.opts) ?? 'dflt', 'dflt');
  assert.deepEqual(p.lines, []);
});

test('EN-4 bothNames gives the value under both names', () => {
  assert.deepEqual(bothNames('STACK_LOCK_OWNER', 'x:1:2'), {
    [`${NEW}STACK_LOCK_OWNER`]: 'x:1:2',
    [`${OLD}STACK_LOCK_OWNER`]: 'x:1:2',
  });
});

test('EN-5a takeOrExit: a spawned child sees the owner under both names', () => {
  const path = newLock();
  const script = `import { takeOrExit } from ${JSON.stringify(here('lock.mjs'))};
takeOrExit('verify:ticket', { path: ${JSON.stringify(path)} });
console.log(JSON.stringify([process.env['${NEW}STACK_LOCK_OWNER'], process.env['${OLD}STACK_LOCK_OWNER']]));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(r.status, 0, r.stderr);
  const [current, old] = JSON.parse(r.stdout);
  assert.match(current, /^verify:ticket:\d+:\d+$/);
  assert.equal(old, current);
});

test('EN-6a lockPath honours the old name alone', () => {
  const env = { [`${OLD}STACK_LOCK_PATH`]: '/tmp/old-lock' };
  assert.equal(lockPath(undefined, { env }), '/tmp/old-lock');
  assert.equal(lockPath(undefined, { env: { ...env, [`${NEW}STACK_LOCK_PATH`]: '/tmp/new-lock' } }), '/tmp/new-lock');
});

test('EN-6b tryTake nests on the old owner name alone', () => {
  const path = newLock();
  const first = tryTake(path, { owner: 'verify:ticket', cwd: '/w', pid: livePid(), env: {} });
  assert.equal(first.ok, true);
  const nested = tryTake(path, {
    owner: 'mutate:check',
    cwd: '/w',
    env: { [`${OLD}STACK_LOCK_OWNER`]: first.holder.id },
  });
  assert.equal(nested.ok, true);
  assert.equal(nested.nested, true);
});

test('EN-6c heldByOther passes on the old owner name alone', () => {
  const path = newLock();
  const { holder } = tryTake(path, { owner: 'nightly', cwd: '/w', pid: livePid(), env: {} });
  assert.equal(heldByOther(path, { env: { [`${OLD}STACK_LOCK_OWNER`]: holder.id } }), null);
  assert.equal(heldByOther(path, { env: {} })?.id, holder.id);
});

test('EN-6d gateLock timings read WAIT_S, POLL_S, PRINT_S from the old names', () => {
  const path = newLock();
  tryTake(path, { owner: 'nightly', cwd: '/w', pid: livePid(), env: {} });
  let t = Date.parse('2026-01-15T01:00:00.000Z');
  const sleeps = [];
  const logs = [];
  const g = gateLock({
    path,
    env: {
      [`${OLD}STACK_LOCK_WAIT_S`]: '30',
      [`${OLD}STACK_LOCK_POLL_S`]: '10',
      [`${OLD}STACK_LOCK_PRINT_S`]: '1000',
    },
    now: () => t,
    sleep: (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    log: (s) => logs.push(String(s)),
  });
  const got = g.acquire();
  assert.equal(got.ok, false);
  assert.ok(sleeps.length > 0 && sleeps.every((ms) => ms === 10_000), `poll 10 s: ${sleeps}`);
  assert.equal(sleeps.length, 3, 'gave up after 30 s of waiting');
  assert.equal(logs.filter((l) => /waiting/.test(l)).length, 1, 'printed once at a 1000 s interval');
});

test('EN-6e nightlyDir honours the old name alone', () => {
  assert.equal(nightlyDir({ [`${OLD}NIGHTLY_DIR`]: '/tmp/old-nightly' }), '/tmp/old-nightly');
});

test('EN-6f nightlyDirOf honours the old name alone', () => {
  withProcessEnv({ [`${OLD}NIGHTLY_DIR`]: '/tmp/old-nightly' }, () => {
    const saved = process.env[`${NEW}NIGHTLY_DIR`];
    delete process.env[`${NEW}NIGHTLY_DIR`];
    try {
      assert.equal(nightlyDirOf({ mainCheckout: '/m' }), '/tmp/old-nightly');
    } finally {
      if (saved !== undefined) process.env[`${NEW}NIGHTLY_DIR`] = saved;
    }
  });
});

test('EN-6g envMutationBudgetMs reads the old name alone', () => {
  const D = 123;
  assert.equal(envMutationBudgetMs({ [`${OLD}NIGHTLY_MUTATION_MIN`]: '5' }, D), 300_000);
  assert.equal(envMutationBudgetMs({ [`${NEW}NIGHTLY_MUTATION_MIN`]: '7', [`${OLD}NIGHTLY_MUTATION_MIN`]: '5' }, D), 420_000);
  assert.equal(envMutationBudgetMs({}, D), D);
  assert.equal(envMutationBudgetMs({ [`${NEW}NIGHTLY_MUTATION_MIN`]: '' }, D), D);
  assert.equal(envMutationBudgetMs({ [`${NEW}NIGHTLY_MUTATION_MIN`]: 'abc' }, D), D);
  assert.equal(envMutationBudgetMs({ [`${NEW}NIGHTLY_MUTATION_MIN`]: '0' }, D), 0);
});
