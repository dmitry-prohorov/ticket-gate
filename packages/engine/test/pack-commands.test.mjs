// PC-*: commands a pack adds through packCommands. Validation cases call defineGate; the dispatch
// case spawns the bin so the exit status is the one a script sees.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ENGINE_COMMANDS } from '../commands-config.mjs';
import { defineGate } from '../config.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(GATE, 'bin', 'ticket-gate.mjs');
const CONFIG_URL = pathToFileURL(join(GATE, 'config.mjs')).href;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const pack = (name, packCommands) => ({ name, version: '1.0.0', packCommands });
const gate = (...packs) => defineGate({ steps: [], packs });

test('PC-1 ticket-gate <name> runs the pack command with args and root and exits with its code', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-pc-')));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'gate.config.mjs'),
    `import { defineGate } from ${JSON.stringify(CONFIG_URL)};
const hello = async (args, { root, gate }) => {
  console.log('hello ' + args.join(' ') + ' in ' + root + ' packs=' + gate.packs.length);
  return 3;
};
const quiet = async () => undefined;
export default defineGate({ steps: [], packs: [{ name: 'p', version: '1', packCommands: { hello, quiet } }] });
`,
  );
  const run = (...args) =>
    spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' });
  const r = run('hello', 'x', '--y');
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stdout, `hello x --y in ${dir} packs=1\n`);
  assert.equal(run('quiet').status, 0);
  const unknown = run('nope');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command nope/);
});

test('PC-2 two packs naming one command is a config error naming both packs', () => {
  assert.throws(
    () => gate(pack('alpha', { go() {} }), pack('beta', { go() {} })),
    /gate\.config: packs: command "go" is given by alpha and beta/,
  );
});

test('PC-3 a pack naming an engine command is a config error', () => {
  assert.throws(
    () => gate(pack('alpha', { ratchet() {} })),
    /gate\.config: packs: alpha names the engine command "ratchet"/,
  );
});

test('PC-4 ENGINE_COMMANDS equals the command names of the bin USAGE', () => {
  const help = spawnSync(process.execPath, [BIN, '--help'], {
    encoding: 'utf8',
  });
  const named = help.stdout
    .split('\n')
    .map((l) => /^ {2}([a-z][a-z-]*)\b/.exec(l)?.[1])
    .filter(Boolean);
  assert.deepEqual([...new Set(named)].sort(), [...ENGINE_COMMANDS].sort());
});

test('PC-5 a non-function packCommands value is a config error; no pack gives an empty packCommands', () => {
  assert.throws(
    () => gate(pack('alpha', 'nope')),
    /alpha: packCommands must be an object of name -> function/,
  );
  assert.throws(
    () => gate(pack('alpha', { go: 1 })),
    /alpha: packCommands\.go must be a function named/,
  );
  assert.throws(
    () => gate(pack('alpha', { Go() {} })),
    /packCommands\.Go must be a function named/,
  );
  assert.deepEqual(gate().packCommands, {});
  assert.deepEqual(Object.keys(gate({ name: 'plain', version: '1' }).packCommands), []);
});

test('PC-6 a command named like an Object.prototype key is unknown; a pack may name one constructor', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-pc-')));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'gate.config.mjs'),
    `import { defineGate } from ${JSON.stringify(CONFIG_URL)};\nexport default defineGate({ steps: [], packs: [] });\n`,
  );
  const r = spawnSync(process.execPath, [BIN, 'constructor'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown command constructor/);
  assert.deepEqual(Object.keys(gate(pack('alpha', { constructor() {} })).packCommands), ['constructor']);
});

test('PC-7 a gate.config importing a missing package reports that import, not an unknown command', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-pc-')));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'gate.config.mjs'),
    `import 'not-installed-pkg';\nimport { defineGate } from ${JSON.stringify(CONFIG_URL)};\nexport default defineGate({ steps: [], packs: [] });\n`,
  );
  const r = spawnSync(process.execPath, [BIN, 'hello'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not-installed/);
  assert.doesNotMatch(r.stderr, /unknown command/);
});
