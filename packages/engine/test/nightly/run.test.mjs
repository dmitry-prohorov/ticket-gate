// N-2..N-6 (runNightly, tokenOf).

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, test } from 'node:test';

import {
  NIGHTLY,
  H,
  MIN,
  local,
  NOW,
  SHA,
  SHA12,
  TOKEN,
  iso,
  world,
  history,
  nightlyText,
  KEYS,
  heldBy,
  release,
} from './__tests__/world.mjs';

const { runNightly, tokenOf } = await import('./__tests__/bound.mjs');
const { E2E_LIMIT_S, RETRY_MS } = await import('../../nightly/schedule.mjs');

// ------------------------------------------------------------------- N-2

test('N-2 docker down: record status error, reason docker-down, no git/pnpm run, lock released', async () => {
  const w = world({ docker: false });
  await runNightly(w.io);
  assert.deepEqual(
    w.calls.map((c) => c.line),
    [],
    'no git or pnpm command ran',
  );
  const last = history().at(-1);
  assert.equal(last.status, 'error');
  assert.equal(last.reason, 'docker-down');
  assert.equal(last.reachedPlaywright, false);
  assert.equal(last.stats, null);
  assert.equal(existsSync(w.lock), false, 'the lock is released');
  assert.equal(w.removed.length, 0);
});

// ------------------------------------------------------------------- N-3

const IN_ORDER = (w) => [
  ['git fetch origin main', w.main],
  ['git rev-parse origin/main', w.main],
  [`git worktree add --detach ${w.wt} ${SHA}`, undefined],
  ['pnpm install --frozen-lockfile --prefer-offline', w.wt],
  ['pnpm -F @demo/core build', w.wt],
  ['node tools/stack-preflight.mjs --wait=90 --steps=seed,e2e', w.wt],
  ['pnpm db:reset', w.wt],
  ['pnpm -F web exec playwright test --retries=2 --reporter=json,list', w.wt],
  ['pnpm db:reset', w.main],
];

test('N-3 runNightly issues the section 2.4 commands in order with the cwd each names, and records skipped-busy after the 06:00 deadline', async () => {
  const w = world();
  await runNightly(w.io);
  const want = IN_ORDER(w);
  const known = new Set(want.map(([l]) => l));
  const got = w.calls.filter((c) => known.has(c.line));
  assert.deepEqual(
    got.map((c) => c.line),
    want.map(([l]) => l),
  );
  got.forEach((c, i) => {
    if (want[i][1] !== undefined) assert.equal(c.cwd, want[i][1], c.line);
  });
  const pw = got[7];
  assert.equal(pw.limitS, E2E_LIMIT_S);
  assert.match(pw.env.FP_STACK_LOCK_OWNER, /^nightly:\d+:\d+$/);
  assert.ok(
    pw.env.PLAYWRIGHT_JSON_OUTPUT_NAME.startsWith(sep),
    'an absolute report path',
  );
  assert.equal(
    w.lockDuringRun[0]?.id,
    pw.env.FP_STACK_LOCK_OWNER,
    'the lock was held, under that id',
  );
  assert.equal(w.lockDuringRun[0]?.owner, 'nightly');
  assert.equal(w.caffeinated.length, 1);
  assert.equal(existsSync(w.lock), false, 'released at the end');
  const last = history().at(-1);
  assert.equal(last.status, 'green');
  assert.equal(last.sha, SHA);
  assert.equal(last.finalReset, 'pass');
  assert.equal(last.reachedPlaywright, true);

  // 05:40 with a live holder: a retry (+30 min) would pass 06:00
  const late = world({ now: local(15, 5, 40) });
  const holder = heldBy(late.lock);
  await runNightly(late.io);
  assert.deepEqual(late.calls, [], 'nothing ran while busy');
  const rec = history().at(-1);
  assert.equal(rec.status, 'skipped-busy');
  assert.equal(rec.trigger, 'scheduled');
  assert.equal(rec.reachedPlaywright, false);
  assert.equal(
    JSON.parse(readFileSync(join(late.lock, 'owner.json'), 'utf8')).id,
    holder.id,
    "the other holder's lock is untouched",
  );
});

test('N-3 a busy stack defers by RETRY_MS and starts once it has been idle for IDLE_MS', async () => {
  let holder;
  let w;
  w = world({
    sleep: (world) => async (ms) => {
      world.sleeps.push(ms);
      world.clock += ms;
      if (world.sleeps.length === 1)
        release(world.lock, holder, { now: () => world.clock });
    },
  });
  holder = heldBy(w.lock);
  await runNightly(w.io);
  assert.deepEqual(w.sleeps, [RETRY_MS, RETRY_MS, RETRY_MS]);
  assert.ok(w.calls.some((c) => c.line.includes('playwright test')));
  assert.equal(history().at(-1).status, 'green');
});

