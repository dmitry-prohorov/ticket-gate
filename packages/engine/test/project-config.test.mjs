import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = pathToFileURL(fileURLToPath(new URL('../project.mjs', import.meta.url))).href;
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch(name, config) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)));
  dirs.push(dir);
  if (config !== undefined) writeFileSync(join(dir, 'gate.config.mjs'), config);
  return dir;
}

function loaded(cwd, env = {}) {
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { GATE, ROOT } = await import(${JSON.stringify(PROJECT)});` +
        'console.log(JSON.stringify({ which: GATE.which, root: ROOT }));',
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, TICKET_GATE_CONFIG_DIR: '', ...env } },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('PC-1 the gate config is the project root gate.config.mjs unless TICKET_GATE_CONFIG_DIR names another directory', () => {
  const root = scratch('pc-root', "export default { which: 'root' };");
  const other = scratch('pc-other', "export default { which: 'other' };");
  assert.deepEqual(loaded(root), { which: 'root', root });
  // An absolute override wins; the project root stays the working directory's.
  assert.deepEqual(loaded(root, { TICKET_GATE_CONFIG_DIR: other }), { which: 'other', root });
  // A relative override resolves against the working directory, and works with no config at the root.
  const bare = scratch('pc-bare');
  mkdirSync(join(bare, 'sub'));
  writeFileSync(join(bare, 'sub', 'gate.config.mjs'), "export default { which: 'rel' };");
  assert.equal(loaded(bare, { TICKET_GATE_CONFIG_DIR: 'sub' }).which, 'rel');
});

test('PC-2 TICKET_GATE_ROOT pins the project root over the walk; unset, the walk is unchanged', () => {
  const outer = scratch('pc-outer', "export default { which: 'outer' };");
  const inner = join(outer, 'inner');
  mkdirSync(inner);
  const pinned = scratch('pc-pinned');
  // Unset (or empty): the nearest ancestor with a config is the root.
  assert.equal(loaded(inner).root, outer);
  // Set: the root is that directory, an ancestor's config is not adopted.
  assert.equal(loaded(inner, { TICKET_GATE_ROOT: pinned, TICKET_GATE_CONFIG_DIR: outer }).root, pinned);
  // A relative value resolves against the working directory.
  mkdirSync(join(inner, 'rel'));
  assert.equal(
    loaded(inner, { TICKET_GATE_ROOT: 'rel', TICKET_GATE_CONFIG_DIR: outer }).root,
    join(inner, 'rel'),
  );
});
