// RB-1..RB-3: the files of packages/react name no project path or command and import only
// node: modules or siblings in the package folder.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importsOf } from '../../engine/checks/surface.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const all = readdirSync(DIR).filter((f) => f.endsWith('.mjs'));
const files = all.filter((f) => !f.endsWith('.test.mjs'));
const NEEDLES = [
  'apps/',
  'packages/',
  'supabase',
  'docs/tasks',
  '.claude/',
  '.agents/',
  'pnpm ',
  'gate.config',
];
const EXPO = /\bexpo\b/i;
const APPS_QUOTED = /['"`]apps['"`/]/;

/** Code lines: comments removed (a // inside a string is not a comment here; none occur in the files). */
function codeLinesOf(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .filter((l) => l.trim() !== '');
}

test('RB-1 no project literal in packages/react', () => {
  assert.ok(
    files.includes('compiler.mjs'),
    'compiler.mjs is missing from the package',
  );
  assert.ok(
    !EXPO.test('export function'),
    'the expo regex must not match "export function"',
  );
  assert.ok(
    EXPO.test("'babel-preset-expo'"),
    'the expo regex must match babel-preset-expo',
  );
  assert.ok(
    EXPO.test("'expo/package.json'"),
    'the expo regex must match expo/package.json',
  );
  for (const f of files) {
    codeLinesOf(readFileSync(join(DIR, f), 'utf8')).forEach((line, i) => {
      for (const n of NEEDLES)
        assert.ok(
          !line.includes(n),
          `${f} code line ${i + 1} holds "${n}": ${line.trim()}. Move the value into the options the caller passes from its gate config.`,
        );
      assert.ok(
        !EXPO.test(line) && !APPS_QUOTED.test(line),
        `${f} code line ${i + 1} names a project: ${line.trim()}. Move it into the options the caller passes from its gate config.`,
      );
    });
  }
});

test('RB-2 imports node: or the package', () => {
  for (const f of files) {
    for (const spec of importsOf(readFileSync(join(DIR, f), 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), `${f} imports ${spec}`);
      const target = posix.normalize(posix.join('.', spec));
      assert.ok(
        !target.startsWith('..') && !target.includes('/'),
        `${f} imports ${spec}, which leaves the package`,
      );
    }
  }
});

test('RB-3 no file imports gate.config.mjs', () => {
  for (const f of all) {
    for (const spec of importsOf(readFileSync(join(DIR, f), 'utf8')))
      assert.ok(
        !spec.endsWith('gate.config.mjs'),
        `${f} imports ${spec}. The package takes its values as options; the project's gate config binds them.`,
      );
  }
});
