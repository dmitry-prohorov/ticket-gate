// Run by `pnpm test:tools`. Function cases inject fakes (no shell, pnpm or
// stack); CLI cases spawn the script in a throwaway repo under os.tmpdir() with
// plain shell test commands, so nothing touches this repo.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, test } from 'node:test';

import { runMutations, summaryLine } from '../../mutations/run.mjs';
import {
  ORIGINAL,
  FIND,
  patch,
  serveWorld,
  pw,
  PW_PASS,
  pwBites,
} from './__tests__/mutate-check.helpers.mjs';

test('MC-B1 identical patches share one build; both results carry the group', async () => {
  const w = serveWorld(pwBites);
  const spec = {
    mutations: [
      patch('M1', { test: pw('old') }),
      patch('M2', { test: pw('home') }),
    ],
  };
  const r = await runMutations(spec, w.io);
  assert.equal(w.builds, 2);
  assert.equal(r.builds, 2);
  assert.deepEqual(
    r.results.map((x) => x.status),
    ['killed', 'killed'],
  );
  assert.equal(r.results[0].group, r.results[1].group);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(r.groups[0].ids, ['M1', 'M2']);
  assert.equal(r.groups[0].build, 'ok');
  assert.equal(r.ok, true);
});

test('MC-B2 the clean phase runs each distinct test once, with reuse', async () => {
  const w = serveWorld(pwBites);
  const spec = {
    mutations: [
      patch('M1', { test: pw('a') }),
      patch('M2', { test: pw('a'), replace: 'x' }),
      patch('M3', { test: pw('b'), replace: 'y' }),
    ],
  };
  await runMutations(spec, w.io);
  const clean = w.runOpts.filter((o) => !o.mutated);
  assert.deepEqual(clean.map((o) => o.cmd).sort(), [pw('a'), pw('b')]);
  assert.ok(w.runOpts.every((o) => o.reuse === true));
  assert.equal(w.builds, 4);
});

test('MC-B3 a zero-test entry inside a group is error, its neighbour killed', async () => {
  const w = serveWorld((cmd, wd) =>
    wd.file === ORIGINAL
      ? { code: 0, out: PW_PASS }
      : cmd === pw('zero')
        ? { code: 1, out: 'Error: No tests found' }
        : { code: 1, out: 'FAIL' },
  );
  const spec = {
    mutations: [
      patch('M1', { test: pw('zero') }),
      patch('M2', { test: pw('real') }),
    ],
  };
  const r = await runMutations(spec, w.io);
  assert.equal(r.results[0].status, 'error');
  assert.match(r.results[0].detail, /No tests found/);
  assert.equal(r.results[1].status, 'killed');
});

test('MC-B4 a failed group build marks the group error and the next group still runs', async () => {
  const w = serveWorld(pwBites);
  // build 1 = clean, 2 = first group (fails), 3 = second group
  w.buildFn = (n) =>
    n === 2 ? { code: 1, out: 'Type error in page.tsx' } : { code: 0, out: '' };
  const spec = {
    mutations: [
      patch('M1', { test: pw('a') }),
      patch('M2', { test: pw('b') }),
      patch('M3', { test: pw('a'), replace: 'x' }),
    ],
  };
  const r = await runMutations(spec, w.io);
  assert.deepEqual(
    r.results.map((x) => [x.id, x.status]),
    [
      ['M1', 'error'],
      ['M2', 'error'],
      ['M3', 'killed'],
    ],
  );
  assert.match(
    r.results[0].detail,
    /group [0-9a-f]{12}: build failed: .*Type error/,
  );
  assert.deepEqual(
    r.groups.map((g) => g.build),
    ['failed', 'ok'],
  );
  assert.equal(r.ok, false);
  assert.equal(w.file, ORIGINAL);
});

test('MC-B5 a busy port refuses the run: nothing applied, nothing built', async () => {
  const w = serveWorld(pwBites);
  w.busy = true;
  const r = await runMutations(
    { mutations: [patch('M1', { test: pw('a') })] },
    w.io,
  );
  assert.match(r.refused, /port 3000 is already in use/);
  assert.deepEqual(r.results, []);
  assert.equal(w.builds, 0);
  assert.equal(w.starts, 0);
  assert.deepEqual(w.log, []);
  assert.equal(w.file, ORIGINAL);
});

test('MC-B6 a patch under apps/web/e2e/ runs on the clean server: one build', async () => {
  const w = serveWorld(pwBites);
  const spec = {
    mutations: [
      patch('M1', { test: pw('a'), file: 'apps/web/e2e/fixtures/x.ts' }),
    ],
  };
  const r = await runMutations(spec, w.io);
  assert.equal(w.builds, 1);
  assert.equal(r.groups[0].build, 'none');
  assert.equal(r.results[0].status, 'killed');
});

test('MC-B9 an apps/web/e2e/ patch after an app patch runs on a clean build', async () => {
  // The test is red only while the served build came from a mutated file.
  const w = serveWorld((_cmd, wd) =>
    wd.builtFrom === ORIGINAL
      ? { code: 0, out: PW_PASS }
      : { code: 1, out: 'FAIL on a mutated build' },
  );
  const build = w.io.buildWeb;
  w.io.buildWeb = () => {
    w.builtFrom = w.file;
    return build();
  };
  const spec = {
    mutations: [
      patch('M1', { test: pw('a') }),
      patch('M2', {
        test: pw('a'),
        file: 'apps/web/e2e/fixtures/x.ts',
        replace: FIND,
      }),
    ],
  };
  const r = await runMutations(spec, w.io);
  assert.deepEqual(r.results.map((x) => [x.id, x.status]).sort(), [
    ['M1', 'killed'],
    ['M2', 'survived'],
  ]);
  assert.equal(w.builds, 2, 'the clean build and the app patch only');
});

test('MC-B7 the server is stopped and the file restored after a kill, an error and a throwing start', async () => {
  const w = serveWorld(pwBites);
  const spec = { mutations: [patch('M1', { test: pw('a') })] };
  await runMutations(spec, w.io);
  assert.equal(w.stops, 2, 'clean server and group server');
  assert.equal(w.file, ORIGINAL);

  const e = serveWorld(() => ({ code: 0, out: PW_PASS }));
  e.buildFn = (n) =>
    n === 2 ? { code: 1, out: 'broken' } : { code: 0, out: '' };
  await runMutations(spec, e.io);
  assert.equal(e.file, ORIGINAL);
  assert.equal(e.stops, 1, 'the group never started a server');

  const t = serveWorld(pwBites);
  const clean = t.io.startServer;
  t.io.startServer = async () => {
    if (t.starts === 1) t.startThrows = true;
    return clean();
  };
  const r = await runMutations(spec, t.io);
  assert.equal(r.results[0].status, 'error');
  assert.match(r.results[0].detail, /start failed: spawn blew up/);
  assert.equal(t.file, ORIGINAL);
  assert.equal(t.stops, 1);
});

test('MC-B8 summaryLine appends the build count only when given', () => {
  const rs = [{ id: 'M1', status: 'killed' }];
  assert.equal(
    summaryLine('T', rs, 0, 3),
    'mutate:check T: 1/1 killed, 0 survived, 0 error, 3 builds',
  );
  assert.equal(
    summaryLine('T', rs),
    'mutate:check T: 1/1 killed, 0 survived, 0 error',
  );
});
