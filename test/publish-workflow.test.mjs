// INFRA-47 5-10: the publish workflow can run only from a version tag, holds no registry
// secret, and sends a prerelease to the next dist-tag with provenance. The workflow is
// plain block YAML, so these checks read it as text; each helper also runs on a planted
// variant so a check that always passes would fail here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO, repoFiles } from './repo-files.mjs';

const WORKFLOW = '.github/workflows/publish.yml';
const PUBLISH = 'npm ' + 'publish';
const text = () => readFileSync(join(REPO, WORKFLOW), 'utf8');
const code = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** The indented block under a top-level key, as lines (without the key line). */
function block(src, key) {
  const lines = code(src).split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at === -1) return null;
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && !/^\s/.test(l)) break;
    out.push(l);
  }
  return out;
}

export function triggerProblems(src) {
  const on = block(src, 'on');
  if (!on) return ['no on: block'];
  const body = on.join('\n');
  const problems = [];
  for (const bad of ['pull_request', 'pull_request_target', 'workflow_dispatch', 'schedule', 'workflow_run', 'branches', 'release'])
    if (new RegExp(`(^|\\s)${bad}\\b`).test(body)) problems.push(`trigger ${bad}`);
  if (!/^ {2}push:\s*$/m.test(body)) problems.push('no push trigger');
  if (!/^ {4}tags:\s*$/m.test(body)) problems.push('push is not limited to tags');
  const keys = on.filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim());
  if (keys.length !== 1) problems.push(`on: has ${keys.length} events, expected exactly push`);
  return problems;
}

export function permissionProblems(src) {
  const perms = block(src, 'permissions');
  if (!perms) return ['no top-level permissions block'];
  const map = Object.fromEntries(
    perms.filter((l) => l.trim()).map((l) => l.trim().split(/:\s*/)),
  );
  const problems = [];
  if (map['id-token'] !== 'write') problems.push('id-token must be write');
  if (map.contents !== 'read') problems.push('contents must be read');
  for (const [k, v] of Object.entries(map))
    if (v === 'write' && k !== 'id-token') problems.push(`${k}: write`);
  if (/secrets\./.test(src)) problems.push('references secrets.');
  if (!/^ {4}environment: npm-publish\s*$/m.test(code(src))) problems.push('no environment: npm-publish');
  return problems;
}

export function publishProblems(src) {
  const c = code(src);
  const problems = [];
  const uses = [...c.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  if (uses.length < 2) problems.push('expected checkout and setup-node');
  for (const u of uses) if (!/@[0-9a-f]{40}$/.test(u)) problems.push(`action not pinned to a sha: ${u}`);
  if (!/persist-credentials:\s*false/.test(c)) problems.push('checkout persists credentials');
  if (!/node-version:\s*24\b/.test(c)) problems.push('node-version is not 24');
  if (!/registry-url:\s*https:\/\/registry\.npmjs\.org/.test(c)) problems.push('no registry-url');
  if (!/\*-\*\)\s*echo "tag=next"/.test(c)) problems.push('no next dist-tag branch on a hyphenated tag');
  if (!/\*\)\s*echo "tag=latest"/.test(c)) problems.push('no latest branch');
  if (!/node scripts\/release\.mjs --verify-tag "\$GITHUB_REF_NAME"/.test(c)) problems.push('no --verify-tag step');
  if (!/^\s*-\s*run:\s*corepack enable\s*$/m.test(c)) problems.push('no corepack enable');
  if (!/^\s*-\s*run:\s*pnpm install --frozen-lockfile\s*$/m.test(c)) problems.push('no pnpm install --frozen-lockfile');
  if (!/^\s*-\s*run:\s*pnpm test\s*$/m.test(c)) problems.push('no pnpm test');
  const publishes = c.split('\n').filter((l) => l.includes(PUBLISH));
  if (publishes.length !== 3) problems.push(`expected 3 publish lines, found ${publishes.length}`);
  for (const l of publishes) {
    if (!l.includes('--provenance')) problems.push(`publish without --provenance: ${l.trim()}`);
    if (!/--tag "\$DIST_TAG"/.test(l)) problems.push(`publish without the dist-tag: ${l.trim()}`);
    if (!/--access public/.test(l)) problems.push(`publish without --access public: ${l.trim()}`);
  }
  if (!publishes.some((l) => l.includes('packages/engine'))) problems.push('engine is not published');
  const enginePos = c.indexOf('packages/engine --provenance');
  const packPos = c.indexOf('packages/supabase-next --provenance');
  const reactPos = c.indexOf('packages/react --provenance');
  if (enginePos === -1 || packPos === -1 || enginePos > packPos) problems.push('the engine must publish before the pack');
  if (reactPos === -1 || reactPos < packPos) problems.push('the react package must publish after the pack');
  return problems;
}

