// NM-1..NM-8 (the mutation phase, rotation order, realRun).

import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  NIGHTLY,
  tmp,
  H,
  MIN,
  local,
  NOW,
  SHA,
  iso,
  world,
  history,
} from './__tests__/world.mjs';

const { MUTATION_GRACE_S, runMutationPhase, runNightly } =
  await import('./__tests__/bound.mjs');
const { realRun } = await import('../../nightly/io.mjs');
const { compactLedger, readLedger, rotationOrder } =
  await import('../../mutations/rotate.mjs');

const reg = (...specs) =>
  new Map(
    specs.map((x) => {
      const [key, extra = {}] = Array.isArray(x) ? x : [x];
      return [
        key,
        {
          path: 'tools/mutation-registry/tools/x.json',
          line: 1,
          entry: {
            kind: 'patch',
            file: `tools/${key.replace('/', '-')}.mjs`,
            testFile: `tools/${key.replace('/', '-')}.test.mjs`,
            ...extra,
          },
        },
      ];
    }),
  );
const ledgerLine = (key, status, daysAgo, sha = 'c'.repeat(40)) => ({
  key,
  sha,
  status,
  ranAt: iso(NOW - daysAgo * 24 * H),
});
const writeLedger = (lines) =>
  writeFileSync(
    join(NIGHTLY, 'mutations.jsonl'),
    `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
  );
const phaseOpts = (w, over = {}) => ({
  dir: NIGHTLY,
  wt: w.wt,
  sha: SHA,
  holderId: 'nightly:1:1',
  startMs: NOW,
  deadlineMs: NOW + 5 * H,
  ...over,
});
const everyBatch25 = (w, ids) => {
  w.clock += 25 * MIN;
  return { results: ids.map((id) => ({ id, status: 'killed' })) };
};

test('NM-1 rotationOrder runs never-run keys first, then oldest last run, ties by key', () => {
  const live = ['A/M1', 'B/M1', 'C/M1', 'D/M1'].map((key) => ({ key }));
  const ledger = [
    ledgerLine('A/M1', 'killed', 1),
    ledgerLine('C/M1', 'killed', 5),
    ledgerLine('D/M1', 'killed', 10),
    ledgerLine('D/M1', 'survived', 9),
  ];
  assert.deepEqual(rotationOrder(live, ledger), [
    'B/M1',
    'D/M1',
    'C/M1',
    'A/M1',
  ]);
  const tie = ['Z/M1', 'Y/M10', 'Y/M2'].map((key) => ({ key }));
  assert.deepEqual(rotationOrder(tie, []), ['Y/M2', 'Y/M10', 'Z/M1']);
});

test('NM-2a the phase starts no batch once the budget is spent', async () => {
  const w = world({
    entries: reg('A/M1', 'A/M2', 'A/M3', 'A/M4', 'A/M5'),
    mutate: everyBatch25,
  });
  const got = await runMutationPhase(
    w.io,
    phaseOpts(w, { budgetMs: 60 * MIN, deadlineMs: NOW + 3 * H, batch: 1 }),
  );
  assert.equal(w.mutateCalls.length, 3);
  assert.equal(got.stoppedBy, 'budget');
  assert.equal(got.ran, 3);
  assert.equal(got.status, 'ran');
});

test('NM-2b the phase stops at the deadline before the budget, and a batch limit never passes the deadline', async () => {
  const w = world({
    entries: reg('A/M1', 'A/M2', 'A/M3', 'A/M4', 'A/M5'),
    mutate: everyBatch25,
  });
  const deadlineMs = NOW + 30 * MIN;
  const got = await runMutationPhase(
    w.io,
    phaseOpts(w, { budgetMs: 60 * MIN, deadlineMs, batch: 1 }),
  );
  assert.equal(w.mutateCalls.length, 2);
  assert.equal(got.stoppedBy, 'deadline');
  const batches = w.calls.filter((c) => c.line.includes('mutate-check'));
  assert.deepEqual(
    batches.map((c) => c.limitS),
    [1800, 300],
    'the limit is the time left to the deadline at each start',
  );
  for (const c of batches) {
    assert.equal(c.killSignal, 'SIGTERM');
    assert.equal(c.graceS, MUTATION_GRACE_S);
    assert.equal(c.cwd, w.wt);
    assert.equal(c.env.FP_STACK_LOCK_OWNER, 'nightly:1:1');
    assert.match(
      c.line,
      /^node tools\/mutate-check\.mjs --registry --ids=A\/M\d$/,
    );
  }
});

test('NM-3 a survivor is recorded with file, testFile and its last kill sha, and the ledger gains survived', async () => {
  const w = world({
    entries: reg('X/M1', 'X/M2'),
    mutate: (_w, ids) => ({
      results: ids.map((id) => ({
        id,
        status: id === 'X/M2' ? 'survived' : 'killed',
      })),
    }),
  });
  const killSha = 'd'.repeat(40);
  writeLedger([ledgerLine('X/M2', 'killed', 3, killSha)]);
  const got = await runMutationPhase(w.io, phaseOpts(w));
  assert.deepEqual(got.survivors, [
    {
      key: 'X/M2',
      file: 'tools/X-M2.mjs',
      testFile: 'tools/X-M2.test.mjs',
      lastKillSha: killSha,
    },
  ]);
  assert.equal(got.survived, 1);
  assert.equal(got.killed, 1);
  const ledger = readLedger(NIGHTLY);
  const mine = ledger.filter((l) => l.key === 'X/M2');
  assert.equal(mine.at(-1).status, 'survived');
  assert.equal(mine.at(-1).sha, SHA);
  assert.ok(
    mine.some((l) => l.status === 'killed' && l.sha === killSha),
    'the newest kill is kept',
  );
  assert.equal(got.unproven, 0);
  assert.equal(got.oldestProofDays, 3, 'X/M2 keeps its kill from 3 days ago');
});

test('NM-4 a retired entry never runs and is not counted live', async () => {
  const w = world({
    entries: reg('A/M1', ['A/M2', { retired: 'gone' }], 'A/M3'),
  });
  const got = await runMutationPhase(w.io, phaseOpts(w));
  assert.equal(got.live, 2);
  assert.deepEqual(w.mutateCalls, [['A/M1', 'A/M3']]);
});

test('NM-5 a ledger line that is not valid JSON or lacks a field is skipped, and compaction keeps the newest line and the newest kill per key', () => {
  const good = ledgerLine('A/M1', 'killed', 2);
  writeFileSync(
    join(NIGHTLY, 'mutations.jsonl'),
    [
      JSON.stringify(good),
      '{not json',
      JSON.stringify({ key: 'A/M2', sha: 'x', status: 'killed' }),
      JSON.stringify({ ...good, status: 'weird' }),
      JSON.stringify({ ...good, key: 7 }),
      '',
    ].join('\n'),
  );
  assert.deepEqual(readLedger(NIGHTLY), [good]);
  rmSync(join(NIGHTLY, 'mutations.jsonl'));
  assert.deepEqual(readLedger(NIGHTLY), []);

  const lines = [
    ledgerLine('B/M1', 'killed', 9),
    ledgerLine('B/M1', 'killed', 5),
    ledgerLine('B/M1', 'error', 3),
    ledgerLine('B/M1', 'survived', 1),
    ledgerLine('A/M1', 'survived', 4),
  ];
  assert.deepEqual(compactLedger(lines), [
    ledgerLine('A/M1', 'survived', 4),
    ledgerLine('B/M1', 'killed', 5),
    ledgerLine('B/M1', 'survived', 1),
  ]);
});

test('NM-6 a phase that throws or finds no receipt is recorded in mutations and leaves the e2e record green', async () => {
  const boom = world({ registryThrows: 'registry on fire' });
  const r1 = await runNightly(boom.io);
  assert.equal(r1.status, 'green');
  assert.equal(r1.mutations.status, 'error');
  assert.match(r1.mutations.reason, /registry on fire/);
  assert.equal(history().at(-1).status, 'green');
  assert.equal(existsSync(boom.lock), false, 'the lock is released');

  const none = world({
    entries: reg('A/M1'),
    mutate: () => ({ results: null }),
  });
  const r2 = await runNightly(none.io);
  assert.equal(r2.status, 'green');
  assert.equal(r2.mutations.status, 'error');
  assert.equal(r2.mutations.reason, 'no-receipt');
  assert.deepEqual(readLedger(NIGHTLY), [], 'no ledger line for that batch');
  assert.equal(existsSync(none.lock), false);

  const cut = world({
    entries: reg('A/M1'),
    mutate: () => ({ results: null, timedOut: true }),
  });
  const r3 = await runNightly(cut.io);
  assert.equal(r3.mutations.reason, 'cut-short');
  assert.equal(r3.status, 'green');
  assert.equal(r3.reason, null);
});

test('NM-7 the phase runs after Playwright and before the main-checkout reset, only on scheduled or --now, with the stack lock owner', async () => {
  const w = world({ entries: reg('A/M1', 'A/M2') });
  const r = await runNightly(w.io);
  const lines = w.calls.map((c) => c.line);
  const pw = lines.findIndex((l) => l.includes('playwright test'));
  const mc = lines.findIndex((l) => l.includes('mutate-check'));
  const finalReset = w.calls.findIndex(
    (c, i) => i > mc && c.line === 'pnpm db:reset' && c.cwd === w.main,
  );
  assert.ok(pw >= 0 && mc > pw && finalReset > mc, lines.join('\n'));
  assert.equal(
    w.calls[mc].env.FP_STACK_LOCK_OWNER,
    w.calls[pw].env.FP_STACK_LOCK_OWNER,
  );
  assert.match(w.calls[mc].env.FP_STACK_LOCK_OWNER, /^nightly:\d+:\d+$/);
  assert.equal(r.mutations.status, 'ran');
  assert.equal(r.mutations.live, 2);
  assert.equal(
    existsSync(join(w.wt, '.demo-nightly-ready')),
    true,
    'a clean worktree stays ready',
  );

  const catchUp = world({ now: local(15, 12, 0), entries: reg('A/M1') });
  const c = await runNightly(catchUp.io);
  assert.deepEqual(
    [c.mutations.status, c.mutations.reason],
    ['skipped', 'catch-up'],
  );
  assert.equal(catchUp.mutateCalls.length, 0);

  const forced = world({ now: local(15, 12, 0), entries: reg('A/M1') });
  const f = await runNightly(forced.io, { now: true });
  assert.equal(f.mutations.status, 'ran');
  assert.equal(forced.mutateCalls.length, 1);

  const off = world({ entries: reg('A/M1') });
  const o = await runNightly(off.io, { mutationBudgetMs: 0 });
  assert.deepEqual(
    [o.mutations.status, o.mutations.reason],
    ['skipped', 'disabled'],
  );
  assert.equal(off.mutateCalls.length, 0);

  const red = world({
    entries: reg('A/M1'),
    fail: (l) => l === 'pnpm db:reset',
  });
  const e = await runNightly(red.io);
  assert.equal(e.reason, 'reset-failed');
  assert.equal(e.mutations, null);
  assert.equal(red.mutateCalls.length, 0);

  const dirtyW = world({ entries: reg('A/M1'), dirty: ' M tools/x.mjs\n' });
  await runNightly(dirtyW.io);
  assert.equal(
    existsSync(join(dirtyW.wt, '.demo-nightly-ready')),
    false,
    'a dirty worktree is rebuilt next night',
  );
});

test('NM-8 realRun with killSignal SIGTERM lets the child clean up before SIGKILL', async () => {
  const dir = tmp('nightly-term-');
  const marker = join(dir, 'cleaned');
  const script = `process.on('SIGTERM',()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'x');process.exit(0)});setInterval(()=>{},1000)`;
  const got = await realRun(process.execPath, ['-e', script], {
    cwd: dir,
    limitS: 1,
    killSignal: 'SIGTERM',
    graceS: 5,
  });
  assert.equal(got.timedOut, true);
  assert.equal(existsSync(marker), true, 'the SIGTERM handler ran');
});
