// The public repo names no consumer: no project name, no package scope of one, no
// environment variable prefix of one. Needles are built from parts so this file does not match
// itself.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { REPO, repoFiles } from './repo-files.mjs';

const P = 'F' + 'P_';
export const NEEDLES = [
  ['project name', new RegExp('family' + '-planner', 'g')],
  ['package scope', new RegExp('@f' + 'p/', 'g')],
  ['variable prefix', new RegExp('\\b' + P + '[A-Z][A-Z0-9_]*', 'g')],
];

// Names permitted per (file, name), counted so an edit that moves a line does not fail the scan.
// Empty: the previous variable prefix is spelled in no file of this repository.
const ALLOWED = {};

/** Every needle hit in `files` (relative to `root`) beyond what `allowed` permits for that file. */
export function scan(root, files, allowed = ALLOWED) {
  const hits = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    const seen = new Map();
    for (const [label, re] of NEEDLES)
      for (const m of text.matchAll(re)) seen.set(m[0], (seen.get(m[0]) ?? 0) + 1);
    for (const [name, n] of seen) {
      const room = allowed[f]?.[name] ?? 0;
      if (n > room) hits.push(`${f}: ${name} x${n} (allowed ${room})`);
    }
  }
  return hits;
}

test(`NS-1 no ${'family' + '-planner'}, ${'@f' + 'p/'} or ${P} name anywhere`, () => {
  assert.deepEqual(
    scan(REPO, repoFiles()),
    [],
    'The public repo must not name a consumer. Reword the line with a neutral name; do not add to ALLOWED in test/no-consumer-names.test.mjs.',
  );
});

test('NS-1b the scanner reports each needle planted in a scratch dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ns1b-'));
  try {
    const planted = {
      'a/name.txt': 'family' + '-planner',
      'b/scope.txt': 'import x from "@f' + 'p/core"',
      'c/prefix.txt': P + 'SOMETHING=1',
      // an allowed map applies to its own paths only: the same name elsewhere is a hit
      'd/cli.mjs': P + 'E2E_JSON',
    };
    for (const [f, text] of Object.entries(planted)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    const local = { 'packages/engine/cli.mjs': { [P + 'E2E_JSON']: 1 } };
    const hits = scan(dir, Object.keys(planted), local);
    assert.equal(hits.length, Object.keys(planted).length, hits.join('\n'));
    for (const f of Object.keys(planted)) assert.ok(hits.some((h) => h.startsWith(`${f}:`)), `${f} not reported`);
    // and an allowed name over its count in an allowed path is reported
    mkdirSync(join(dir, 'packages/engine'), { recursive: true });
    writeFileSync(join(dir, 'packages/engine/cli.mjs'), `${P}E2E_JSON ${P}E2E_JSON`);
    assert.equal(scan(dir, ['packages/engine/cli.mjs'], local).length, 1);
    writeFileSync(join(dir, 'packages/engine/cli.mjs'), `${P}E2E_JSON`);
    assert.deepEqual(scan(dir, ['packages/engine/cli.mjs'], local), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
