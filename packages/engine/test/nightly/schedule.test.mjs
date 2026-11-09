// N-1 (decide, triggerFor, deadlineFor).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { H, MIN, local, NOW, iso } from './__tests__/world.mjs';

const { IDLE_MS, RETRY_MS, E2E_LIMIT_S, decide, deadlineFor, triggerFor } =
  await import('../../nightly/schedule.mjs');

test('N-1 decide: live holder -> defer; released 59 min ago -> defer; 61 min ago and free -> start; busy with under 30 min to deadline -> skipped-busy', () => {
  const far = NOW + 5 * H;
  const holder = {
    owner: 'verify:ticket',
    pid: 1,
    id: 'x',
    startedAt: iso(NOW),
  };
  const rel = (minAgo) => ({
    lastReleasedAt: iso(NOW - minAgo * MIN),
    owner: 'verify:ticket',
    pid: 1,
    stale: false,
  });
  const d = (over) =>
    decide({
      holder: null,
      released: null,
      nowMs: NOW,
      deadlineMs: far,
      ...over,
    });
  assert.equal(d({ holder }), 'defer');
  assert.equal(
    d({ released: rel(59) }),
    'defer',
    'idle rule: 59 min is still busy',
  );
  assert.equal(d({ released: rel(61) }), 'start');
  assert.equal(d({ released: rel(60) }), 'start', 'exactly IDLE_MS is idle');
  assert.equal(d({}), 'start', 'no holder, no release on record');
  assert.equal(IDLE_MS, 3_600_000);
  assert.equal(RETRY_MS, 1_800_000);

  // the deadline: a retry must fit before it
  assert.equal(d({ holder, deadlineMs: NOW + 29 * MIN }), 'skipped-busy');
  assert.equal(
    d({ holder, deadlineMs: NOW + 30 * MIN }),
    'defer',
    'exactly RETRY_MS fits',
  );
  assert.equal(
    d({ released: rel(59), deadlineMs: NOW + 20 * MIN }),
    'skipped-busy',
  );
  assert.equal(
    d({ released: rel(61), deadlineMs: NOW + 1 * MIN }),
    'start',
    'a free stack starts even close to the deadline',
  );
});

test('N-1 triggerFor and deadlineFor use the local clock: 00:50-06:00 is scheduled, anything else catch-up', () => {
  assert.equal(triggerFor(local(15, 0, 50)), 'scheduled');
  assert.equal(triggerFor(local(15, 1, 0)), 'scheduled');
  assert.equal(triggerFor(local(15, 5, 59)), 'scheduled');
  assert.equal(triggerFor(local(15, 0, 49)), 'catch-up');
  assert.equal(triggerFor(local(15, 6, 0)), 'catch-up');
  assert.equal(triggerFor(local(15, 12, 0)), 'catch-up');
  assert.equal(deadlineFor('scheduled', local(15, 1, 0)), local(15, 6, 0));
  assert.equal(deadlineFor('catch-up', local(15, 12, 0)), local(16, 0, 30));
  assert.equal(deadlineFor('catch-up', local(15, 0, 10)), local(15, 0, 30));
  assert.equal(E2E_LIMIT_S, 1800);
});
