// NS-M1..NS-M4 (the mutations status line).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  H,
  NOW,
  iso,
  line,
  cliRepo,
  cli,
  nightlyDir,
} from './__tests__/status-helpers.mjs';
import { statusLines } from './__tests__/bound.mjs';
import { mutationSeed, rotationDays } from '../../mutations/rotation-status.mjs';

const phase = (over = {}) => ({
  status: 'ran',
  reason: null,
  stoppedBy: 'done',
  ms: 1000,
  live: 30,
  ran: 10,
  killed: 7,
  survived: 1,
  error: 2,
  oldestProofDays: 4,
  unproven: 0,
  survivors: [],
  ...over,
});
const night = (daysAgo, mutations) =>
  line({ ranAt: iso(NOW - daysAgo * 24 * H), mutations });
const nightsOf = (mutations) => [0, 1, 2].map((d) => night(d, mutations));
const mlines = (latestMutations, hist, git = () => '') => {
  const latest = line({ mutations: latestMutations });
  return statusLines({ latest, history: hist, queued: 0 }, NOW, git);
};

test('NS-M1 statusLines prints the mutations line with counts, oldest proof and rotation', () => {
  const ph = phase();
  const out = mlines(ph, nightsOf(ph));
  assert.equal(
    out.at(-1),
    'mutations: 7 killed, 1 survived, 2 error; oldest proof 4 days; rotation 3 days',
  );
  assert.match(out[0], /^green /, 'line [0] is still the headline');

  const unproven = phase({ oldestProofDays: null, unproven: 3 });
  assert.equal(
    mlines(unproven, nightsOf(unproven)).at(-1),
    'mutations: 7 killed, 1 survived, 2 error; oldest proof never; rotation 3 days (3 unproven)',
  );

  assert.match(
    mlines(ph, []).at(-1),
    /; rotation n\/a$/,
    'no phase nights: rotation n/a',
  );

  const skipped = phase({ status: 'skipped', reason: 'catch-up', ran: 0 });
  assert.match(mlines(skipped, []).at(-1), /\[phase skipped: catch-up\]$/);

  const none = statusLines(
    { latest: line(), history: [line()], queued: 0 },
    NOW,
    () => '',
  );
  assert.equal(none.filter((l) => l.startsWith('mutations:')).length, 0);
  const nul = mlines(null, []);
  assert.equal(nul.filter((l) => l.startsWith('mutations:')).length, 0);
});

test('NS-M2 a rotation over 14 days prints the WARN suffix, exactly 14 does not', () => {
  const over = phase({ live: 150 });
  assert.equal(rotationDays(nightsOf(over), NOW), 15);
  assert.match(
    mlines(over, nightsOf(over)).at(-1),
    /rotation 15 days WARN: rotation over 14 days; raise TICKET_GATE_NIGHTLY_MUTATION_MIN or take the Move-to-CI trigger$/,
  );
  const exact = phase({ live: 140 });
  assert.equal(rotationDays(nightsOf(exact), NOW), 14);
  const l = mlines(exact, nightsOf(exact)).at(-1);
  assert.match(l, /rotation 14 days$/);
  assert.doesNotMatch(l, /WARN/);
});

test('NS-M3 a survivor seeds fix/mutations-<date> with merges touching file or testFile first', () => {
  const survivor = {
    key: 'INFRA-28/M2',
    file: 'tools/nightly-e2e.mjs',
    testFile: 'tools/nightly-e2e.test.mjs',
    lastKillSha: 'b'.repeat(40),
  };
  const sha = 'a'.repeat(40);
  const m1 = '1'.repeat(40);
  const m2 = '2'.repeat(40);
  const m3 = '3'.repeat(40);
  const calls = [];
  const git = (...args) => {
    calls.push(args.join(' '));
    if (args[0] === 'log')
      return `${m1}\tMerge one\n${m2}\tMerge two\n${m3}\tMerge three\n`;
    if (args[1] === '--name-only')
      return args[3] === m2
        ? 'tools/nightly-e2e.test.mjs\nREADME.md\n'
        : 'apps/web/x.ts\n';
    return '';
  };
  const seed = mutationSeed({ survivor, sha, git });
  assert.deepEqual(
    seed.merges.map((m) => [m.sha, m.suspect]),
    [
      [m2, true],
      [m1, false],
      [m3, false],
    ],
  );
  assert.ok(
    calls[0].includes(`${survivor.lastKillSha}..${sha}`),
    'range from the last kill',
  );

  const ph = phase({ survivors: [survivor] });
  const out = mlines(ph, nightsOf(ph), git);
  const day = new Date(NOW).toLocaleDateString('en-CA');
  const at = out.indexOf(
    'mutation survivor: INFRA-28/M2 (tools/nightly-e2e.test.mjs)',
  );
  assert.ok(at > 0);
  assert.equal(
    out[at + 1],
    `fix seed: merges since last kill ${'b'.repeat(12)} (suspects first)`,
  );
  assert.deepEqual(out.slice(at + 2, at + 5), [
    `  * ${'2'.repeat(12)} Merge two`,
    `    ${'1'.repeat(12)} Merge one`,
    `    ${'3'.repeat(12)} Merge three`,
  ]);
  assert.equal(
    out.filter((l) => l.includes('next: branch fix/mutations-')).length,
    1,
  );
  assert.equal(
    out.at(-1),
    `  next: branch fix/mutations-${day} seeded from the lines above`,
  );

  // no kill on record: the newest 20 merges
  calls.length = 0;
  const fresh = mlines(
    phase({ survivors: [{ ...survivor, lastKillSha: null }] }),
    [],
    git,
  );
  assert.ok(
    fresh.some((l) =>
      l.startsWith('fix seed: no kill on record; the newest 20'),
    ),
  );
  assert.ok(calls[0].includes('-n 20'));

  // a git failure is reported, not thrown
  const boom = mlines(ph, [], () => {
    throw new Error('no git');
  });
  assert.ok(boom.includes('mutation fix seed unavailable: no git'));
});

test('NS-M4 the exit code ignores the mutation phase', () => {
  const repo = cliRepo();
  const survived = phase({
    survived: 3,
    survivors: [
      { key: 'A/M1', file: 'x.mjs', testFile: 'x.test.mjs', lastKillSha: null },
    ],
  });
  const green = cli(repo, nightlyDir(repo, { mutations: survived }));
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /mutation survivor: A\/M1/);
  const red = cli(
    repo,
    nightlyDir(repo, {
      status: 'red',
      reason: 'failed',
      stats: { expected: 4, unexpected: 1, flaky: 0, skipped: 1 },
      redSpecs: ['auth.spec.ts'],
      mutations: phase(),
    }),
  );
  assert.equal(red.status, 1, red.stderr);
});
