// The exports map is read per graph, not cached for the process.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { workspaceExports } from '../../selection/workspace-exports.mjs';

const graphCtx = (target) => ({
  root: '/repo',
  exists: () => true,
  readText: () =>
    JSON.stringify({ exports: { './x': `./dist/${target}/index.d.ts` } }),
  viaTs: (name) => ({ file: name }),
});

test('W-1 a rebuilt graph sees a changed exports map', () => {
  const r = workspaceExports('@p', 'p');
  assert.deepEqual(r.resolve('@p/x', 'a.ts', graphCtx('a')), {
    file: './a/index',
  });
  assert.deepEqual(r.resolve('@p/x', 'a.ts', graphCtx('b')), {
    file: './b/index',
  });
});
