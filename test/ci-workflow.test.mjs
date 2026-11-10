// The CI workflow only reads: it runs the pull-request gate, holds no secret and no write
// permission, and never publishes. Its `tests` job name is what the README badge reads.
// Plain block YAML, read as text like publish.yml; each helper also runs on a planted variant.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO } from './repo-files.mjs';

const WORKFLOW = '.github/workflows/ci.yml';
const PUBLISH = 'npm ' + 'publish';
const text = () => readFileSync(join(REPO, WORKFLOW), 'utf8');
const code = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

export function ciProblems(src) {
  const c = code(src);
  const problems = [];
  if (!/^permissions:\n {2}contents: read\n(?! )/m.test(c)) problems.push('permissions must be exactly contents: read');
  if (/:\s*write\b/.test(c)) problems.push('a write permission');
  if (/secrets\./.test(c)) problems.push('references secrets.');
  if (c.includes(PUBLISH)) problems.push('publishes');
  if (/pull_request_target/.test(c)) problems.push('pull_request_target runs fork code with base permissions');
  const uses = [...c.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  for (const u of uses) if (!/@[0-9a-f]{40}$/.test(u)) problems.push(`action not pinned to a sha: ${u}`);
  const checkouts = c.match(/actions\/checkout@/g)?.length ?? 0;
  const noCreds = c.match(/persist-credentials:\s*false/g)?.length ?? 0;
  if (checkouts !== noCreds) problems.push('a checkout persists credentials');
  if (!/^ {4}name: tests\s*$/m.test(c)) problems.push('no job named exactly tests (the README badge reads it)');
  for (const run of ['pnpm install --frozen-lockfile', 'pnpm test', 'pnpm run scrub', 'pnpm run mutations:check'])
    if (!new RegExp(`^\\s*-\\s*run:\\s*${run.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(c))
      problems.push(`no ${run}`);
  return problems;
}

test('CI-1 the CI workflow only reads and runs the pull-request gate', () => {
  assert.deepEqual(ciProblems(text()), []);
});

test('CI-1 the CI check rejects planted problems', () => {
  const good = text();
  for (const bad of [
    good.replace('contents: read', 'contents: write'),
    good.replace('contents: read', 'contents: read\n  id-token: write'),
    `${good}\n      - run: echo \${{ secrets.NPM_TOKEN }}\n`,
    `${good}\n      - run: ${PUBLISH} ./packages/engine\n`,
    good.replace('  pull_request:', '  pull_request_target:'),
    good.replace(/(actions\/checkout)@[0-9a-f]{40}/, '$1@v4'),
    good.replace('persist-credentials: false', 'persist-credentials: true'),
    good.replace('    name: tests\n', '    name: all tests\n'),
    good.replace('- run: pnpm run scrub', '- run: echo skip'),
  ])
    assert.notDeepEqual(ciProblems(bad), []);
});
