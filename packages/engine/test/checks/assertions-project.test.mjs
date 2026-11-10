// AP-1..AP-6: the assertions ratchet against a synthetic project that shares nothing with
// the ported tests (other counters, areas, paths and registry directory).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  entriesDigest,
  entriesFor,
  loadRegistry,
} from '../../mutations/registry.mjs';
import { A_FILE, aSpec, cfg, makeProject, put, ratchet, setup } from './__tests__/assertions-project.mjs';

const cleanups = [];
after(() => cleanups.forEach((c) => c()));
function project() {
  const p = makeProject();
  cleanups.push(p.cleanup);
  return p.root;
}

const patchEntry = (from) => ({
  kind: 'patch',
  protects: 'guard',
  file: 'src/g.ts',
  find: 'return 1;',
  replace: 'return 2;',
  test: 'node --test src/g.test.mjs',
  testFile: 'src/g.test.mjs',
  from,
});

function cover(root, entry) {
  put(root, 'registry/src.json', `${JSON.stringify({ 'T-1/M1': entry }, null, 2)}\n`);
  const own = entriesFor(loadRegistry(root, setup), 'T-1');
  put(
    root,
    'out/mutations.json',
    JSON.stringify({
      ticket: 'T-1',
      source: 'registry',
      entriesDigest: entriesDigest(own),
      treeHash: 'H',
      partial: false,
      ok: true,
    }),
  );
}

const drop = (root) => put(root, A_FILE, aSpec(2));
const hashed = { treeHash: () => 'H' };

test('AP-1 a clean synthetic project passes', () => {
  const root = project();
  const r = ratchet.check({ root, args: [] });
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('demo-assertions: 2 specs, 2 areas match the baseline'), r.out.join('\n'));
});

test('AP-2 a drop with no receipt fails, naming the spec', () => {
  const root = project();
  drop(root);
  const r = ratchet.check({ root, args: [] });
  const text = r.lines ? r.lines.join('\n') : [...r.out, ...r.err].join('\n');
  assert.equal(r.code, 1);
  assert.match(text, /billing asserts: was 5, now 4/);
  assert.match(text, /why: no mutation receipt \(out\/mutations\.json\)/);
  assert.match(text, /missing: tests\/a\.test\.ts/);
});

test('AP-3 the same drop passes with a covering from entry', () => {
  const root = project();
  drop(root);
  cover(root, patchEntry('tests/a.test.ts'));
  const r = ratchet.checkE2eAssertions(root, hashed);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /covered by the mutation receipt/);
});

test('AP-4 a green receipt whose from names another spec does not cover', () => {
  const root = project();
  drop(root);
  cover(root, patchEntry('tests/b.test.ts'));
  const r = ratchet.checkE2eAssertions(root, hashed);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /why: no mutation names the dropped spec/);
});

test('AP-5 counters and areas are the configured ones', () => {
  const root = project();
  const baseline = JSON.parse(readFileSync(join(root, cfg.baseline), 'utf8'));
  const areas = baseline.areas;
  assert.deepEqual(Object.keys(areas).sort(), ['billing', 'search']);
  for (const a of Object.values(areas)) assert.deepEqual(Object.keys(a).sort(), ['asserts', 'cases']);
  // a.test.ts (billing: 3 asserts, 1 case) + b.test.ts (billing and search: 2, 2); notes.md is not a spec.
  assert.deepEqual(areas.billing, { asserts: 5, cases: 3 });
  assert.deepEqual(areas.search, { asserts: 2, cases: 2 });
});

test('AP-6 an unguardedKind entry covers the drop through the given setup', () => {
  const root = project();
  drop(root);
  cover(root, { kind: 'unguarded', from: 'tests/a.test.ts', title: 'a spec', why: 'cannot fail in isolation' });
  const r = ratchet.checkE2eAssertions(root, hashed);
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines.join('\n'), /covered by the mutation receipt/);
});
