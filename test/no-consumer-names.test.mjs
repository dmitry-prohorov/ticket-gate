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

// Variable names that predate the export and are handed off, counted per (file, name) so an
// edit that moves a line does not fail the scan. Only these two paths may carry them.
const ALLOWED = {
  'packages/engine/cli.mjs': { [P + 'E2E_JSON']: 1 },
  'packages/engine/lock.mjs': {
    [P + 'STACK_LOCK_OWNER']: 5,
    [P + 'STACK_LOCK_PATH']: 1,
    [P + 'STACK_LOCK_WAIT_S']: 2,
    [P + 'STACK_LOCK_POLL_S']: 1,
    [P + 'STACK_LOCK_PRINT_S']: 1,
  },
  // nightly variable names handed off with the export; the TICKET_GATE_* rename removes them
  'packages/engine/nightly/record.mjs': { [P + 'NIGHTLY_DIR']: 2 },
  'packages/engine/nightly/run.mjs': {
    [P + 'STACK_LOCK_OWNER']: 2,
    [P + 'NIGHTLY_MUTATION_MIN']: 1,
  },
  'packages/engine/mutations/rotation-status.mjs': { [P + 'NIGHTLY_MUTATION_MIN']: 1 },
  // the ported nightly tests set the same handed-off names
  'packages/engine/test/nightly/__tests__/status-helpers.mjs': {
    [P + 'NIGHTLY_DIR']: 1,
    [P + 'STACK_LOCK_OWNER']: 1,
  },
  'packages/engine/test/nightly/__tests__/world.mjs': {
    [P + 'NIGHTLY_DIR']: 2,
    [P + 'STACK_LOCK_OWNER']: 1,
  },
  'packages/engine/test/nightly/rotation-status.test.mjs': { [P + 'NIGHTLY_MUTATION_MIN']: 1 },
  'packages/engine/test/nightly/run-mutations.test.mjs': { [P + 'STACK_LOCK_OWNER']: 4 },
  'packages/engine/test/nightly/run.test.mjs': { [P + 'STACK_LOCK_OWNER']: 2 },
  'packages/engine/test/nightly/seam.test.mjs': { [P + 'STACK_LOCK_OWNER']: 3 },
  'packages/engine/test/nightly/status-fixtures.test.mjs': {
    [P + 'NIGHTLY_DIR']: 1,
    [P + 'STACK_LOCK_OWNER']: 1,
  },
};

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

test(`NS-1 no ${'family' + '-planner'}, ${'@f' + 'p/'} or ${P} name outside the pre-existing allowed set`, () => {
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
      // the allowed set applies to its two paths only: the same name elsewhere is a hit
      'd/cli.mjs': P + 'E2E_JSON',
    };
    for (const [f, text] of Object.entries(planted)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    const hits = scan(dir, Object.keys(planted));
    assert.equal(hits.length, Object.keys(planted).length, hits.join('\n'));
    for (const f of Object.keys(planted)) assert.ok(hits.some((h) => h.startsWith(`${f}:`)), `${f} not reported`);
    // and an allowed name over its count in an allowed path is reported
    mkdirSync(join(dir, 'packages/engine'), { recursive: true });
    writeFileSync(join(dir, 'packages/engine/cli.mjs'), `${P}E2E_JSON ${P}E2E_JSON`);
    assert.equal(scan(dir, ['packages/engine/cli.mjs']).length, 1);
    writeFileSync(join(dir, 'packages/engine/cli.mjs'), `${P}E2E_JSON`);
    assert.deepEqual(scan(dir, ['packages/engine/cli.mjs']), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
