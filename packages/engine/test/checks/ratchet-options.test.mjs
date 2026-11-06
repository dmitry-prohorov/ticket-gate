// XS-1: the source-glob expansion behind skillRefs().
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { expandSources } from '../../checks/ratchet-options.mjs';

function put(root, rel) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), 'x\n');
}

test('XS-1 expandSources: globs, literals, node_modules, order', () => {
  const root = mkdtempSync(join(tmpdir(), 'ratchet-options-'));
  try {
    for (const f of [
      's/SKILL.md',
      's/k/SKILL.md',
      'a/x.md',
      'TOP.md',
      'a/sub/y.md',
      's/node_modules/z/SKILL.md',
      's/k/other.md',
    ])
      put(root, f);
    assert.deepEqual(
      expandSources(root, ['a/*.md', 's/**/SKILL.md', 'TOP.md', 'missing.md']),
      ['TOP.md', 'a/x.md', 's/SKILL.md', 's/k/SKILL.md'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
