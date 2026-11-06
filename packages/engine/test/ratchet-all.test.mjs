// RA-*: `ticket-gate ratchet --all` in throwaway projects; every case spawns the bin so the exit
// status is the one a script sees.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(GATE, 'bin', 'ticket-gate.mjs');
const CONFIG_URL = pathToFileURL(join(GATE, 'config.mjs')).href;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project whose config has `ratchets` (source text of the object literal) and no pack. */
function project(ratchets) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-ra-')));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'gate.config.mjs'),
    `import { defineGate } from ${JSON.stringify(CONFIG_URL)};\nexport default defineGate({ steps: [], packs: [], ratchets: ${ratchets} });\n`,
  );
  return dir;
}
const all = (cwd, ...args) =>
  spawnSync(process.execPath, [BIN, 'ratchet', '--all', ...args], {
    cwd,
    encoding: 'utf8',
  });

const ok = (text) => `async () => ({ code: 0, lines: [${JSON.stringify(text)}] })`;

test('RA-1 a synthetic project with no pack runs ratchet --all over two check ratchets in config order', () => {
  const dir = project(
    `{ a: { group: 'check', check: ${ok('a says hi')} }, b: { group: 'check', check: ${ok('b says hi')} }, c: { check: async () => { throw new Error('c must not run'); } } }`,
  );
  const r = all(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    'a says hi\nratchet a: ok\nb says hi\nratchet b: ok\nratchet --all: 2 ran, 0 failed\n',
  );
  assert.equal(r.stderr, '');
});

test('RA-2 a ratchet without group check is not run by --all', () => {
  const dir = project(
    `{ a: { group: 'check', check: ${ok('a')} }, c: { check: async () => ({ code: 1, lines: ['c ran'] }) } }`,
  );
  const r = all(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /c ran|ratchet c/);
  assert.match(r.stdout, /1 ran, 0 failed/);
});

test('RA-3 one failing ratchet before a passing one exits 1 and names it in the summary', () => {
  const dir = project(
    `{ a: { group: 'check', check: async () => ({ code: 1, lines: ['a is red'] }) }, b: { group: 'check', check: ${ok('b')} } }`,
  );
  const r = all(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a is red/);
  assert.match(r.stderr, /ratchet a: exit 1/);
  assert.match(r.stdout, /ratchet b: ok/);
  assert.match(r.stderr, /ratchet --all: 2 ran, 1 failed: a\n$/);
});

test('RA-4 a throwing ratchet prints exit 2 (threw: boom), the next still runs, exit 2', () => {
  const dir = project(
    `{ a: { group: 'check', check: async () => { throw new Error('boom'); } }, b: { group: 'check', check: ${ok('b')} } }`,
  );
  const r = all(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ratchet a: exit 2 \(threw: boom\)/);
  assert.match(r.stdout, /ratchet b: ok/);
  assert.match(r.stderr, /ratchet --all: 2 ran, 1 failed: a/);
});

test('RA-5 group other than check is a config error', () => {
  const dir = project(`{ a: { group: 'other', check: ${ok('a')} } }`);
  const r = all(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /gate\.config: ratchets\.a\.group: must be 'check'/);
});

test('RA-6 --all with no check ratchet exits 2 with the no-ratchet line', () => {
  const dir = project(`{ c: { check: ${ok('c')} } }`);
  const r = all(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ratchet --all: no ratchet has group "check"/);
  assert.equal(r.stdout, '');
});

test('RA-7 ratchet --all --update passes update true to every check', () => {
  const echo = `async ({ update, args }) => ({ code: 0, lines: ['update=' + update + ' args=' + args.join(',')] })`;
  const dir = project(
    `{ a: { group: 'check', check: ${echo} }, b: { group: 'check', check: ${echo} } }`,
  );
  const r = all(dir, '--update');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.match(/update=true args=--update/g)?.length, 2);
  const plain = all(dir);
  assert.equal(plain.stdout.match(/update=false/g)?.length, 2);
});
