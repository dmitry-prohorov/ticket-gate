import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { baseDir } from './__tests__/survivors.helpers.mjs';
import { INSTALL_MARKER, ensureBaseInstall } from './__tests__/demo.mjs';

test('MS-B1 a base dir with node_modules but no marker is reinstalled and marked', () => {
  const dir = baseDir();
  let calls = 0;
  ensureBaseInstall(dir, 'abc123', () => {
    calls += 1;
    return { status: 0 };
  });
  assert.equal(calls, 1);
  assert.equal(readFileSync(join(dir, INSTALL_MARKER), 'utf8'), 'abc123');
});

test('MS-B2 a marked dir is not reinstalled; a failed install leaves no marker', () => {
  const marked = baseDir();
  writeFileSync(join(marked, INSTALL_MARKER), 'abc123');
  let calls = 0;
  ensureBaseInstall(marked, 'abc123', () => {
    calls += 1;
    return { status: 0 };
  });
  assert.equal(calls, 0);
  const fresh = baseDir();
  ensureBaseInstall(fresh, 'def456', () => ({ status: 0 }));
  assert.equal(readFileSync(join(fresh, INSTALL_MARKER), 'utf8'), 'def456');
  const failed = baseDir();
  assert.throws(
    () => ensureBaseInstall(failed, 'abc123', () => ({ status: 1 })),
    /exited 1/,
  );
  assert.equal(existsSync(join(failed, INSTALL_MARKER)), false);
});
