// ER-1..ER-5: the gate's own e2e run lines (e2e-runs.jsonl) and the forced-full share the nightly
// status prints as move-to-ci 2.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  E2E_RUNS_FILE,
  appendE2eRun,
  e2eRunOf,
  forcedShare,
  readE2eRuns,
} from '../../nightly/e2e-runs.mjs';
import { recordE2eRun } from '../../nightly/gate.mjs';
import { statusLines } from '../../nightly/status.mjs';

const H = 3_600_000;
const DAY = 24 * H;
const NOW = Date.parse('2026-01-15T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'e2e-runs-'));
  dirs.push(d);
  return d;
};

test('ER-1 e2eRunOf takes the nightly step\'s pass or fail result that carries a mode', () => {
  const ranAt = iso(NOW);
  const pass = { id: 'e2e', status: 'pass', ms: 90, mode: 'full', why: 'nightly red' };
  assert.deepEqual(e2eRunOf([pass], 'e2e', ranAt), {
    ranAt,
    ms: 90,
    mode: 'full',
    why: 'nightly red',
  });
  assert.deepEqual(
    e2eRunOf([{ id: 'e2e', status: 'fail', ms: 5, mode: 'affected' }], 'e2e', ranAt),
    { ranAt, ms: 5, mode: 'affected', why: null },
    'a fail counts; a missing why is null',
  );
  for (const status of ['skip', 'reuse'])
    assert.equal(e2eRunOf([{ ...pass, status }], 'e2e', ranAt), null, status);
  const { mode: _m, ...modeless } = pass;
  assert.equal(e2eRunOf([modeless], 'e2e', ranAt), null, 'no mode');
  assert.equal(e2eRunOf([{ ...pass, id: 'other' }], 'e2e', ranAt), null, 'other id');
  assert.equal(e2eRunOf([], 'e2e', ranAt), null, 'no results');
});

test('ER-2 appendE2eRun appends one JSON line, keeps the newest max lines; readE2eRuns is [] for a missing file and skips a bad line', () => {
  const dir = join(tmp(), 'nested');
  assert.deepEqual(readE2eRuns(dir), [], 'missing file');
  const mk = (n) => ({ ranAt: iso(NOW + n), ms: n, mode: 'affected', why: null });
  appendE2eRun(dir, mk(1));
  appendE2eRun(dir, mk(2));
  const text = readFileSync(join(dir, E2E_RUNS_FILE), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 2, 'one JSON line per run');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(readE2eRuns(dir), [mk(1), mk(2)]);
  appendE2eRun(dir, mk(3), 2);
  assert.deepEqual(readE2eRuns(dir), [mk(2), mk(3)], 'the newest max lines, in order');
  appendE2eRun(dir, mk(4), 1);
  assert.deepEqual(readE2eRuns(dir), [mk(4)]);
  writeFileSync(
    join(dir, E2E_RUNS_FILE),
    `${JSON.stringify(mk(5))}\nnot json\n\n${JSON.stringify(mk(6))}\n`,
  );
  assert.deepEqual(readE2eRuns(dir), [mk(5), mk(6)], 'a bad line is skipped');
  appendE2eRun(dir, mk(7), 2);
  assert.deepEqual(readE2eRuns(dir), [mk(6), mk(7)], 'the rewrite drops the bad line');
});

