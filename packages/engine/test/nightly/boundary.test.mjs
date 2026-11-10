// NB-1: the nightly modules name no project path, command or label (the handed-off variable names are not needles).

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'nightly');
const NEEDLES = [
  'apps/',
  'e2e/',
  'supabase',
  '@f' + 'p/',
  'pnpm ',
  'TELEGRAM',
  'family' + 'planner',
  'demo-nightly',
  'docker',
  'mutate-check',
  'stack-preflight',
  'db:reset',
  '../../',
];

test('NB-1 packages/engine/nightly modules name no project path, command or label', () => {
  const files = readdirSync(HERE).filter(
    (f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'),
  );
  assert.ok(files.length >= 8, `scanned ${files.join(', ')}`);
  for (const must of ['run.mjs', 'record.mjs', 'status.mjs', 'schedule.mjs'])
    assert.ok(files.includes(must), `${must} is scanned`);
  const hits = [];
  for (const f of files) {
    const text = readFileSync(join(HERE, f), 'utf8');
    for (const needle of NEEDLES)
      if (text.includes(needle)) hits.push(`${f}: ${needle}`);
  }
  assert.deepEqual(hits, []);
});
