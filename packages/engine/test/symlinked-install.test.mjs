// The entry-point guards must fire when the engine is reached through a symlink, as pnpm installs
// it (node_modules/<scope>/engine -> the real dir) and as .bin links the CLI. A guard that
// compares import.meta.url with argv[1] as URLs never matches there: the hook exits 0 in silence
// (fail-open) and the CLI does nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(realpathSync(tmpdir()), 'tg-symlink-'));
after(() => rmSync(root, { recursive: true, force: true }));

const NAME = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8')).name;
const linked = join(root, 'node_modules', ...NAME.split('/'));
mkdirSync(dirname(linked), { recursive: true });
symlinkSync(ENGINE, linked, 'dir');
const binDir = join(root, 'node_modules', '.bin');
mkdirSync(binDir, { recursive: true });
symlinkSync(join(linked, 'bin', 'ticket-gate.mjs'), join(binDir, 'ticket-gate'));

const run = (file, args, input) =>
  spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
  });

test('SL-1 the pre-tool-use hook denies a push to main through the symlinked path', () => {
  const payload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
  });
  const r = run(join(linked, 'hooks', 'pre-tool-use.mjs'), [], payload);
  assert.match(r.stdout, /"permissionDecision"\s*:\s*"deny"/);
});

test('SL-2 the CLI prints its usage through the symlinked path', () => {
  const r = run(join(linked, 'bin', 'ticket-gate.mjs'), ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /usage: ticket-gate/);
});

test('SL-3 the CLI prints its usage through a symlinked .bin entry', () => {
  const r = run(join(binDir, 'ticket-gate'), ['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, /usage: ticket-gate/);
});

test('SL-4 an unknown command through the symlink exits 2, not silently 0', () => {
  const r = run(join(binDir, 'ticket-gate'), ['nonsense']);
  assert.equal(r.status, 2);
});