test('ER-3 forcedShare counts full runs forced by the nightly over 14 days', () => {
  const run = (ago, ms, mode, why) => ({ ranAt: iso(NOW - ago), ms, mode, why });
  assert.deepEqual(forcedShare([], NOW), { share: null, totalMs: 0 });
  const runs = [
    run(DAY, H, 'full', 'nightly red'),
    run(2 * DAY, H, 'full', '--e2e=full'),
    run(3 * DAY, H, 'full', 'apps/web/playwright.config.ts: full trigger'),
    run(4 * DAY, H, 'affected', null),
  ];
  assert.deepEqual(forcedShare(runs, NOW), { share: 0.25, totalMs: 4 * H });
  for (const why of ['nightly error', 'nightly missing', 'nightly stale'])
    assert.equal(forcedShare([run(DAY, H, 'full', why)], NOW).share, 1, why);
  assert.equal(
    forcedShare([run(DAY, H, 'affected', 'nightly red')], NOW).share,
    0,
    'forced only counts a full run',
  );
  const edge = [run(14 * DAY, H, 'full', 'nightly red'), run(DAY, H, 'affected', null)];
  assert.deepEqual(forcedShare(edge, NOW), { share: 0.5, totalMs: 2 * H }, 'exactly 14 days is in');
  const old = [run(14 * DAY + 1, H, 'full', 'nightly red'), run(DAY, H, 'affected', null)];
  assert.deepEqual(forcedShare(old, NOW), { share: 0, totalMs: H }, '14 days and 1 ms is out');
  assert.deepEqual(
    forcedShare([run(14 * DAY + 1, H, 'full', 'nightly red')], NOW),
    { share: null, totalMs: 0 },
    'only old runs',
  );
  assert.deepEqual(
    forcedShare([{ ranAt: iso(NOW), mode: 'full', why: 'nightly red' }], NOW),
    { share: null, totalMs: 0 },
    'a run without ms is not counted',
  );
});

test('ER-4 move-to-ci 2 prints the share against 25%: 26% MET, 25% not met, no runs n/a', () => {
  const two = (e2eRuns, queued = 0) =>
    statusLines({ latest: null, history: [], queued, e2eRuns }, NOW, () => '').find((l) =>
      l.startsWith('move-to-ci 2:'),
    );
  const runs = (forcedMs) => [
    { ranAt: iso(NOW - DAY), ms: forcedMs, mode: 'full', why: 'nightly red' },
    { ranAt: iso(NOW - DAY), ms: H - forcedMs, mode: 'affected', why: null },
  ];
  assert.equal(
    two(runs(0.26 * H)),
    'move-to-ci 2: forced-full share 26% of 1.0 h in 14 days, queued branches 0 (MET; move at over 25% or 3 or more)',
  );
  assert.equal(
    two(runs(0.25 * H)),
    'move-to-ci 2: forced-full share 25% of 1.0 h in 14 days, queued branches 0 (not met; move at over 25% or 3 or more)',
  );
  assert.equal(
    two([]),
    'move-to-ci 2: forced-full share n/a (no gate e2e runs in 14 days), queued branches 0 (not met; move at over 25% or 3 or more)',
  );
  assert.match(two([], 3), /queued branches 3 \(MET;/, 'three queued branches still trigger');
});

test('ER-5 recordE2eRun appends to <dir>/e2e-runs.jsonl only when the gate has nightly', () => {
  const dir = tmp();
  const results = [{ id: 'e2e', status: 'pass', ms: 1800000, mode: 'full', why: 'nightly red' }];
  const ranAt = iso(NOW);
  const file = join(dir, E2E_RUNS_FILE);

  assert.equal(recordE2eRun({ gate: {}, results, id: 'e2e', ranAt, dir }), null);
  assert.equal(recordE2eRun({ gate: undefined, results, id: 'e2e', ranAt, dir }), null);
  assert.deepEqual(readE2eRuns(dir), [], 'no nightly key writes nothing');
  assert.equal(existsSync(file), false);

  const gate = { nightly: {} };
  const line = recordE2eRun({ gate, results, id: 'e2e', ranAt, dir });
  assert.deepEqual(line, { ranAt, ms: 1800000, mode: 'full', why: 'nightly red' });
  assert.deepEqual(readE2eRuns(dir), [line]);
  assert.equal(recordE2eRun({ gate, results: [{ id: 'e2e', status: 'skip' }], id: 'e2e', ranAt, dir }), null);
  assert.equal(readE2eRuns(dir).length, 1);
});
