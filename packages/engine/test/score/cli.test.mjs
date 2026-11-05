import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  A,
  B,
  aOnly,
  at,
  branchEdit,
  fixtureFile,
  goodFiles,
  many,
  mut,
  on,
  repo,
  runCli,
  withReports,
  writeReports,
} from './__tests__/survivors.helpers.mjs';
import {} from './__tests__/demo.mjs';

test('MS-CLI1 passing run writes the survivors file and ends with the summary; a new file is not looked up in base', () => {
  const r = repo();
  branchEdit(r);
  // base has no entry for b.ts: if it were looked up it would score 100 and b would "drop".
  writeReports(r.dir, goodFiles(90), {
    'src/domain/a.ts': fixtureFile([...many('Killed', 9), mut('Survived')]),
  });
  const res = runCli(r.dir, r.base, ...withReports(r.dir));
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out = res.stdout.trim().split('\n');
  assert.equal(
    out.at(-1),
    'mutation: 2 files, score 90.0..90.0, 1 survivors on changed lines',
  );
  const md = readFileSync(join(r.dir, '.turbo/mutation-survivors.md'), 'utf8');
  assert.match(md, /^# Mutation survivors \(base /);
  assert.match(md, new RegExp(`## ${B}  score 90 \\(new\\)`));
  assert.match(md, new RegExp(`## ${A}  score 90 \\(base 90\\)`));
});

test('MS-CLI2 a new file under 80 exits 1 with the FAIL line', () => {
  const r = repo();
  branchEdit(r);
  writeReports(r.dir, goodFiles(70), goodFiles(90));
  const res = runCli(r.dir, r.base, ...withReports(r.dir));
  assert.equal(res.status, 1, res.stdout);
  assert.ok(
    res.stdout.includes(`mutation: FAIL ${B}: new file score 70.00 < 80`),
    res.stdout,
  );
});

test('MS-CLI3 a Stryker disable without a reason exits 1', () => {
  const r = repo();
  branchEdit(r);
  writeFileSync(
    join(r.dir, A),
    'l1\nl2\n// Stryker disable next-line all\nl4\n',
  );
  writeReports(r.dir, goodFiles(90), goodFiles(90));
  const res = runCli(r.dir, r.base, ...withReports(r.dir));
  assert.equal(res.status, 1, res.stdout);
  assert.ok(
    res.stdout.includes(
      `mutation: FAIL ${A}:3: Stryker disable without a reason`,
    ),
    res.stdout,
  );
});

test('MS-CLI4 a missing report exits 2; a branch with no core logic change runs nothing', () => {
  const r = repo();
  branchEdit(r);
  const res = runCli(
    r.dir,
    r.base,
    `--report=${join(r.dir, 'nope.json')}`,
    `--base-report=${join(r.dir, 'nope2.json')}`,
  );
  assert.equal(res.status, 2, res.stdout);
  assert.match(res.stdout, /^mutation: FAIL /m);

  const q = repo();
  mkdirSync(join(q.dir, 'tools'));
  writeFileSync(join(q.dir, 'tools/x.mjs'), 'x\n');
  const none = runCli(q.dir, q.base);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.match(none.stdout, /^mutation: no core logic file changed/);
  assert.ok(!existsSync(join(q.dir, '.turbo/mutation')));
});

test('MS-CLI5 a no-coverage mutant on a changed line of an existing file exits 1; on an unchanged line it passes', () => {
  const r = repo();
  writeFileSync(join(r.dir, A), 'l1\nl2\nCHANGED\nl4\n');
  const onLine = (n) =>
    aOnly(...many('Killed', 9), mut('NoCoverage', { location: at(n, 1, 2) }));
  writeReports(r.dir, onLine(3), aOnly(...many('Killed', 10)));
  const bad = runCli(r.dir, r.base, ...withReports(r.dir));
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.ok(
    bad.stdout.includes('1 no-coverage mutant(s) on changed lines'),
    bad.stdout,
  );

  // Same mutant on an unchanged line, same score as base: nothing to report.
  writeReports(r.dir, onLine(1), onLine(1));
  const ok = runCli(r.dir, r.base, ...withReports(r.dir));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(!ok.stdout.includes('no-coverage mutant(s)'), ok.stdout);
});

test('MS-CLI7 on an unchanged line, a mutant the base killed fails as regressed; a drop with no regressed mutant is a WARN; a survivor on a changed line fails', () => {
  const r = repo();
  branchEdit(r);
  const killed = (n) => many('Killed', n);
  const b = { 'src/domain/b.ts': fixtureFile(killed(10)) };
  // a.ts base: 10 killed on line 1 (the default location); line 3 is the changed one.
  const base = { 'src/domain/a.ts': fixtureFile(killed(10)) };

  // Branch: one of those line-1 mutants now survives.
  writeReports(
    r.dir,
    {
      ...b,
      'src/domain/a.ts': fixtureFile([...killed(9), on('Survived', 1)]),
    },
    base,
  );
  const reg = runCli(r.dir, r.base, ...withReports(r.dir));
  assert.equal(reg.status, 1, reg.stdout + reg.stderr);
  assert.ok(
    reg.stdout.includes(
      `mutation: FAIL ${A}: 1 mutant(s) killed on base now survive on unchanged lines`,
    ),
    reg.stdout,
  );
  assert.match(reg.stdout, /Survived \[regressed\]/);
  assert.match(
    reg.stdout.trim().split('\n').at(-1),
    /1 regressed on unchanged lines/,
  );
  // --report given: the tool ran no Stryker, so there is nothing to confirm.
  assert.ok(!reg.stdout.includes('confirming with --force'), reg.stdout);

  // Branch: a survivor on line 1 the base never had (another replacement): score drops, WARN only.
  writeReports(
    r.dir,
    {
      ...b,
      'src/domain/a.ts': fixtureFile([
        ...killed(9),
        on('Survived', 1, { replacement: 'false' }),
      ]),
    },
    base,
  );
  const warn = runCli(r.dir, r.base, ...withReports(r.dir));
  assert.equal(warn.status, 0, warn.stdout + warn.stderr);
  assert.match(
    warn.stdout,
    new RegExp(`mutation: WARN ${A}: score 90.00 dropped below base 100`),
  );
  assert.match(warn.stdout.trim().split('\n').at(-1), /1 warning\(s\)/);
  assert.ok(!warn.stdout.includes('mutation: FAIL'), warn.stdout);

  writeReports(
    r.dir,
    { ...b, 'src/domain/a.ts': fixtureFile([...killed(9), on('Survived', 3)]) },
    base,
  );
  const bad = runCli(r.dir, r.base, ...withReports(r.dir));
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.ok(
    bad.stdout.includes(`${A}: 1 surviving mutant(s) on changed lines`),
    bad.stdout,
  );
});

test('MS-CLI6 a Stryker disable with a reason on a changed line passes and is listed under New disable comments', () => {
  const r = repo();
  writeFileSync(
    join(r.dir, A),
    'l1\nl2\n// Stryker disable next-line all: equivalent\nl4\n',
  );
  writeReports(r.dir, goodFiles(90), goodFiles(90));
  const res = runCli(r.dir, r.base, ...withReports(r.dir));
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const md = readFileSync(join(r.dir, '.turbo/mutation-survivors.md'), 'utf8');
  const section = md.split('## New disable comments')[1] ?? '';
  assert.ok(section.includes(`\`${A}:3\``), md);
});
