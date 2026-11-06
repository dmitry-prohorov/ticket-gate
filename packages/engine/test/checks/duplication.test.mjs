// The CLI is spawned with a fabricated jscpd report
// (--report), a throwaway root and baseline under os.tmpdir(); only DUP-S1
// runs the real jscpd, on a two-file repo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cloneOf, packageOf, updateBaseline } from './__tests__/dup-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '__tests__', 'dup-cli.mjs');
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'check-dup-'));
  dirs.push(d);
  return d;
};

const WEB = 'apps/web/components/A.tsx';
const MOB = 'apps/mobile/components/A.tsx';
const CORE = 'packages/core/src/x.ts';
const fragment = (seed, n) =>
  Array.from({ length: n }, (_, i) => `  const ${seed}${i} = ${i};`).join('\n');
const dup = (a, b, lines, seed = 'v', at = [10, 20]) => ({
  lines,
  fragment: fragment(seed, lines),
  firstFile: { name: a, start: at[0], end: at[0] + lines },
  secondFile: { name: b, start: at[1], end: at[1] + lines },
});
const entry = (d, extra = {}) => ({
  key: cloneOf(d).key,
  lines: d.lines,
  ...extra,
});

/** Runs the CLI against a report and baseline; returns { status, stdout, stderr, baselinePath }. */
function run(duplicates, baselineClones, ...args) {
  const dir = tmp();
  const report = join(dir, 'report.json');
  const baseline = join(dir, 'baseline.json');
  writeFileSync(report, JSON.stringify({ duplicates }));
  writeFileSync(baseline, JSON.stringify({ clones: baselineClones }));
  const r = spawnSync(
    'node',
    [
      SCRIPT,
      `--report=${report}`,
      `--root=${dir}`,
      `--baseline=${baseline}`,
      ...args,
    ],
    { encoding: 'utf8' },
  );
  return { ...r, baselinePath: baseline };
}

