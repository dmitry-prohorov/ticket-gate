// INFRA-57 OG-1..OG-11 (contracts/INFRA-57.md section 5): the pure grouping
// and attribution functions (4.7a) and the lifecycle, proven on a synthetic
// grouped harness (the org fixture). No platform names in any expectation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  marker,
  ORG_FILES,
  orgEntry,
  orgWorld,
} from './__tests__/org-harness.fixture.mjs';
import { attribute, disjointGroups } from '../../mutations/harness.mjs';
import { interruptHandler, runMutations } from '../../mutations/run.mjs';

// ---- pure helpers -------------------------------------------------------
const ent = (id) => ({ id, kind: 'patch', file: 'x' });
const span = (file, start, end) => ({ file, start, end });
/** disjointGroups over { id, tests, cover?, span?, none? } rows; returns the groups. */
function groupsOf(rows) {
  const by = new Map(rows.map((r) => [r.id, r]));
  return disjointGroups(
    rows.map((r) => ent(r.id)),
    (e) => by.get(e.id).tests ?? null,
    (e) => {
      const r = by.get(e.id);
      return r.none
        ? null
        : { cover: r.cover ?? [], span: r.span ?? span(`f-${r.id}`, 1, 1) };
    },
  );
}
const ids = (groups) => groups.map((g) => g.entries.map((e) => e.id));
const member = (id, tests, file, start, end) => ({
  entry: ent(id),
  tests,
  cover: [],
  span: span(file, start, end),
});
const grp = (...members) => ({
  key: members[0].entry.id,
  entries: members.map((m) => m.entry),
  members,
});
const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r]));

// ---- disjointGroups -----------------------------------------------------
test('OG-2 overlapping tests split a group', () => {
  // e2 shares t1 with e1; e3 is disjoint from both and joins the first group (first fit).
  assert.deepEqual(
    ids(
      groupsOf([
        { id: 'e1', tests: ['t1'] },
        { id: 'e2', tests: ['t1', 't2'] },
        { id: 'e3', tests: ['t3'] },
      ]),
    ),
    [['e1', 'e3'], ['e2']],
  );
  // Disjoint, non-covering entries share one group.
  assert.deepEqual(
    ids(
      groupsOf([
        { id: 'e1', tests: ['t1'] },
        { id: 'e2', tests: ['t2'] },
      ]),
    ),
    [['e1', 'e2']],
  );
  // The group key is its first member's id.
  assert.deepEqual(
    groupsOf([
      { id: 'e9', tests: ['t1'] },
      { id: 'e8', tests: ['t1'] },
    ]).map((g) => g.key),
    ['e9', 'e8'],
  );
});

test('OG-3 a test of one member covering another site splits a group', () => {
  // Tests are disjoint; only the cross-coverage differs. Both directions.
  assert.deepEqual(
    ids(
      groupsOf([
        { id: 'e1', tests: ['t1'], cover: ['t1', 't2'] },
        { id: 'e2', tests: ['t2'], cover: ['t2'] },
      ]),
    ),
    [['e1'], ['e2']],
  );
  assert.deepEqual(
    ids(
      groupsOf([
        { id: 'e1', tests: ['t1'], cover: ['t1'] },
        { id: 'e2', tests: ['t2'], cover: ['t2', 't1'] },
      ]),
    ),
    [['e1'], ['e2']],
  );
  // Control: each site is covered only by its own test.
  assert.deepEqual(
    ids(
      groupsOf([
        { id: 'e1', tests: ['t1'], cover: ['t1'] },
        { id: 'e2', tests: ['t2'], cover: ['t2'] },
      ]),
    ),
    [['e1', 'e2']],
  );
});

