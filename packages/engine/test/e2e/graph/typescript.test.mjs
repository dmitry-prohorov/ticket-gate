// G-5a, G-5b: typescript is resolved from the project at call time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SelectionConfigError } from '../../../selection/define.mjs';
import { cleanup } from '../__tests__/two-source.mjs';
import { typescript } from '../../../graph/typescript.mjs';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../../../..');
const tmps = [];
const emptyProject = () => {
  const d = mkdtempSync(join(tmpdir(), 'e2e-no-ts-'));
  tmps.push(d);
  return d;
};
after(() => {
  cleanup();
  tmps.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

test('G-5a a missing typescript in the project is a config error naming the install', () => {
  const dir = emptyProject();
  assert.throws(
    () => typescript(dir),
    (err) =>
      err instanceof SelectionConfigError &&
      err.message.includes('typescript') &&
      err.message.includes('install') &&
      err.message.includes(dir) &&
      !err.message.includes('pnpm '),
  );
  assert.equal(typeof typescript(REPO).createSourceFile, 'function');
});

const here = (rel) =>
  pathToFileURL(resolve(REPO, 'packages/engine', rel)).href;
const script = `
const { twoSource, cleanup } = await import(${JSON.stringify(here('test/e2e/__tests__/two-source.mjs'))});
const { select } = await import(${JSON.stringify(here('selection/select.mjs'))});
const f = twoSource({ bArea: 'b' });
const r = select({ root: f.dir, changed: ['classes/Svc.cls'], config: f.cfg });
cleanup();
console.log(JSON.stringify(r));
`;
const child = (cwd) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });

test('G-5b the JS graph resolves typescript from the cwd', () => {
  // control: from the repo root the same child selects fine
  const ok = child(REPO);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).areas, ['a', 'b']);

  const bad = child(emptyProject());
  assert.notEqual(bad.status, 0, bad.stdout);
  assert.match(bad.stderr, /SelectionConfigError/);
  assert.match(bad.stderr, /install/);
});
