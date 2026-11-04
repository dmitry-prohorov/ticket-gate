// lock.mjs ships a declaration file: without it a TypeScript consumer fails TS7016 on
// an import of the engine's lock.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as lock from '../lock.mjs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DTS = join(ENGINE, 'lock.d.mts');

test('LT-1 lock.d.mts exists and is in the packed files', () => {
  assert.ok(existsSync(DTS));
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: ENGINE,
    encoding: 'utf8',
  });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.includes('lock.d.mts'), files.join(', '));
  assert.ok(files.includes('is-main.mjs'));
});

test('LT-2 lock.d.mts declares exactly the names lock.mjs exports', () => {
  const src = readFileSync(DTS, 'utf8');
  const declared = new Set(
    [...src.matchAll(/^export (?:declare )?(?:const|function) (\w+)/gm)].map(
      (m) => m[1],
    ),
  );
  assert.deepEqual([...declared].sort(), Object.keys(lock).sort());
});