test('OG-4 same-file patches share a group unless their spans overlap', () => {
  const two = (a, b) =>
    ids(
      groupsOf([
        { id: 'e1', tests: ['t1'], span: a },
        { id: 'e2', tests: ['t2'], span: b },
      ]),
    );
  // Same file, apart: share.
  assert.deepEqual(two(span('a.js', 1, 3), span('a.js', 4, 6)), [['e1', 'e2']]);
  // Same file, spans touch on a line (1-based inclusive): split, both orders.
  assert.deepEqual(two(span('a.js', 1, 3), span('a.js', 3, 5)), [
    ['e1'],
    ['e2'],
  ]);
  assert.deepEqual(two(span('a.js', 3, 5), span('a.js', 1, 3)), [
    ['e1'],
    ['e2'],
  ]);
  // One span inside the other: split.
  assert.deepEqual(two(span('a.js', 1, 9), span('a.js', 4, 5)), [
    ['e1'],
    ['e2'],
  ]);
  // Same lines in another file: share.
  assert.deepEqual(two(span('a.js', 1, 3), span('b.js', 1, 3)), [['e1', 'e2']]);
});

test('OG-5 a missing coverage line goes solo', () => {
  const g = groupsOf([
    { id: 'e2', tests: ['t2'], none: true },
    { id: 'e1', tests: ['t1'] },
    { id: 'e3', tests: ['t3'] },
  ]);
  assert.deepEqual(ids(g), [['e2'], ['e1', 'e3']]);
  assert.equal(g[0].solo, 'no coverage');
  assert.equal(g[1].solo, undefined);
  // Unparsable tests are solo too, with their own reason.
  const u = groupsOf([
    { id: 'e1', tests: null },
    { id: 'e2', tests: ['t2'] },
  ]);
  assert.deepEqual(ids(u), [['e1'], ['e2']]);
  assert.equal(u[0].solo, 'tests unparsable');
});

// ---- attribute ----------------------------------------------------------
test('OG-6 a compile error maps to one member or falls back to solo', () => {
  const m1 = member('e1', ['t1'], 'a.js', 1, 3);
  const m2 = member('e2', ['t2'], 'b.js', 1, 2);
  const m3 = member('e3', ['t3'], 'a.js', 5, 7);
  const g = grp(m1, m2, m3);
  const at = (file, line) =>
    attribute(g, {
      rows: [],
      complete: true,
      compile: { file, line, message: 'TS2304' },
    });

  const hit = at('a.js', 3); // the last line of m1's span still holds it
  assert.equal(hit.solo, undefined);
  assert.equal(hit.results.length, 1);
  assert.equal(hit.results[0].id, 'e1');
  assert.equal(hit.results[0].status, 'error');
  assert.equal(hit.results[0].detail, 'compile: TS2304');
  assert.deepEqual(
    hit.redeploy.map((m) => m.entry.id),
    ['e2', 'e3'],
  );
  assert.equal(at('a.js', 5).results[0].id, 'e3');

  // No member holds the line: not attributable.
  assert.deepEqual(at('a.js', 4), { solo: 'compile error not attributable' });
  assert.deepEqual(at('c.js', 1), { solo: 'compile error not attributable' });
  // Two members hold it (spans that disjointGroups would never group).
  const clash = grp(
    member('e1', ['t1'], 'a.js', 1, 5),
    member('e2', ['t2'], 'a.js', 3, 7),
  );
  assert.deepEqual(
    attribute(clash, {
      rows: [],
      complete: true,
      compile: { file: 'a.js', line: 4, message: 'm' },
    }),
    { solo: 'compile error not attributable' },
  );
});

test('OG-7 a row owned by no member falls back to solo', () => {
  const g = grp(
    member('e1', ['t1'], 'a.js', 1, 3),
    member('e2', ['t2'], 'b.js', 1, 2),
  );
  assert.deepEqual(
    attribute(g, {
      rows: [
        { test: 't1', outcome: 'pass' },
        { test: 'ghost', outcome: 'fail' },
      ],
      complete: true,
    }),
    { solo: 'row owned by no member: ghost' },
  );
  // Only failing rows need an owner.
  const ok = attribute(g, {
    rows: [
      { test: 't1', outcome: 'fail' },
      { test: 't2', outcome: 'pass' },
      { test: 'ghost', outcome: 'pass' },
    ],
    complete: true,
  });
  assert.equal(ok.solo, undefined);
});

