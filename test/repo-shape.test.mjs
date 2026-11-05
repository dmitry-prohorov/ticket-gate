// INFRA-47 5-2: the public repo holds the engine, the pack and their tooling,
// and nothing from the project the code was extracted from.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { REPO, repoFiles } from './repo-files.mjs';

const ALLOWED = [
  /^(package\.json|package-lock\.json|\.gitignore|LICENSE|README\.md|CHANGELOG\.md)$/,
  /^packages\/(engine|supabase-next)\/.+/,
  /^scripts\/[^/]+\.mjs$/,
  /^mutation-registry\/.+\.json$/,
  /^test\/[^/]+\.mjs$/,
  /^\.github\/workflows\/publish\.yml$/,
];

// Named so the failure says what is wrong, not only that a path is unlisted.
const FORBIDDEN = [
  [/^gate\.config\.mjs$/, 'a project gate.config.mjs belongs to the consumer'],
  [/^\.ticket-gate\//, 'a project hook shim belongs to the consumer'],
  [/^docs\//, 'docs/ is project material'],
  [/^\.(claude|cursor|agents)\//, 'agent tooling is project material'],
  [/(^|\/)(AGENTS|MEMORY)\.md$/, 'agent memory is project material'],
  [/receipt[^/]*\.json$/, 'a receipt is a local verification artifact'],
  [/^templates\//, 'no templates ship at rc.1 (FU251)'],
  [/^\.github\/(?!workflows\/publish\.yml$)/, 'publish.yml is the only workflow'],
];

export function shapeViolations(files) {
  const out = [];
  for (const f of files) {
    const bad = FORBIDDEN.find(([re]) => re.test(f));
    if (bad) out.push(`${f}: ${bad[1]}`);
    else if (!ALLOWED.some((re) => re.test(f))) out.push(`${f}: not in the allowlist`);
  }
  return out;
}

test('INFRA-47 5-2 tracked files stay within the allowlist', () => {
  const violations = shapeViolations(repoFiles());
  assert.deepEqual(
    violations,
    [],
    'Remove the file, or add its path pattern to ALLOWED in test/repo-shape.test.mjs ' +
      'only if it belongs in the public repo.',
  );
});

test('INFRA-47 5-2 the allowlist rejects each named intruder', () => {
  const planted = [
    'gate.config.mjs',
    'docs/tasks/a.md',
    '.claude/settings.json',
    'AGENTS.md',
    'x.old-receipt.json',
    'templates/hook.mjs',
    '.github/workflows/ci.yml',
    'stray.txt',
  ];
  assert.equal(shapeViolations(planted).length, planted.length);
  assert.deepEqual(
    shapeViolations([
      'packages/engine/test/fixtures/salesforce/gate.config.mjs',
      '.github/workflows/publish.yml',
      'README.md',
    ]),
    [],
  );
});

test('INFRA-47 5-11 README names npm test and npm run check', () => {
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  assert.match(readme, /npm test\b/);
  assert.match(readme, /npm run check\b/);
});

// The README's example is code a reader will paste; it must load and validate.
test('INFRA-47 5-11 the README gate.config.mjs example validates', async () => {
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  const m = /```js\n([\s\S]*?)```/.exec(readme);
  assert.ok(m, 'README has no js example');
  const configUrl = pathToFileURL(join(REPO, 'packages/engine/config.mjs')).href;
  const src = m[1].replace(/from '[^']+';/, `from '${configUrl}';`);
  const dir = mkdtempSync(join(tmpdir(), 'tg-readme-'));
  try {
    const file = join(dir, 'gate.config.mjs');
    writeFileSync(file, src);
    const mod = await import(pathToFileURL(file).href);
    assert.equal(mod.default.steps.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('INFRA-47 5-2b a file deleted on disk but still staged is not in the file set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-files-'));
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: dir,
    });
  git('init', '-q');
  writeFileSync(join(dir, 'keep.mjs'), '');
  writeFileSync(join(dir, 'gone.mjs'), '');
  git('add', '-A');
  git('commit', '-qm', 'base');
  rmSync(join(dir, 'gone.mjs'));
  assert.deepEqual(repoFiles(dir), ['keep.mjs']);
  rmSync(dir, { recursive: true, force: true });
});
