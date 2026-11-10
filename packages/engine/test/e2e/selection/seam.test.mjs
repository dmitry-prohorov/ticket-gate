// G-1..G-4, G-6, G-7: the selection seam (union of graph sources, leaf resolvers,
// rule stages, config validation). Written from the contract, section 2 and 5.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { mini } from '../__tests__/select-repo.mjs';
import { cleanup, twoSource } from '../__tests__/two-source.mjs';
import { defineSelection, SelectionConfigError } from '../../../selection/define.mjs';
import { select } from '../__tests__/bound.mjs';

after(cleanup);

const run = (opts, changed) => {
  const { dir, cfg } = twoSource(opts);
  return select({ root: dir, changed, config: cfg });
};

test('G-1 two graph sources union their areas', () => {
  for (const bFirst of [false, true]) {
    const r = run({ bArea: 'b', bFirst }, ['classes/Svc.cls']);
    assert.equal(r.mode, 'affected', `bFirst=${bFirst}`);
    assert.deepEqual(r.areas, ['a', 'b'], `bFirst=${bFirst}`);
  }
});

test("G-2 '*' from either source is full", () => {
  for (const bFirst of [false, true]) {
    const r = run({ bArea: '*', bFirst }, ['classes/Svc.cls']);
    assert.equal(r.mode, 'full', `bFirst=${bFirst}`);
    assert.equal(r.rule, 'shell', `bFirst=${bFirst}`);
  }
  // control: without the star the same change is affected
  assert.equal(run({ bArea: 'b' }, ['classes/Svc.cls']).mode, 'affected');
});

test("G-3 an expand source reaches the callers' areas", () => {
  for (const bFirst of [false, true]) {
    const r = run({ bArea: null, bFirst }, ['classes/Svc.cls']);
    assert.equal(r.mode, 'affected', `bFirst=${bFirst}`);
    assert.deepEqual(r.areas, ['a'], `bFirst=${bFirst}`);
  }
});

test('G-4 a resolver to a leaf file selects without parsing it', () => {
  for (const path of ['classes/Ctl.cls', 'lwc/x/x.js']) {
    const r = run({ bArea: null }, [path]);
    assert.equal(r.mode, 'affected', `${path}: ${r.why}`);
    assert.deepEqual(r.areas, ['a'], path);
  }
});

test("G-6 after-triggers rules keep today's trigger order", () => {
  const dir = mini();
  const trig = select({ root: dir, changed: ['supabase/functions/deno.json'] });
  assert.equal(trig.mode, 'full');
  assert.equal(trig.why, 'supabase/functions/deno.json: trigger');
  const fn = select({ root: dir, changed: ['supabase/functions/x/index.ts'] });
  assert.equal(fn.mode, 'full');
  assert.equal(fn.why, 'supabase/functions/x/index.ts: function');
  // the telegram function still only adds its area
  const tg = select({
    root: dir,
    changed: ['supabase/functions/telegram/index.ts'],
  });
  assert.equal(tg.mode, 'affected');
  assert.deepEqual(tg.areas, ['telegram']);
});

test('G-7 defineSelection names a missing graph source', () => {
  const base = {
    specs: {
      dir: 'e2e',
      match: /\.spec\.ts$/,
      header: /^\/\/ e2e-areas: (.*)$/,
    },
  };
  for (const graphs of [undefined, []]) {
    assert.throws(
      () => defineSelection({ ...base, graphs }),
      (err) =>
        err instanceof SelectionConfigError &&
        err.name === 'SelectionConfigError' &&
        err.message.includes('selection.graphs'),
      `graphs=${JSON.stringify(graphs)}`,
    );
  }
  // control: one source is accepted
  assert.doesNotThrow(() =>
    defineSelection({
      ...base,
      graphs: [{ name: 'x', graph: () => ({ reach: () => ({}) }) }],
    }),
  );
});