test('DUP-1 every gated clone in the baseline passes', () => {
  const d = dup(WEB, MOB, 30);
  const small = dup(WEB, WEB, 8, 's'); // in-package and short: ignored
  const ok = run([d, small], [entry(d)]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(
    ok.stdout,
    /check:dup: 1 gated clone\(s\), all in tools\/duplication-baseline\.json \(0 allowed, 1 debt\)\./,
  );
});

test('DUP-2 a new web <-> mobile clone fails and prints both sides', () => {
  const d = dup(WEB, MOB, 7, 'n', [11, 22]);
  const r = run([d], []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NEW mobile<->web 7 lines/);
  assert.ok(r.stderr.includes(`${MOB}:22-29`), r.stderr);
  assert.ok(r.stderr.includes(`${WEB}:11-18`), r.stderr);
  assert.match(r.stderr, /Extract the shared code/);
});

test('DUP-3 a new core <-> mobile clone fails', () => {
  const r = run([dup(CORE, MOB, 8)], []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NEW core<->mobile 8 lines/);
});

test('DUP-4 a within-package clone fails above 20 lines and passes at 20', () => {
  const other = 'apps/web/components/B.tsx';
  assert.equal(run([dup(WEB, other, 21)], []).status, 1);
  assert.equal(run([dup(WEB, other, 20)], []).status, 0);
});

test('DUP-5 a baseline entry with no clone fails as STALE', () => {
  const r = run([], [entry(dup(WEB, MOB, 12))]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /STALE /);
  assert.match(r.stderr, /run `pnpm check:dup --update`/);
});

test('DUP-6 an entry needs a reason: "platform input" passes, "" fails', () => {
  const d = dup(WEB, MOB, 12);
  assert.equal(run([d], [entry(d, { allow: 'platform input' })]).status, 0);
  const r = run([d], [entry(d, { allow: '' })]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NO REASON /);
});

test('DUP-7 two clones with one key are two clones unless the baseline counts them', () => {
  const d = dup(WEB, MOB, 12);
  const e = dup(WEB, MOB, 12, 'v', [90, 95]); // same files and fragment, other lines
  assert.equal(cloneOf(d).key, cloneOf(e).key);
  const r = run([d, e], [entry(d)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NEW /);
  assert.equal(run([d, e], [entry(d, { count: 2 })]).status, 0);
});

test('DUP-K the key ignores indentation, line numbers and file order; a changed token changes it', () => {
  const base = dup(WEB, MOB, 10);
  const moved = {
    ...base,
    fragment: base.fragment.replace(/^ {2}/gm, '        '),
    firstFile: { ...base.firstFile, start: 50, end: 60 },
    secondFile: { ...base.secondFile, start: 60, end: 70 },
  };
  assert.equal(cloneOf(moved).key, cloneOf(base).key);
  const swapped = {
    ...base,
    firstFile: base.secondFile,
    secondFile: base.firstFile,
  };
  assert.equal(cloneOf(swapped).key, cloneOf(base).key);
  const changed = {
    ...base,
    fragment: base.fragment.replace('v3 = 3', 'v3 = 4'),
  };
  assert.notEqual(cloneOf(changed).key, cloneOf(base).key);
  assert.equal(cloneOf(base).kind, 'mobile<->web');
  assert.deepEqual(
    [
      'apps/web/a.ts',
      'apps/mobile/a.ts',
      'packages/core/src/a.ts',
      'tools/a.mjs',
    ].map(packageOf),
    ['web', 'mobile', 'core', 'other'],
  );
});

test('DUP-U --update drops stale entries, keeps reasons by key, and marks new ones', () => {
  const kept = dup(WEB, MOB, 12, 'a');
  const gone = dup(WEB, MOB, 14, 'g');
  const fresh = dup(CORE, MOB, 9, 'f');
  const r = run(
    [kept, fresh],
    [entry(kept, { allow: 'platform input' }), entry(gone)],
    '--update',
  );
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(r.baselinePath, 'utf8');
  const next = JSON.parse(text);
  assert.equal(text, JSON.stringify(next, null, 2) + '\n');
  const by = Object.fromEntries(next.clones.map((c) => [c.key, c]));
  assert.equal(by[cloneOf(kept).key].allow, 'platform input');
  assert.equal(by[cloneOf(fresh).key].allow, '');
  assert.equal(by[cloneOf(gone).key], undefined);
  assert.deepEqual(
    next.clones.map((c) => c.key),
    next.clones.map((c) => c.key).sort(),
  );
});

test('DUP-U a smaller replacement of a debt entry is debt; a larger one needs a reason', () => {
  const old = dup(WEB, MOB, 30, 'o');
  const smaller = dup(WEB, MOB, 25, 'p');
  const larger = dup(WEB, MOB, 35, 'q');
  const next = (replacement, prior) =>
    updateBaseline([cloneOf(replacement)], { clones: [prior] }).next.clones[0];
  assert.equal('allow' in next(smaller, entry(old)), false);
  assert.equal(next(larger, entry(old)).allow, '');
  // A dropped entry that carried a reason does not pass its exemption on.
  assert.equal(next(smaller, entry(old, { allow: 'why' })).allow, '');
});

test('DUP-U --seed gives new entries no reason, and count is written only above 1', () => {
  const d = dup(WEB, MOB, 12);
  const e = dup(WEB, MOB, 12, 'v', [90, 95]);
  const { next } = updateBaseline(
    [cloneOf(d), cloneOf(e)],
    { clones: [] },
    { seed: true },
  );
  assert.deepEqual(next.clones, [{ key: cloneOf(d).key, lines: 12, count: 2 }]);
  const single = updateBaseline([cloneOf(d)], { clones: [] }, { seed: true })
    .next.clones[0];
  assert.equal('count' in single, false);
  assert.equal('allow' in single, false);
});

test('DUP-E a missing or invalid report exits 2', () => {
  const dir = tmp();
  const args = (report) => [SCRIPT, `--report=${report}`, `--root=${dir}`];
  assert.equal(spawnSync('node', args(join(dir, 'nope.json'))).status, 2);
  writeFileSync(join(dir, 'bad.json'), '{not json');
  const bad = spawnSync('node', args(join(dir, 'bad.json')), {
    encoding: 'utf8',
  });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /jscpd produced no report/);
});

test('DUP-S1 smoke: the real jscpd, with the repo config, finds a web <-> mobile copy', () => {
  const dir = tmp();
  copyFileSync(
    join(HERE, 'fixtures', 'jscpd.json'),
    join(dir, '.jscpd.json'),
  );
  const body = Array.from(
    { length: 30 },
    (_, i) => `  const value${i} = compute(${i}, 'label-${i}', value${i - 1});`,
  ).join('\n');
  const src = `export function copied(compute) {\n${body}\n  return value29;\n}\n`;
  for (const app of ['web', 'mobile']) {
    mkdirSync(join(dir, `apps/${app}/lib`), { recursive: true });
    writeFileSync(join(dir, `apps/${app}/lib/dup.ts`), src);
  }
  mkdirSync(join(dir, 'packages/core/src'), { recursive: true }); // jscpd dies on a missing path
  mkdirSync(join(dir, 'tools'));
  writeFileSync(join(dir, 'tools/duplication-baseline.json'), '{"clones":[]}');
  const r = spawnSync('node', [SCRIPT, `--root=${dir}`], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /apps\/mobile\/lib\/dup\.ts:1-/);
  assert.match(r.stderr, /apps\/web\/lib\/dup\.ts:1-/);
});