test('INFRA-47 5-10a only a tag push triggers publish', () => {
  assert.deepEqual(triggerProblems(text()), []);
  const workflows = repoFiles().filter((f) => f.startsWith('.github/'));
  assert.deepEqual(workflows, [WORKFLOW], 'a second workflow or .github file exists');
});

test('INFRA-47 5-10a the trigger check rejects planted triggers', () => {
  const good = text();
  const plant = (extra) => good.replace("on:\n  push:", `on:\n${extra}  push:`);
  for (const extra of ['  pull_request:\n', '  workflow_dispatch:\n', '  schedule:\n']) {
    assert.notDeepEqual(triggerProblems(plant(extra)), [], extra);
  }
  assert.notDeepEqual(triggerProblems(good.replace("    tags:\n      - 'v*'", "    branches:\n      - main")), []);
});

test('INFRA-47 5-10b OIDC permissions and no secrets', () => {
  assert.deepEqual(permissionProblems(text()), []);
  const good = text();
  assert.notDeepEqual(permissionProblems(good.replace('id-token: write', 'id-token: none')), []);
  assert.notDeepEqual(permissionProblems(good.replace('contents: read', 'contents: write')), []);
  assert.notDeepEqual(permissionProblems(`${good}\n# x\n  token: \${{ secrets.NPM_TOKEN }}\n`), []);
  assert.notDeepEqual(permissionProblems(good.replace('environment: npm-publish\n', '')), []);
});

test(`INFRA-47 5-10c ${PUBLISH} appears only in publish.yml`, () => {
  const offenders = repoFiles().filter((f) => {
    if (f === WORKFLOW || f === 'README.md' || f === 'CHANGELOG.md') return false;
    if (f === 'pnpm-lock.yaml') return false;
    return readFileSync(join(REPO, f), 'utf8').includes(PUBLISH);
  });
  assert.deepEqual(offenders, []);
});

test('INFRA-47 5-10d prerelease goes to next with provenance', () => {
  assert.deepEqual(publishProblems(text()), []);
  const good = text();
  assert.notDeepEqual(publishProblems(good.replace('--provenance', '')), []);
  assert.notDeepEqual(publishProblems(good.replace('tag=next', 'tag=latest')), []);
  assert.notDeepEqual(publishProblems(good.replace('*-*)', '*)')), []);
  assert.notDeepEqual(publishProblems(good.replace(/(actions\/checkout)@[0-9a-f]{40}/, '$1@v4')), []);
  assert.notDeepEqual(publishProblems(good.replace('persist-credentials: false', 'persist-credentials: true')), []);
  assert.notDeepEqual(publishProblems(good.replace('--verify-tag', '--noop')), []);
  assert.notDeepEqual(publishProblems(good.replace('--frozen-lockfile', '')), []);
  assert.notDeepEqual(
    publishProblems(
      good
        .replace('packages/react --provenance', 'packages/XX --provenance')
        .replace('packages/supabase-next --provenance', 'packages/react --provenance')
        .replace('packages/XX --provenance', 'packages/supabase-next --provenance'),
    ),
    [],
  );
});
