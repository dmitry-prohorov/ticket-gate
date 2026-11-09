// PB-1, PB-2: the profiler names no project path, seed id or component, and reaches the
// engine only through its two lock and serve seams. A project literal here would ship with
// the package. Comments count: the scan reads the whole text.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'profiler');

const BANNED = [
  'apps/',
  'next build',
  'next start',
  '--no-mangling',
  'pnpm ',
  ':3000',
  'localhost',
  '54321',
  '54324',
  '.env.local',
  'fp-profile-web',
  'profile:web',
  'aaaaaaaa-',
  'bbbbbbbb-',
  'cccccccc-',
  '11111111-',
  'mila@example.com',
  'Europe/Kyiv',
  '/calendar',
  '/sign-in',
  '/timetable',
  'gate.config',
  '@f' + 'p/',
  'docs/tasks',
  '.turbo/',
  'GridChip',
  'DayColumn',
  'EventChip',
  'RoutineChip',
  'RoutineFrame',
  'RoutinePlanEditor',
  'RoutinePlanRow',
];
const BANNED_CI = ['supabase', 'mailpit'];
const SCENARIO = /\bW[1-7]\b/;
const ALLOWED_IMPORT =
  /^(node:[\w/]+|#engine\/(lock|serve|nightly\/record|nightly\/seed)\.mjs|\.\/[\w-]+\.mjs)$/;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')
        ? [join(dir, e.name)]
        : [],
  );
}

test('PB-1 the profiler names no project path, seed id or component', () => {
  const files = walk(DIR);
  assert.ok(
    files.length > 0,
    'no module scanned under packages/react/profiler/: the boundary proves nothing',
  );
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const b of BANNED)
      assert.ok(
        !text.includes(b),
        `${f} contains "${b}": move the project value into the profile config the caller passes.`,
      );
    for (const b of BANNED_CI)
      assert.ok(
        !text.toLowerCase().includes(b),
        `${f} contains "${b}" (any case): move it into the supabase-next hooks or the config.`,
      );
    assert.ok(
      !SCENARIO.test(text),
      `${f} names a scenario id (W1..W7): scenario ids belong in the project config.`,
    );
  }
});

test('PB-2 the profiler imports only node:, its engine seams and siblings', () => {
  const files = walk(DIR);
  assert.ok(files.length > 0, 'no module scanned: the boundary proves nothing');
  for (const f of files)
    for (const m of readFileSync(f, 'utf8').matchAll(
      /(?:from|import\()\s*'([^']+)'/g,
    ))
      assert.ok(
        ALLOWED_IMPORT.test(m[1]),
        `${f} imports "${m[1]}": only node:*, #engine/lock.mjs, #engine/serve.mjs and sibling ./*.mjs are allowed`,
      );
});
