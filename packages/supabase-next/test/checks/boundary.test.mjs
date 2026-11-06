// SB-1..SB-3: the supabase-next checks and pack commands name no project path or command, import only
// node: modules or files inside this package, and never import a gate.config.mjs.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importsOf } from '#engine/checks/surface.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..');
const CHECKS = join(PKG, 'checks');
// commands.mjs lands with the pack-command slice; every rule below covers it from then on.
const COMMANDS = join(PKG, 'commands.mjs');
const files = [
  ...readdirSync(CHECKS)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => join(CHECKS, f)),
  ...(existsSync(COMMANDS) ? [COMMANDS] : []),
];
const testFiles = [
  HERE,
  join(HERE, '__tests__'),
].flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => join(d, f)),
);
// Built from parts so this file carries neither a project name nor a package-scope literal.
const NEEDLES = [
  'apps/',
  'packages/',
  '@fp' + '/',
  'docs/',
  '.claude/',
  '.agents/',
  'tools/',
  'pnpm ',
  'gate.config',
  'family-' + 'planner',
  '@ticket-' + 'gate/',
  'NEXT_PUBLIC_',
  'EXPO_PUBLIC_',
];

/** Code lines: comments removed (a // inside a string is not a comment here; none occur in the files). */
function codeLinesOf(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .filter((l) => l.trim() !== '');
}

test('SB-1 no project literal in packages/supabase-next/checks or commands.mjs', () => {
  for (const f of [
    'db-schema.mjs',
    'env-keys.mjs',
    'kill-group.mjs',
    'stack-preflight.mjs',
    'stack.mjs',
  ])
    assert.ok(
      files.includes(join(CHECKS, f)),
      `${f} is missing from packages/supabase-next/checks`,
    );
  for (const f of files) {
    codeLinesOf(readFileSync(f, 'utf8')).forEach((line, i) => {
      for (const n of NEEDLES)
        assert.ok(
          !line.includes(n),
          `${relative(PKG, f)} code line ${i + 1} holds "${n}": ${line.trim()}. Move the value into the options the caller passes from its gate config.`,
        );
    });
  }
});

test('SB-2 checks/ and commands.mjs import node: or a relative path inside the package', () => {
  for (const f of files) {
    for (const spec of importsOf(readFileSync(f, 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      assert.ok(
        spec.startsWith('.'),
        `${relative(PKG, f)} imports ${spec}: only node: and relative paths are allowed`,
      );
      const target = relative(PKG, join(dirname(f), spec));
      assert.ok(
        !target.startsWith('..'),
        `${relative(PKG, f)} imports ${spec}, which leaves the package`,
      );
    }
  }
});

test('SB-3 no file imports gate.config.mjs', () => {
  for (const f of [...files, ...testFiles]) {
    for (const spec of importsOf(readFileSync(f, 'utf8')))
      assert.ok(
        !spec.endsWith('gate.config.mjs'),
        `${relative(PKG, f)} imports ${spec}. The pack takes its values as options; the project's gate config binds them.`,
      );
  }
});
