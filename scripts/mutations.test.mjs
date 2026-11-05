// The mutation script runs the engine against this repo's own tree. When the repo sits inside
// another project that has a gate.config.mjs (a clone or submodule in a consumer), the engine
// must still take this repo as its root, never the outer project.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const REPO = join(import.meta.dirname, '..');
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('the mutation script takes this repo as the engine root even when an ancestor holds a gate.config.mjs', () => {
  const outer = mkdtempSync(join(tmpdir(), 'tg-mut-outer-'));
  scratch.push(outer);
  writeFileSync(join(outer, 'gate.config.mjs'), 'export default {};\n');
  mkdirSync(join(outer, 'mutation-registry'));
  const inner = join(outer, 'vendor', 'gate');
  mkdirSync(join(inner, 'scripts'), { recursive: true });
  cpSync(join(REPO, 'packages'), join(inner, 'packages'), { recursive: true });
  cpSync(join(REPO, 'mutation-registry'), join(inner, 'mutation-registry'), { recursive: true });
  cpSync(join(REPO, 'package.json'), join(inner, 'package.json'));
  cpSync(join(REPO, 'scripts', 'mutations.mjs'), join(inner, 'scripts', 'mutations.mjs'));
  symlinkSync(join(REPO, 'node_modules'), join(inner, 'node_modules'), 'dir');

  const registry = JSON.parse(readFileSync(join(inner, 'mutation-registry/packages/engine.json'), 'utf8'));
  const id = Object.keys(registry)[0];
  const r = spawnSync(
    process.execPath,
    ['scripts/mutations.mjs', 'mutate', '--registry', `--ids=${id}`, '--dry-run'],
    { cwd: inner, encoding: 'utf8', env: { ...process.env, TICKET_GATE_ROOT: '', TICKET_GATE_CONFIG_DIR: '' } },
  );
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^plan: 1 mutation\(s\)/m);
  assert.ok(r.stdout.includes(id), r.stdout);
  assert.doesNotMatch(r.stderr, /unknown key/);
});
