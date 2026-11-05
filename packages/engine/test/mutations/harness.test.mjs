// INFRA-57 HP-1..HP-3 (contracts/INFRA-57.md section 5): multi-patch apply and
// restore. In-memory files; no shell, no stack.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPatch, restorePatch } from '../../mutations/harness.mjs';
import { interruptHandler } from '../../mutations/run.mjs';
import './__tests__/bind-consumer.mjs';

const ORIGINALS = {
  'src/a.js': 'alpha beta gamma\nline two\n',
  'src/b.js': 'bravo\nshared\n',
};
const edit = (id, file, find, replace) => ({
  id,
  kind: 'patch',
  file,
  find,
  replace,
});

function memory() {
  const files = { ...ORIGINALS };
  const io = {
    readFile: (p) => files[p],
    writeFile: (p, s) => {
      files[p] = s;
    },
  };
  return { files, io };
}
const untouched = (files) => assert.deepEqual(files, ORIGINALS);

// Two patches in a.js (the second only matches once the first is applied) and one in b.js.
const THREE = () => [
  edit('M1', 'src/a.js', 'alpha', 'ALPHA'),
  edit('M2', 'src/b.js', 'bravo', 'BRAVO'),
  edit('M3', 'src/a.js', 'ALPHA beta', 'X'),
];

test('HP-1 applyPatch and restorePatch put every live file back byte-identical', () => {
  const { files, io } = memory();
  const state = {};
  applyPatch(THREE(), io, state);
  assert.equal(files['src/a.js'], 'X gamma\nline two\n');
  assert.equal(files['src/b.js'], 'BRAVO\nshared\n');
  assert.equal(state.live.size, 2, 'one original per file, recorded once');
  assert.equal(typeof state.restore, 'function');

  restorePatch(state, io);
  untouched(files);
  assert.equal(state.live.size, 0);
  assert.equal(state.restore, null);

  // The recorded original is the first one: a second patch in the same file
  // must not overwrite it with the half-patched text.
  const again = memory();
  const s2 = {};
  applyPatch(THREE(), again.io, s2);
  s2.restore();
  untouched(again.files);

  // A write that does not stick is reported with today's text.
  const stuck = memory();
  const s3 = {};
  applyPatch(THREE(), stuck.io, s3);
  const real = stuck.io.writeFile;
  stuck.io.writeFile = (p, s) => {
    if (p !== 'src/b.js') real(p, s);
  };
  assert.throws(
    () => restorePatch(s3, stuck.io),
    /restore of src\/b\.js is not byte-identical/,
  );
});

test('HP-2 a find that no longer occurs once with the others applied throws and leaves the tree as it was', () => {
  // M3 occurs once in the original but twice after M1 rewrites alpha to beta.
  const twice = [
    edit('M1', 'src/a.js', 'alpha', 'beta'),
    edit('M2', 'src/b.js', 'bravo', 'BRAVO'),
    edit('M3', 'src/a.js', 'beta', 'B'),
  ];
  const a = memory();
  assert.throws(
    () => applyPatch(twice, a.io, {}),
    /M3: find no longer occurs once with the other patches applied/,
  );
  untouched(a.files);

  // Zero occurrences is the same error.
  const gone = [
    edit('M1', 'src/b.js', 'bravo', 'BRAVO'),
    edit('M4', 'src/a.js', 'nowhere', 'x'),
  ];
  const b = memory();
  assert.throws(
    () => applyPatch(gone, b.io, {}),
    /M4: find no longer occurs once with the other patches applied/,
  );
  untouched(b.files);
});

test('HP-3 a SIGINT with two live patches restores both and exits 130', async () => {
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    const { files, io } = memory();
    const state = {};
    applyPatch(THREE(), io, state);
    assert.notDeepEqual(files, ORIGINALS, 'patches are live before the signal');
    const exits = [];
    await interruptHandler(state, io, (c) => exits.push(c), signal);
    untouched(files);
    assert.equal(state.live.size, 0);
    assert.deepEqual(exits, [code]);
  }
});
