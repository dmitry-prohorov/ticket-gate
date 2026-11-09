// EA-1..EA-13 and EA-R1..EA-R3: the assertions ratchet, its receipt checked against the
// mutation registry. Mini repos under os.tmpdir().
// Mutation entries in the registry select tests by the "EA-n " prefix.
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import {
  AREAS,
  areaTotals,
  checkE2eAssertions,
  countSpecs,
} from './__tests__/assertions-bound.mjs';
import {
  entriesDigest,
  entriesFor,
  loadRegistry,
} from '../../mutations/registry.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const E2E = 'apps/web/e2e';
const TICKET = 'T-1';
const AREA_FILE = 'tools/mutation-registry/src.json';

const spec = (areas, n) =>
  `// e2e-areas: ${areas}\n${'expect(a).toBe(1);\n'.repeat(n)}`;

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A repo with specs a (calendar, 3 expects) and b (editor, 2 expects) and its baseline written. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'check-e2e-assertions-'));
  dirs.push(dir);
  put(dir, `${E2E}/a.spec.ts`, spec('calendar', 3));
  put(dir, `${E2E}/b.spec.ts`, spec('editor', 2));
  const r = run(dir, { update: true });
  assert.equal(r.code, 0);
  assert.equal(r.wrote, true);
  return dir;
}

const run = (dir, opts = {}) =>
  checkE2eAssertions(dir, {
    root: dir,
    treeHash: () => 'H',
    receiptPath: join(dir, 'receipt.json'),
    ...opts,
  });

const baselineBytes = (dir) =>
  readFileSync(join(dir, 'tools/e2e-assertions-baseline.json'), 'utf8');

const entry = (over = {}) => ({
  kind: 'patch',
  protects: '5 guard',
  file: 'src/g.ts',
  find: 'return 1;',
  replace: 'return 2;',
  test: 'node --test src/g.test.mjs',
  testFile: 'src/g.test.mjs',
  ...over,
});
const unguardedEntry = (from) => ({
  kind: 'unguarded',
  from,
  title: 'a spec',
  why: 'cannot fail in isolation',
});
const ownEntries = (dir) => entriesFor(loadRegistry(dir), TICKET);

/** Writes registry entries (key -> entry) into the area file. */
function writeRegistry(dir, entries) {
  put(dir, AREA_FILE, `${JSON.stringify(entries, null, 2)}\n`);
}

/** Writes own registry entries and a green receipt for them; `over` patches the receipt. */
function cover(
  dir,
  over = {},
  entries = { [`${TICKET}/M1`]: entry({ from: 'e2e/a.spec.ts' }) },
  other = {},
) {
  writeRegistry(dir, { ...entries, ...other });
  const receipt = {
    ticket: TICKET,
    source: 'registry',
    entriesDigest: entriesDigest(ownEntries(dir)),
    treeHash: 'H',
    partial: false,
    ok: true,
    ...over,
  };
  put(dir, 'receipt.json', JSON.stringify(receipt));
}

/** Drops one expect from a.spec.ts. */
const dropOne = (dir) => put(dir, `${E2E}/a.spec.ts`, spec('calendar', 2));

test('EA-1 a spec loses one expect, no receipt: code 1 with a drop for its area', () => {
  const dir = repo();
  dropOne(dir);
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /calendar expect: was 3, now 2/);
  assert.match(r.lines.join('\n'), /e2e\/a\.spec\.ts/);
});

test('EA-2 a spec gains one expect: code 1 stale; update with no receipt writes it', () => {
  const dir = repo();
  put(dir, `${E2E}/a.spec.ts`, spec('calendar', 4));
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /stale/);
  // The area total itself is reported, not only the per-spec change (M2).
  assert.match(r.lines.join('\n'), /calendar expect: was 3, now 4/);
  const u = run(dir, { update: true });
  assert.equal(u.code, 0);
  assert.equal(u.wrote, true);
  assert.equal(run(dir).code, 0);
});

const uncovered = (dir, why) => {
  dropOne(dir);
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), new RegExp(`why: ${why}`));
};

test('EA-3 drop + receipt ok false: uncovered, receipt not green', () => {
  const dir = repo();
  cover(dir, { ok: false });
  uncovered(dir, 'receipt not green');
});

test('EA-4 drop + receipt partial true: uncovered', () => {
  const dir = repo();
  cover(dir, { partial: true });
  uncovered(dir, 'receipt is partial');
});

test('EA-5 drop + receipt for another tree hash: uncovered', () => {
  const dir = repo();
  cover(dir, { treeHash: 'OTHER' });
  uncovered(dir, 'receipt is for another tree');
});

test('EA-6 drop + receipt from a --file run: uncovered', () => {
  const dir = repo();
  cover(dir, { source: 'file:scratch.json' });
  uncovered(dir, 'receipt is from a --file run');
});

test('EA-7 drop + own registry entry edited after the run: uncovered', () => {
  const dir = repo();
  cover(dir);
  writeRegistry(dir, {
    [`${TICKET}/M1`]: entry({
      from: 'e2e/a.spec.ts',
      find: 'return 1; // re-aimed',
    }),
  });
  uncovered(dir, 'mutations changed');
});