test('OG-8 a cut-short run falls back to solo', () => {
  const g = grp(member('e1', ['t1'], 'a.js', 1, 3));
  const rows = [{ test: 't1', outcome: 'fail' }];
  assert.deepEqual(attribute(g, { rows, complete: false }), {
    solo: 'run cut short',
  });
  // The cut check comes before the compile mapping.
  assert.deepEqual(
    attribute(g, {
      rows: [],
      complete: false,
      compile: { file: 'a.js', line: 1, message: 'm' },
    }),
    { solo: 'run cut short' },
  );
  assert.equal(attribute(g, { rows, complete: true }).solo, undefined);
});

test('OG-8 a cut-short group is re-run member by member (fixture end to end)', async () => {
  const e1 = orgEntry('E1', 'org/a.js', 'a1');
  const e2 = orgEntry('E2', 'org/b.js', 'b1');
  const w = orgWorld({
    tests: { E1: ['t1'], E2: ['t2'] },
    cover: {
      E1: { cover: [], span: { file: 'org/a.js', start: 1, end: 1 } },
      E2: { cover: [], span: { file: 'org/b.js', start: 1, end: 1 } },
    },
    fails: { t2: [marker('E2')] },
    cut: [marker('E1')],
  });
  const r = await runMutations({ mutations: [e1, e2] }, w.io, w.setup);
  const res = byId(r.results);
  assert.equal(res.E1.status, 'error');
  assert.match(res.E1.detail, /run cut short/);
  assert.equal(res.E2.status, 'killed');
  assert.deepEqual(Object.fromEntries(w.files), ORG_FILES);
});

test('OG-9 an entry is killed when any own test fails', () => {
  const g = grp(
    member('e1', ['t1', 't2'], 'a.js', 1, 3),
    member('e2', ['t3', 't4'], 'b.js', 1, 2),
    member('e3', ['t5'], 'c.js', 1, 2),
  );
  const { results } = attribute(g, {
    rows: [
      { test: 't1', outcome: 'pass' },
      { test: 't2', outcome: 'fail' },
      { test: 't3', outcome: 'pass' },
      { test: 't4', outcome: 'pass' },
    ],
    complete: true,
  });
  const r = byId(results);
  assert.equal(results.length, 3);
  assert.equal(r.e1.status, 'killed', 'one fail among own passing rows kills');
  assert.equal(r.e2.status, 'survived', 'all own rows pass');
  assert.equal(r.e3.status, 'error', 'no own rows');
  assert.match(r.e3.detail, /no rows/);
  // A fail listed first kills too.
  const first = attribute(g, {
    rows: [
      { test: 't2', outcome: 'fail' },
      { test: 't1', outcome: 'pass' },
    ],
    complete: true,
  });
  assert.equal(byId(first.results).e1.status, 'killed');
});

// ---- lifecycle on the org fixture ---------------------------------------
const cov = (file, start = 1, end = 1) => ({
  cover: [],
  span: { file, start, end },
});

test('OG-1 group runs after open and reads its facts', async () => {
  const entries = [
    orgEntry('E1', 'org/a.js', 'a1'),
    orgEntry('E2', 'org/b.js', 'b1'),
  ];
  const w = orgWorld({
    tests: { E1: ['t1'], E2: ['t2'] },
    cover: { E1: cov('org/a.js'), E2: cov('org/b.js') },
    fails: { t1: [marker('E1')], t2: [marker('E2')] },
  });
  const r = await runMutations({ mutations: entries }, w.io, w.setup);
  assert.deepEqual(w.log, ['open', 'group', 'run', 'close']);
  assert.ok(
    w.seen.facts,
    'group() was called without the facts open() returned',
  );
  assert.equal(w.seen.facts, w.facts);
  assert.deepEqual(w.seen.ready, ['E1', 'E2']);
  assert.deepEqual(
    r.results.map((x) => [x.id, x.status]),
    [
      ['E1', 'killed'],
      ['E2', 'killed'],
    ],
  );
});

