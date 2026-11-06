// RO-1..RO-3: the project values of the React
// Compiler pack check are options (scan scope, message texts, baseline comment,
// the resolve chain). Trees are throwaway git repos in os.tmpdir().
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
import { reactCompiler } from '../compiler.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RESOLVE = { from: '.', via: ['@babel/core'] };

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ro-'));
  dirs.push(dir);
  for (const [rel, src] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, src);
  }
  for (const args of [
    ['init', '-q'],
    ['add', '-A'],
  ]) {
    const r = spawnSync('git', args, { cwd: dir });
    assert.equal(r.status, 0, String(r.stderr));
  }
  return dir;
}

const BAD_BODY = `async function go() {}
function done() {}
`;
const bad = (name) => `${BAD_BODY}export function ${name}() {
  const onClick = async () => {
    try {
      await go();
    } finally {
      done();
    }
  };
  return <button onClick={onClick}>x</button>;
}
`;

const cfg = (over = {}) => ({
  repo,
  scanDirs: ['src'],
  exclude: /(^|\/)skip\//,
  resolve: RESOLVE,
  baseline: 'b.json',
  comment: 'C',
  name: 'X',
  update: 'U',
  install: 'I',
  ...over,
});

const scopeTree = () =>
  makeTree({
    'src/Bad.tsx': bad('Bad'),
    'other/Bad.tsx': bad('Bad'),
    'src/skip/Skip.tsx': bad('Skip'),
  });

test('RO-1 scanDirs and exclude are the only scan scope', () => {
  const tree = scopeTree();
  const r = reactCompiler(cfg()).run([`--root=${tree}`, '--update', '--seed']);
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.deepEqual(r.out, ['X: baseline rewritten, 1 bailouts, 0 skips.']);
  assert.deepEqual(r.err, []);
  const written = JSON.parse(readFileSync(join(tree, 'b.json'), 'utf8'));
  assert.deepEqual(
    written.bailouts.map((b) => b.key),
    ['src/Bad.tsx|Bad|Todo'],
  );
});

test('RO-2 name, update and comment thread into the lines and the baseline', () => {
  const tree = scopeTree();
  const check = reactCompiler(cfg());
  const seeded = check.run([`--root=${tree}`, '--update', '--seed']);
  assert.equal(seeded.code, 0, seeded.err.join('\n'));
  const file = join(tree, 'b.json');
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.comment, 'C');
  written.bailouts.push({ key: 'src/Gone.tsx|Gone|Todo', allow: 'r' });
  writeFileSync(file, `${JSON.stringify(written, null, 2)}\n`);

  const r = check.run([`--root=${tree}`]);
  assert.equal(r.code, 1, r.out.join('\n'));
  assert.ok(
    r.out.includes('stale: src/Gone.tsx|Gone|Todo (fixed - run U)'),
    r.out.join('\n'),
  );
  assert.ok(r.out.at(-1).startsWith('X: 1 files, '), r.out.at(-1));
  assert.deepEqual(r.err, []);
});

test('RO-3 a resolve chain that fails is code 2 naming via.at(-1) and install', () => {
  const tree = scopeTree();
  const r = reactCompiler(
    cfg({ resolve: { from: RESOLVE.from, via: ['no-such-pkg-infra76'] } }),
  ).run([`--root=${tree}`]);
  assert.equal(r.code, 2);
  assert.deepEqual(r.out, []);
  assert.equal(r.err.length, 1);
  assert.ok(
    r.err[0].startsWith(
      'X: could not load @babel/core and babel-plugin-react-compiler through no-such-pkg-infra76 (',
    ),
    r.err[0],
  );
  assert.ok(r.err[0].endsWith('). Run `I`.'), r.err[0]);
});
