// Run by `pnpm test:tools`. Function cases inject fakes (no shell, pnpm or
// stack); CLI cases spawn the script in a throwaway repo under os.tmpdir() with
// plain shell test commands, so nothing touches this repo.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEMO } from './__tests__/demo.fixture.mjs';
import { childEnv, exec } from '../../mutations/exec.mjs';
import { projectSetup } from '../../mutations/project.mjs';
import {
  SRC,
  ORIGINAL,
  FIND,
  repo,
  patch,
  scratch,
} from './__tests__/mutate-check.helpers.mjs';

const REG = 'tools/mutation-registry/';
const areaJson = (o) => `${JSON.stringify(o, null, 2)}\n`;
const rEntry = (over = {}) => ({
  kind: 'patch',
  protects: '5 guard',
  file: SRC,
  find: FIND,
  replace: '',
  test: `grep -qF "${FIND}" ${SRC}`,
  testFile: SRC,
  ...over,
});
const H_SRC = 'keep\nreturn 5;\nend\n';
const hEntry = (over = {}) =>
  rEntry({
    file: 'lib/h.ts',
    find: 'return 5;',
    test: 'grep -qF "return 5;" lib/h.ts',
    testFile: 'lib/h.ts',
    ...over,
  });
const node = (dir, ...args) =>
  spawnSync('node', ['tools/mutate-check.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
const out = (p) => p.stdout + p.stderr;
const readReceipt = (dir, name) =>
  JSON.parse(readFileSync(join(dir, '.turbo', name), 'utf8'));
const plainTreeHash = (dir) =>
  execFileSync(
    'node',
    [
      '-e',
      "import('./tools/tree-hash.mjs').then((m) => process.stdout.write(m.treeHash()))",
    ],
    { cwd: dir, encoding: 'utf8' },
  );

function registryRepo() {
  return repo(ORIGINAL, {
    'lib/h.ts': H_SRC,
    [`${REG}src.json`]: areaJson({
      'T/M1': rEntry(),
      'U/M1': rEntry({ test: 'mkdir -p .turbo && touch .turbo/u-ran' }),
    }),
    [`${REG}lib.json`]: areaJson({ 'T/M2': hEntry() }),
  });
}

test('MC-R1 <ID> runs the live keys of that ticket from two area files and no other ticket', () => {
  const dir = registryRepo();
  const p = node(dir, 'T');
  assert.equal(p.status, 0, out(p));
  assert.match(p.stdout, /mutate:check T: 2\/2 killed, 0 survived, 0 error/);
  assert.equal(existsSync(join(dir, '.turbo/u-ran')), false, "U's test ran");
  const receipt = readReceipt(dir, 'mutation-check.json');
  assert.equal(receipt.ticket, 'T');
  assert.equal(receipt.source, 'registry');
  assert.deepEqual(receipt.results.map((r) => r.id).sort(), ['T/M1', 'T/M2']);
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), ORIGINAL);

  // --only=M2 means T/M2
  const only = node(dir, 'T', '--only=M2');
  assert.equal(only.status, 1, out(only)); // partial runs are never ok
  assert.deepEqual(
    readReceipt(dir, 'mutation-check.json').results.map((r) => r.id),
    ['T/M2'],
  );
});

test('MC-R2 --registry --ids writes .turbo/mutation-registry.json and leaves mutation-check.json alone', () => {
  const dir = registryRepo();
  assert.equal(node(dir, 'T').status, 0);
  assert.equal(existsSync(join(dir, '.turbo/mutation-registry.json')), false);
  const ticketReceipt = readFileSync(
    join(dir, '.turbo/mutation-check.json'),
    'utf8',
  );
  // An uncommitted registry edit: the registry receipt hashes the whole tree.
  writeFileSync(
    join(dir, `${REG}src.json`),
    areaJson({
      'T/M1': rEntry(),
      'U/M1': rEntry({ find: 'if (n === 0)', test: 'true' }),
    }),
  );
  const p = node(dir, '--registry', '--ids=T/M2,T/M1');
  assert.equal(p.status, 0, out(p));
  const r = readReceipt(dir, 'mutation-registry.json');
  assert.equal(r.mode, 'ids');
  assert.deepEqual(r.keys, ['T/M1', 'T/M2']);
  assert.equal(r.partial, false);
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => x.id).sort(), ['T/M1', 'T/M2']);
  assert.equal(r.treeHash, plainTreeHash(dir));
  assert.match(r.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(
    readFileSync(join(dir, '.turbo/mutation-check.json'), 'utf8'),
    ticketReceipt,
  );
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), ORIGINAL);

  // A registry run alone creates no ticket receipt.
  const fresh = registryRepo();
  assert.equal(node(fresh, '--registry', '--ids=T/M1').status, 0);
  assert.equal(existsSync(join(fresh, '.turbo/mutation-check.json')), false);
});

