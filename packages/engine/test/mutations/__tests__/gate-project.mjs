// A throwaway git project with a gate.config.mjs, for tests that spawn the engine bin.
// Nothing here names a real consumer; the registry holds patch entries over a tiny module.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '../../..');
export const BIN = join(ENGINE, 'bin', 'ticket-gate.mjs');
export const CONFIG_URL = pathToFileURL(join(ENGINE, 'config.mjs')).href;
export const PACK_URL = pathToFileURL(
  join(ENGINE, '..', 'supabase-next', 'index.mjs'),
).href;

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

export const GUARD = `export function check(n) {
  if (n === 0) throw new Error('zero');
  return n;
}
`;
export const GUARD_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from './guard.mjs';
test('G-1 zero throws', () => {
  assert.throws(() => check(0));
  assert.equal(check(2), 2);
});
`;
export const FIND = "if (n === 0) throw new Error('zero');";
export const SURVIVOR_FIND = "new Error('zero')";
export const TEST_CMD =
  "node --test --test-name-pattern='^G-1 ' src/guard.test.mjs";

const entry = (over = {}) => ({
  kind: 'patch',
  protects: '5 G-1 zero must throw',
  file: 'src/guard.mjs',
  find: FIND,
  replace: '',
  test: TEST_CMD,
  testFile: 'src/guard.test.mjs',
  testName: 'G-1 zero throws',
  ...over,
});
export const entries = {
  'T/M1': entry(),
  'T/M2': entry({
    protects: '5 G-1 the message is kept',
    find: SURVIVOR_FIND,
    replace: "new Error('other')",
  }),
};

/**
 * A git repo on branch `feat` (base `main`) holding src/guard.mjs, its test, the registry
 * `mutation-registry/src.json` and `gate.config.mjs` = `config` (a source string).
 */
export function gateProject({
  config = `import { defineGate } from ${JSON.stringify(CONFIG_URL)};\nexport default defineGate({ steps: [], mutations: {} });\n`,
  registry = entries,
  files = {},
} = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-proj-')));
  dirs.push(dir);
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: dir,
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put('src/guard.mjs', GUARD);
  put('src/guard.test.mjs', GUARD_TEST);
  put('gate.config.mjs', config);
  put('.gitignore', '.turbo/\n');
  if (registry !== null)
    put('mutation-registry/src.json', `${JSON.stringify(registry, null, 2)}\n`);
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  return { dir, put, git };
}

/** Run the bin in `cwd` with a constrained environment; returns { status, out }. */
export function bin(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