test('OG-1 an entry whose baseline is red is not offered to group', async () => {
  const entries = [
    orgEntry('E1', 'org/a.js', 'a1'),
    orgEntry('E2', 'org/b.js', 'b1', { test: 'org-red' }),
  ];
  const w = orgWorld({
    tests: { E1: ['t1'], E2: ['t2'] },
    cover: { E1: cov('org/a.js'), E2: cov('org/b.js') },
    fails: { t1: [marker('E1')] },
    red: ['org-red'],
  });
  const r = await runMutations({ mutations: entries }, w.io, w.setup);
  assert.deepEqual(w.seen.ready, ['E1']);
  const res = byId(r.results);
  assert.equal(res.E2.status, 'error');
  assert.match(res.E2.detail, /test red before mutation/);
  assert.equal(res.E1.status, 'killed');
});

test('OG-10 G groups cost G + 2 deploys and G + 1 runs', async () => {
  // E1..E3 share t1 (three groups); E4 and E5 are disjoint and join the first.
  const entries = [
    orgEntry('E1', 'org/a.js', 'a1'),
    orgEntry('E2', 'org/a.js', 'a3'),
    orgEntry('E3', 'org/a.js', 'a5'),
    orgEntry('E4', 'org/b.js', 'b1'),
    orgEntry('E5', 'org/c.js', 'c1'),
  ];
  const w = orgWorld({
    tests: { E1: ['t1'], E2: ['t1'], E3: ['t1'], E4: ['t4'], E5: ['t5'] },
    cover: {
      E1: cov('org/a.js', 1, 1),
      E2: cov('org/a.js', 3, 3),
      E3: cov('org/a.js', 5, 5),
      E4: cov('org/b.js'),
      E5: cov('org/c.js'),
    },
    fails: {
      t1: [marker('E1'), marker('E2'), marker('E3')],
      t4: [marker('E4')],
      t5: [marker('E5')],
    },
  });
  const r = await runMutations({ mutations: entries }, w.io, w.setup);
  assert.equal(w.counts.deploys, 5, 'open + 3 groups + close');
  assert.equal(w.counts.runs, 4, 'coverage run + 3 groups');
  assert.equal(r.results.length, 5);
  assert.ok(
    r.results.every((x) => x.status === 'killed'),
    JSON.stringify(r.results),
  );
  assert.deepEqual(Object.fromEntries(r.results.map((x) => [x.id, x.group])), {
    E1: 'E1',
    E2: 'E2',
    E3: 'E3',
    E4: 'E1',
    E5: 'E1',
  });
  assert.deepEqual(Object.fromEntries(w.files), ORG_FILES);
});

test('OG-11 a SIGINT mid-group restores every live patch byte-identical', async () => {
  const entries = [
    orgEntry('E1', 'org/a.js', 'a1'),
    orgEntry('E2', 'org/b.js', 'b1'),
  ];
  const snap = { exits: [] };
  const w = orgWorld({
    tests: { E1: ['t1'], E2: ['t2'] },
    cover: { E1: cov('org/a.js'), E2: cov('org/b.js') },
    fails: { t1: [marker('E1')], t2: [marker('E2')] },
    duringDeploy: async ({ io, state, files, setup }) => {
      if (snap.taken) return;
      snap.taken = true;
      snap.patched = ['org/a.js', 'org/b.js'].map(
        (f) => files.get(f) !== ORG_FILES[f],
      );
      snap.liveBefore = state.live?.size;
      await interruptHandler(
        state,
        io,
        (c) => snap.exits.push(c),
        'SIGINT',
        setup,
      );
      snap.after = Object.fromEntries(files);
      snap.liveAfter = state.live?.size ?? 0;
    },
  });
  await runMutations({ mutations: entries }, w.io, w.setup);
  assert.deepEqual(
    snap.patched,
    [true, true],
    'both files are mutated mid-group',
  );
  assert.equal(snap.liveBefore, 2);
  assert.deepEqual(snap.after, ORG_FILES, 'the handler restored both files');
  assert.equal(snap.liveAfter, 0);
  assert.deepEqual(snap.exits, [130]);
  assert.deepEqual(Object.fromEntries(w.files), ORG_FILES);
});