test('MC-R2b --registry --ids refuses an unknown or retired key with exit 2', () => {
  const dir = repo(ORIGINAL, {
    [`${REG}src.json`]: areaJson({
      'T/M1': rEntry(),
      'T/M2': rEntry({
        retired: { by: 'T', why: 'obsolete per specs/x.md section 2' },
      }),
    }),
  });
  assert.equal(node(dir, '--registry', '--ids=T/M9').status, 2);
  assert.equal(node(dir, '--registry', '--ids=T/M1,T/M2').status, 2);
  assert.equal(existsSync(join(dir, '.turbo/mutation-registry.json')), false);
});

test('MC-R3 a retired own entry prints skipped (retired) and its test never runs', () => {
  const dir = repo(ORIGINAL, {
    [`${REG}src.json`]: areaJson({
      'T/M1': rEntry(),
      'T/M2': rEntry({
        find: 'text that is nowhere',
        test: 'mkdir -p .turbo && touch .turbo/r-ran',
        retired: { by: 'T', why: 'obsolete per specs/x.md section 2' },
      }),
    }),
  });
  const p = node(dir, 'T');
  assert.equal(p.status, 0, out(p));
  assert.match(p.stdout, /T\/M2 skipped \(retired\)/);
  assert.match(p.stdout, /mutate:check T: 1\/1 killed/);
  assert.equal(existsSync(join(dir, '.turbo/r-ran')), false);
  assert.deepEqual(
    readReceipt(dir, 'mutation-check.json').results.map((r) => r.id),
    ['T/M1'],
  );
});

test('MC-R4 a whitespace-different find: the patch replaces exactly the matched bytes', () => {
  const src = 'before\nif (n   ===\n  0)  throw forbidden;\nafter $& $1\n';
  const dir = repo(src, {
    // Green while the guard is present; on the mutant it records the file and fails.
    'check.js':
      "const fs=require('fs');const s=fs.readFileSync('src/guard.ts','utf8');if(s.includes('forbidden'))process.exit(0);fs.mkdirSync('.turbo',{recursive:true});fs.writeFileSync('.turbo/seen',s);process.exit(1);\n",
    [`${REG}src.json`]: areaJson({
      'T/M1': rEntry({ replace: 'return;', test: 'node check.js' }),
    }),
  });
  const p = node(dir, 'T');
  assert.equal(p.status, 0, out(p));
  assert.match(p.stdout, /1\/1 killed/);
  assert.equal(
    readFileSync(join(dir, '.turbo/seen'), 'utf8'),
    'before\nreturn;\nafter $& $1\n',
  );
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), src);
});

test("MC-R5 a re-aim of another ticket's entry leaves the receipt digests valid; an own edit does not", () => {
  const dir = registryRepo();
  assert.equal(node(dir, 'T').status, 0);
  const receipt = readReceipt(dir, 'mutation-check.json');
  const digest = () => node(dir, 'T', '--digest').stdout;
  const same = `entriesDigest: ${receipt.entriesDigest}\ntreeHash: ${receipt.treeHash}\n`;
  assert.equal(digest(), same);

  writeFileSync(
    join(dir, `${REG}src.json`),
    areaJson({
      'T/M1': rEntry(),
      'U/M1': rEntry({
        find: 'if (n === 0)',
        test: 'mkdir -p .turbo && touch .turbo/u-ran',
      }),
    }),
  );
  assert.equal(digest(), same, 'U re-aimed: T receipt still valid');

  writeFileSync(
    join(dir, `${REG}src.json`),
    areaJson({
      'T/M1': rEntry({ replace: 'return;' }),
      'U/M1': rEntry({ test: 'mkdir -p .turbo && touch .turbo/u-ran' }),
    }),
  );
  const own = digest();
  assert.notEqual(own.split('\n')[0], same.split('\n')[0], 'own entry edited');
  assert.equal(
    own.split('\n')[1],
    same.split('\n')[1],
    'registry not in treeHash',
  );

  writeFileSync(join(dir, SRC), `${ORIGINAL}// edited\n`);
  assert.notEqual(digest().split('\n')[1], same.split('\n')[1]);
});