test('EA-8 drop + green receipt, no from for the dropped spec: missing names it', () => {
  const dir = repo();
  cover(dir, {}, { [`${TICKET}/M1`]: entry({ from: 'e2e/other.spec.ts' }) });
  dropOne(dir);
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /missing: e2e\/a\.spec\.ts/);
});

test('EA-9 as EA-8 with an unguarded entry for it: covered', () => {
  const dir = repo();
  cover(dir, {}, { [`${TICKET}/U1`]: unguardedEntry('e2e/a.spec.ts') });
  dropOne(dir);
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /covered by/);
  assert.match(r.lines.join('\n'), /--update/);
});

test('EA-10 spec deleted, green receipt, from names it: code 0, note printed', () => {
  const dir = repo();
  cover(dir);
  unlinkSync(join(dir, `${E2E}/a.spec.ts`));
  const r = run(dir);
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /covered by/);
  assert.equal(run(dir, { update: true }).wrote, true);
});

test('EA-11 drop, update, no receipt: code 1, baseline bytes unchanged', () => {
  const dir = repo();
  const before = baselineBytes(dir);
  dropOne(dir);
  const r = run(dir, { update: true });
  assert.equal(r.code, 1);
  assert.equal(r.wrote, false);
  assert.equal(baselineBytes(dir), before);
});

test('EA-12 counting: expect.poll not counted; two-area spec counts in both; non-spec ignored; every area present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-e2e-assertions-'));
  dirs.push(dir);
  put(
    dir,
    `${E2E}/m.spec.ts`,
    '// e2e-areas: calendar, editor\nexpect(a);\nexpect.poll(b);\nexpect.soft(c);\nawait expectNoSeriousAxe(p);\nawait page.toHaveScreenshot(1);\n',
  );
  put(dir, `${E2E}/helper.ts`, '// e2e-areas: auth\nexpect(a);\n');
  put(dir, `${E2E}/sub/n.spec.ts`, '// e2e-areas: auth\nexpect(a);\n');
  const specs = countSpecs(dir);
  assert.deepEqual(Object.keys(specs), ['m.spec.ts', 'sub/n.spec.ts']);
  assert.deepEqual(specs['m.spec.ts'], {
    areas: 'calendar, editor',
    expect: 1,
    axe: 1,
    screenshot: 1,
  });
  const totals = areaTotals(specs);
  assert.deepEqual(Object.keys(totals), [...AREAS]);
  assert.deepEqual(totals.calendar, { expect: 1, axe: 1, screenshot: 1 });
  assert.deepEqual(totals.editor, { expect: 1, axe: 1, screenshot: 1 });
  assert.deepEqual(totals.auth, { expect: 1, axe: 0, screenshot: 0 });
  assert.deepEqual(totals.legal, { expect: 0, axe: 0, screenshot: 0 });
});

test('unreadable baseline: code 2; equal tree: code 0', () => {
  const dir = repo();
  assert.equal(run(dir).code, 0);
  writeFileSync(join(dir, 'tools/e2e-assertions-baseline.json'), '{nope');
  assert.equal(run(dir).code, 2);
});

test('EA-13 a header that drops an area is a culprit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-e2e-assertions-'));
  dirs.push(dir);
  put(dir, `${E2E}/a.spec.ts`, spec('calendar, family', 10));
  put(dir, `${E2E}/other.spec.ts`, spec('editor', 1));
  assert.equal(run(dir, { update: true }).code, 0);
  cover(dir, {}, { [`${TICKET}/M1`]: entry({ from: 'e2e/other.spec.ts' }) });
  put(dir, `${E2E}/a.spec.ts`, spec('calendar', 10));
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /missing: e2e\/a\.spec\.ts/);
  assert.equal(run(dir, { update: true }).wrote, false);
});

const OTHER = 'U-2/M1';

test('EA-R1 drop + green registry receipt + an own entry whose from names the spec: covered', () => {
  const dir = repo();
  cover(dir);
  dropOne(dir);
  const r = run(dir);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /covered by/);
});

test("EA-R2 another ticket's entry re-aimed in the same area file leaves the receipt covering", () => {
  const dir = repo();
  cover(dir, {}, undefined, {
    [OTHER]: entry({ file: 'src/h.ts', find: 'return 3;' }),
  });
  writeRegistry(dir, {
    [`${TICKET}/M1`]: entry({ from: 'e2e/a.spec.ts' }),
    [OTHER]: entry({ file: 'src/h.ts', find: 'return 3; // re-aimed' }),
  });
  dropOne(dir);
  const r = run(dir);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /covered by/);
});

test('EA-R3 a from that only a retired own entry carries does not cover: missing names the spec', () => {
  const dir = repo();
  cover(
    dir,
    {},
    {
      [`${TICKET}/M1`]: entry({
        from: 'e2e/a.spec.ts',
        retired: { by: TICKET, why: 'superseded per spec' },
      }),
      [`${TICKET}/M2`]: entry({ from: 'e2e/other.spec.ts' }),
    },
  );
  dropOne(dir);
  const r = run(dir);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /missing: e2e\/a\.spec\.ts/);
});
