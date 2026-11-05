// RP-1: every live patch mutant of a JavaScript file must still parse. A
// mutant that does not parse is "killed" by a load failure, which proves
// nothing about the guard it claims to exercise.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { patchedSource } from '../mutations/locate.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const JS = /\.(m?js|cjs)$/;

function registryFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? registryFiles(join(dir, d.name))
      : d.name.endsWith('.json')
        ? [join(dir, d.name)]
        : [],
  );
}

test('RP-1 every live patch mutant of a JavaScript file parses', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'registry-parse-'));
  const broken = [];
  let checked = 0;
  try {
    for (const file of registryFiles(join(ROOT, 'mutation-registry'))) {
      const entries = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, e] of Object.entries(entries)) {
        if (e.retired || e.kind !== 'patch' || !JS.test(e.file ?? '')) continue;
        checked++;
        let why = null;
        try {
          const src = patchedSource(
            readFileSync(join(ROOT, e.file), 'utf8'),
            e,
          );
          const tmp = join(scratch, `m${checked}${extname(e.file)}`);
          writeFileSync(tmp, src);
          execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
        } catch (err) {
          why = String(err.stderr || err.message)
            .split('\n')
            .find((l) => /Error/.test(l));
        }
        if (why !== null) broken.push(`${key} (${e.file}): ${why}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.ok(checked > 0, 'no live JavaScript patch entries were found');
  assert.deepEqual(
    broken,
    [],
    `these mutants do not parse; re-aim each entry's "replace" so the patched file is valid JavaScript (check with node --check):\n${broken.join('\n')}`,
  );
});