test('MC-D1 --digest prints the two lines and writes nothing; an unknown ID is exit 2', () => {
  const dir = registryRepo();
  const p = node(dir, 'T', '--digest');
  assert.equal(p.status, 0, out(p));
  assert.match(
    p.stdout,
    /^entriesDigest: [0-9a-f]{64}\ntreeHash: [0-9a-f]{64}\n$/,
  );
  assert.equal(
    existsSync(join(dir, '.turbo'))
      ? readdirSync(join(dir, '.turbo')).length
      : 0,
    0,
  );
  assert.equal(readFileSync(join(dir, SRC), 'utf8'), ORIGINAL);

  const none = node(dir, 'Z', '--digest');
  assert.equal(none.status, 2, out(none));
  const run = node(dir, 'Z');
  assert.equal(run.status, 2, out(run));
  assert.match(out(run), /no live entries for Z in tools\/mutation-registry\//);
});

// INFRA-27: MC-D2 used to assert that --changed was refused (26a, before the
// selector existed). The flag now works with --registry; what stays a usage
// error is --changed without --registry, or beside --ids / --all.
test('MC-D2 --changed needs --registry and does not combine with --ids or --all (exit 2)', () => {
  const dir = registryRepo();
  const bare = node(dir, 'T', '--changed');
  assert.equal(bare.status, 2, out(bare));
  assert.match(out(bare), /--changed needs --registry/);
  const both = node(dir, '--registry', '--changed', '--ids=T/M1');
  assert.equal(both.status, 2, out(both));
  const all = node(dir, '--registry', '--changed', '--all');
  assert.equal(all.status, 2, out(all));
  assert.equal(existsSync(join(dir, '.turbo/mutation-registry.json')), false);
});

test('MC-C1 --registry --changed runs exactly the selected keys', () => {
  const dir = registryRepo();
  // an uncommitted edit one line below T/M2's guard in lib/h.ts
  writeFileSync(join(dir, 'lib/h.ts'), H_SRC.replace('end', 'end2'));
  const p = node(dir, '--registry', '--changed');
  assert.equal(p.status, 0, out(p));
  assert.match(
    p.stdout,
    /mutate:check registry: 1\/1 killed, 0 survived, 0 error/,
  );
  const r = readReceipt(dir, 'mutation-registry.json');
  assert.equal(r.mode, 'changed');
  assert.deepEqual(r.keys, ['T/M2']);
  assert.deepEqual(
    r.results.map((x) => x.id),
    ['T/M2'],
  );
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(dir, '.turbo/mutation-check.json')), false);
  assert.equal(existsSync(join(dir, '.turbo/u-ran')), false);
  assert.equal(
    readFileSync(join(dir, 'lib/h.ts'), 'utf8'),
    H_SRC.replace('end', 'end2'),
  );
  // an explicit base names the same selection
  const sha = execFileSync('git', ['rev-parse', 'main'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  const q = node(dir, '--registry', `--changed=${sha}`);
  assert.equal(q.status, 0, out(q));
  assert.deepEqual(readReceipt(dir, 'mutation-registry.json').keys, ['T/M2']);
});

test('MC-C2 --registry --changed exits 1 on a survived entry or a failed selection and 0 on an empty selection', () => {
  const survivor = repo(ORIGINAL, {
    'lib/h.ts': H_SRC,
    [`${REG}lib.json`]: areaJson({ 'T/M2': hEntry({ test: 'true' }) }),
  });
  writeFileSync(join(survivor, 'lib/h.ts'), H_SRC.replace('end', 'end2'));
  const s = node(survivor, '--registry', '--changed');
  assert.equal(s.status, 1, out(s));
  assert.match(s.stdout, /1 survived/);
  assert.equal(readReceipt(survivor, 'mutation-registry.json').ok, false);

  const clean = registryRepo();
  const e = node(clean, '--registry', '--changed');
  assert.equal(e.status, 0, out(e));
  assert.match(
    e.stdout,
    /mutate:check registry: 0\/0 killed, 0 survived, 0 error/,
  );
  assert.equal(existsSync(join(clean, '.turbo/mutation-registry.json')), false);

  const bad = node(clean, '--registry', '--changed=no-such-ref');
  assert.equal(bad.status, 1, out(bad));
  assert.match(out(bad), /selection failed/);
});

test('MC-C3 --defer-playwright runs only the non-Playwright selected keys and prints how many it left to the nightly', () => {
  const dir = repo(ORIGINAL, {
    'lib/h.ts': H_SRC,
    [`${REG}src.json`]: areaJson({
      'T/M1': rEntry({
        test: 'pnpm -F web exec playwright test e2e/x.spec.ts',
      }),
    }),
    [`${REG}lib.json`]: areaJson({ 'T/M2': hEntry() }),
  });
  writeFileSync(join(dir, 'lib/h.ts'), H_SRC.replace('end', 'end2'));
  writeFileSync(join(dir, SRC), ORIGINAL.replace('before', 'before2'));
  const p = node(dir, '--registry', '--changed', '--defer-playwright');
  assert.equal(p.status, 0, out(p));
  assert.match(
    p.stdout,
    /mutate:check deferred: 1 Playwright-backed entry left to the nightly rotation .*: T\/M1/,
  );
  assert.match(
    p.stdout,
    /mutate:check registry: 1\/1 killed, 0 survived, 0 error/,
  );
  assert.deepEqual(readReceipt(dir, 'mutation-registry.json').keys, ['T/M2']);
  const bare = node(dir, '--registry', '--defer-playwright');
  assert.equal(bare.status, 2, out(bare));
  assert.match(out(bare), /--defer-playwright needs --changed/);
});

test('MC-C4 --defer-playwright with only Playwright-backed keys selected runs nothing and passes', () => {
  const dir = repo(ORIGINAL, {
    [`${REG}src.json`]: areaJson({
      'T/M1': rEntry({
        test: 'pnpm -F web exec playwright test e2e/x.spec.ts',
      }),
    }),
  });
  writeFileSync(join(dir, SRC), ORIGINAL.replace('before', 'before2'));
  const p = node(dir, '--registry', '--changed', '--defer-playwright');
  assert.equal(p.status, 0, out(p));
  assert.match(p.stdout, /mutate:check deferred: 1 Playwright-backed entry/);
  assert.match(p.stdout, /mutate:check registry: 0\/0 killed/);
  assert.equal(existsSync(join(dir, '.turbo/mutation-registry.json')), false);
});

test("INFRA-26 fix A: childEnv strips the setup's drop list, keeps the rest and the extras", () => {
  const [DROP] = projectSetup().childEnv.drop;
  const e = childEnv(
    { [DEMO.reuseEnv]: '1' },
    { [DROP]: '/x/e2e-report.json', PATH: '/bin' },
  );
  assert.equal(DROP in e, false);
  assert.equal(e.PATH, '/bin');
  assert.equal(e[DEMO.reuseEnv], '1');
});

test('INFRA-26 fix A: exec never hands a dropped variable to its child', async () => {
  const [DROP] = projectSetup().childEnv.drop;
  const prev = process.env[DROP];
  process.env[DROP] = '/should/not/leak.json';
  try {
    const r = await exec('node', [
      '-e',
      `process.stdout.write(String(process.env.${DROP}))`,
    ]);
    assert.equal(r.out, 'undefined');
  } finally {
    if (prev === undefined) delete process.env[DROP];
    else process.env[DROP] = prev;
  }
});

test('INFRA-26 fix B: --file takes an absolute path as is', () => {
  const dir = repo();
  const abs = join(dir, 'm.json');
  writeFileSync(
    abs,
    scratch([patch('M1', { test: `grep -qF "${FIND}" ${SRC}` })]),
  );
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', `--file=${abs}`],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(p.status, 0, p.stdout + p.stderr);
});

// INFRA-30: the type check before any build.