test('N-3 a failing step ends the run with its reason and a record', async () => {
  const cases = [
    ['fetch-failed', (l) => l === 'git fetch origin main'],
    ['worktree-failed', (l) => l.startsWith('git worktree add')],
    ['install-failed', (l) => l.startsWith('pnpm install')],
    ['stack-down', (l) => l.startsWith('node tools/stack-preflight.mjs')],
  ];
  for (const [reason, fail] of cases) {
    const w = world({ fail });
    await runNightly(w.io);
    const last = history().at(-1);
    assert.equal(last.status, 'error', reason);
    assert.equal(last.reason, reason);
    assert.equal(last.reachedPlaywright, false, reason);
    assert.equal(
      w.calls.some((c) => c.line.includes('playwright test')),
      false,
      `${reason}: Playwright never ran`,
    );
    assert.equal(existsSync(w.lock), false, `${reason}: lock released`);
  }
  const w = world({ envLocal: false });
  await runNightly(w.io);
  assert.equal(history().at(-1).reason, 'env-missing');

  const r = world({ fail: (l) => l === 'pnpm db:reset' });
  await runNightly(r.io);
  assert.equal(history().at(-1).reason, 'reset-failed');

  const cut = world({ pwCode: 1, timedOut: true, noReport: true });
  await runNightly(cut.io);
  const c = history().at(-1);
  assert.equal(c.reason, 'cut-short');
  assert.equal(c.reachedPlaywright, false);
  assert.ok(
    cut.calls.filter((x) => x.line === 'pnpm db:reset' && x.cwd === cut.main)
      .length === 1,
    'the main checkout is still reset after a cut-short run',
  );

  const none = world({ noReport: true, pwCode: 1 });
  await runNightly(none.io);
  assert.equal(history().at(-1).reason, 'no-report');
});

// ------------------------------------------------------------------- N-4

test("N-4 the functions .env is written only at <tmpdir>/demo-nightly/<sha12>/supabase/functions/.env with the main checkout's token, nothing under mainCheckout is written, and a main checkout with no file or no TELEGRAM_BOT_TOKEN value ends error token-missing with no write and no Playwright run", async () => {
  const mainEnv = `# local fake token\nTELEGRAM_BOT_TOKEN=${TOKEN}\nOTHER=1\n`;
  const w = world({ mainEnv });
  await runNightly(w.io);
  const target = join(
    w.tmpd,
    'demo-nightly',
    SHA12,
    'supabase',
    'functions',
    '.env',
  );
  const envWrites = w.writes.filter((p) =>
    p.endsWith(join('functions', '.env')),
  );
  assert.deepEqual(envWrites, [target]);
  assert.equal(readFileSync(target, 'utf8'), mainEnv, 'copied verbatim');
  assert.deepEqual(
    w.writes.filter((p) => p === w.main || p.startsWith(w.main + sep)),
    [],
    'nothing under the main checkout is written',
  );
  assert.equal(
    readFileSync(join(w.main, 'supabase', 'functions', '.env'), 'utf8'),
    mainEnv,
  );
  assert.equal(history().at(-1).status, 'green');
  // hard rule 7: the token is never logged or recorded
  assert.ok(!w.logs.join('\n').includes(TOKEN), 'not in the log');
  assert.ok(!nightlyText().includes(TOKEN), 'not under the nightly dir');
  assert.ok(
    !w.calls.some((c) => c.line.includes(TOKEN)),
    'not on a command line',
  );

  const bad = {
    'no file': null,
    'no TELEGRAM_BOT_TOKEN line': 'OTHER=1\n',
    'an empty value': 'TELEGRAM_BOT_TOKEN=\nOTHER=1\n',
  };
  for (const [name, env] of Object.entries(bad)) {
    const t = world({ mainEnv: env });
    await runNightly(t.io);
    const last = history().at(-1);
    assert.equal(last.status, 'error', name);
    assert.equal(last.reason, 'token-missing', name);
    assert.equal(last.reachedPlaywright, false, name);
    assert.deepEqual(
      t.writes.filter((p) => p.endsWith(join('functions', '.env'))),
      [],
      `${name}: no .env written`,
    );
    assert.equal(
      t.calls.some((c) => /playwright|stack-preflight|db:reset/.test(c.line)),
      false,
      `${name}: nothing downstream ran`,
    );
    assert.equal(existsSync(t.lock), false, `${name}: lock released`);
  }
});

test('N-4 tokenOf returns the non-empty TELEGRAM_BOT_TOKEN value, else null', () => {
  assert.equal(tokenOf('TELEGRAM_BOT_TOKEN=abc123\n'), 'abc123');
  assert.equal(tokenOf('A=1\nTELEGRAM_BOT_TOKEN=abc123\nB=2\n'), 'abc123');
  assert.equal(tokenOf(''), null);
  assert.equal(tokenOf('A=1\n'), null);
  assert.equal(tokenOf('TELEGRAM_BOT_TOKEN=\n'), null);
  assert.equal(tokenOf('TELEGRAM_BOT_TOKEN='), null);
});

// ------------------------------------------------------------------- N-5

test('N-5 history keeps the newest 60 lines with exactly the 2.4 keys; latest.json adds redTests; orphan report files are deleted', async () => {
  const w = world();
  const seeded = Array.from({ length: 65 }, (_, i) => ({
    v: 1,
    sha: `s${i}`.padEnd(40, '0'),
    ranAt: iso(NOW - (100 - i) * H),
    endedAt: iso(NOW - (100 - i) * H + 1000),
    ms: 1000,
    trigger: 'scheduled',
    status: 'green',
    reason: null,
    reachedPlaywright: true,
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
    redSpecs: [],
    flakySpecs: [],
    report: `s${i}-2026-01-01.json`,
    finalReset: 'pass',
  }));
  writeFileSync(
    join(NIGHTLY, 'history.jsonl'),
    seeded.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  for (const l of seeded) writeFileSync(join(NIGHTLY, l.report), '{}');
  writeFileSync(join(NIGHTLY, 'deadbeef0000-2020-01-01.json'), '{}');

  await runNightly(w.io);

  const got = history();
  assert.equal(got.length, 60);
  assert.deepEqual(
    got.slice(0, 59).map((l) => l.sha),
    seeded.slice(6).map((l) => l.sha),
  );
  const mine = got.at(-1);
  assert.deepEqual(Object.keys(mine).sort(), KEYS);
  assert.equal(mine.v, 1);
  assert.equal(mine.sha, SHA);
  assert.equal(mine.trigger, 'scheduled');
  assert.equal(mine.status, 'green');
  assert.equal(mine.reason, null);
  assert.equal(mine.reachedPlaywright, true);
  assert.deepEqual(mine.stats, {
    expected: 4,
    unexpected: 0,
    flaky: 0,
    skipped: 1,
  });
  assert.deepEqual(mine.redSpecs, []);
  assert.deepEqual(mine.flakySpecs, []);
  assert.equal(mine.finalReset, 'pass');
  assert.equal(Date.parse(mine.ranAt), NOW);
  assert.ok(Date.parse(mine.endedAt) >= Date.parse(mine.ranAt));
  assert.equal(typeof mine.ms, 'number');

  // the report file: { playwright, navigation: [] } named <sha12>-<date>.json
  const name = mine.report.split(sep).at(-1);
  assert.match(name, new RegExp(`^${SHA12}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
  const rep = JSON.parse(readFileSync(join(NIGHTLY, name), 'utf8'));
  assert.deepEqual(Object.keys(rep).sort(), ['navigation', 'playwright']);
  assert.deepEqual(rep.navigation, []);
  assert.equal(rep.playwright.stats.expected, 4);

  // kept lines keep their reports; dropped lines' and orphan reports go
  assert.ok(existsSync(join(NIGHTLY, seeded[10].report)));
  assert.ok(existsSync(join(NIGHTLY, seeded[64].report)));
  for (const i of [0, 5])
    assert.equal(
      existsSync(join(NIGHTLY, seeded[i].report)),
      false,
      `dropped line ${i}`,
    );
  assert.equal(
    existsSync(join(NIGHTLY, 'deadbeef0000-2020-01-01.json')),
    false,
    'orphan',
  );
  assert.ok(existsSync(join(NIGHTLY, 'history.jsonl')));

  const latest = JSON.parse(readFileSync(join(NIGHTLY, 'latest.json'), 'utf8'));
  assert.deepEqual(Object.keys(latest).sort(), [...KEYS, 'redTests'].sort());
  assert.deepEqual(latest.redTests, []);
  assert.equal(latest.sha, SHA);
});

test('N-5 a red run records redSpecs and latest.json redTests with file, title, project and a capped error', async () => {
  const w = world({ report: 'red', pwCode: 1 });
  await runNightly(w.io);
  const mine = history().at(-1);
  assert.equal(mine.status, 'red');
  assert.equal(mine.reason, 'failed');
  assert.equal(mine.reachedPlaywright, true);
  assert.deepEqual(mine.redSpecs, ['auth.spec.ts']);
  assert.equal(mine.stats.unexpected, 1);
  const latest = JSON.parse(readFileSync(join(NIGHTLY, 'latest.json'), 'utf8'));
  assert.equal(latest.redTests.length, 1);
  const t = latest.redTests[0];
  assert.deepEqual(Object.keys(t).sort(), [
    'error',
    'file',
    'project',
    'title',
  ]);
  assert.equal(t.file, 'auth.spec.ts');
  assert.equal(t.project, 'chromium');
  assert.match(t.error, /Expected: 5/);
  assert.ok(t.error.length <= 2000);
  assert.equal(mine.finalReset, 'pass');
});

// ------------------------------------------------------------------- N-6

const seedLine = (over) => ({
  v: 1,
  sha: SHA,
  ranAt: iso(NOW - 3 * H),
  endedAt: iso(NOW - 2 * H),
  ms: 1000,
  trigger: 'scheduled',
  status: 'green',
  reason: null,
  reachedPlaywright: true,
  stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
  redSpecs: [],
  flakySpecs: [],
  report: 'old.json',
  finalReset: 'pass',
  ...over,
});
const seedHistory = (...lines) =>
  writeFileSync(
    join(NIGHTLY, 'history.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );

test('N-6 same sha recorded under 24 h ago: no record, exit 0 (N-R3)', async () => {
  const w = world();
  seedHistory(seedLine({}));
  const before = readFileSync(join(NIGHTLY, 'history.jsonl'), 'utf8');
  await runNightly(w.io);
  assert.equal(
    readFileSync(join(NIGHTLY, 'history.jsonl'), 'utf8'),
    before,
    'no new record',
  );
  assert.equal(
    w.calls.some((c) => /worktree|playwright|install/.test(c.line)),
    false,
    'nothing ran after the up-to-date check',
  );
  assert.equal(existsSync(w.lock), false, 'lock released');

  // not up to date: the last run of that sha never reached Playwright, or is 25 h old
  for (const over of [
    {
      reachedPlaywright: false,
      status: 'error',
      reason: 'cut-short',
      stats: null,
    },
    { ranAt: iso(NOW - 25 * H) },
  ]) {
    const x = world();
    seedHistory(seedLine(over));
    await runNightly(x.io);
    assert.equal(history().length, 2, JSON.stringify(over));
    assert.ok(x.calls.some((c) => c.line.includes('playwright test')));
  }
  // a different sha is a new run
  const y = world();
  seedHistory(seedLine({ sha: 'f'.repeat(40) }));
  await runNightly(y.io);
  assert.equal(history().length, 2);
});

test('N-6 --now ignores the idle rule but not a live holder', async () => {
  const idleRelease = (w) =>
    writeFileSync(
      `${w.lock}.released.json`,
      JSON.stringify({
        v: 1,
        lastReleasedAt: iso(NOW - 10 * MIN),
        owner: 'verify:ticket',
        pid: 1,
        stale: false,
      }),
    );
  const stop = (w) => async (ms) => {
    w.sleeps.push(ms);
    throw new Error('test: would wait');
  };

  const forced = world({ sleep: stop });
  idleRelease(forced);
  await runNightly(forced.io, { now: true });
  assert.ok(
    forced.calls.some((c) => c.line.includes('playwright test')),
    'ran at once',
  );
  assert.deepEqual(forced.sleeps, []);

  const normal = world({ sleep: stop });
  idleRelease(normal);
  await runNightly(normal.io).catch(() => {});
  assert.deepEqual(
    normal.sleeps,
    [RETRY_MS],
    'without --now it waits out the idle hour',
  );
  assert.equal(
    normal.calls.some((c) => c.line.includes('playwright test')),
    false,
  );

  const held = world({ sleep: stop });
  const holder = heldBy(held.lock);
  await runNightly(held.io, { now: true }).catch(() => {});
  assert.equal(
    held.calls.some((c) => c.line.includes('playwright test')),
    false,
    'a live holder is never overridden',
  );
  assert.equal(history().length, 0, 'no record written for an aborted --now');
  assert.equal(
    JSON.parse(readFileSync(join(held.lock, 'owner.json'), 'utf8')).id,
    holder.id,
  );
});
