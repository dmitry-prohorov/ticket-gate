// INFRA-47 5-3..5-6: the two published packages are what the contract says.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO, repoFiles } from './repo-files.mjs';

const VERSION = '0.1.0-rc.1';
const PACKAGES = ['engine', 'supabase-next', 'react'];
// Built from parts: this file is a tracked .mjs, and 5-4a forbids the scope there.
const SCOPE = '@ticket-' + 'gate/';

const read = (rel) => readFileSync(join(REPO, rel), 'utf8');
const manifest = (name) => JSON.parse(read(`packages/${name}/package.json`));

test('INFRA-47 5-3 manifests pin 0.1.0-rc.1 under Apache-2.0', () => {
  for (const name of PACKAGES) {
    const m = manifest(name);
    assert.equal(m.name, `${SCOPE}${name}`);
    assert.equal(m.version, VERSION, `${name} version`);
    assert.equal(m.license, 'Apache-2.0', `${name} license`);
    assert.equal(m.type, 'module');
    assert.equal(m.engines?.node, '>=22');
    assert.equal(m.repository?.type, 'git');
    assert.equal(
      m.repository?.url,
      'git+https://github.com/dmitry-prohorov/ticket-gate.git',
      `${name} repository.url (provenance checks it)`,
    );
    assert.equal(m.repository?.directory, `packages/${name}`, `${name} repository.directory`);
    assert.equal(m.publishConfig?.provenance, true, `${name} provenance`);
    assert.equal(m.publishConfig?.access, 'public', `${name} access`);
    assert.equal(
      read(`packages/${name}/LICENSE`),
      read('LICENSE'),
      `${name}/LICENSE must be byte-identical to the root LICENSE`,
    );
  }
  const engine = manifest('engine');
  const pack = manifest('supabase-next');
  const react = manifest('react');
  for (const dependent of [pack, react]) {
    assert.equal(dependent.dependencies?.[engine.name], VERSION, `${dependent.name}: engine dependency must be an exact pin`);
    assert.equal(dependent.imports?.['#engine/*'], `${engine.name}/*`);
  }
  assert.deepEqual(engine.bin, { 'ticket-gate': 'bin/ticket-gate.mjs' });
  assert.equal(engine.dependencies, undefined, 'the engine has zero runtime dependencies');
  assert.deepEqual(
    Object.keys(pack.dependencies ?? {}),
    [engine.name],
    'the pack depends on the engine only',
  );
  assert.deepEqual(
    Object.keys(react.dependencies ?? {}),
    [engine.name],
    'the react package depends on the engine only (@babel/core, the plugin and jscpd are resolved from the project)',
  );
});

// Pure so 5-4b can aim it at a planted tree.
export function scopeHits(root, files) {
  const hits = [];
  for (const f of files) {
    if (!f.endsWith('.mjs')) continue;
    if (/^packages\/[^/]+\/test\/fixtures\//.test(f)) continue;
    if (readFileSync(join(root, f), 'utf8').includes(SCOPE)) hits.push(f);
  }
  return hits;
}

test('INFRA-47 5-4a no .mjs outside test fixtures names the scope', () => {
  assert.deepEqual(
    scopeHits(REPO, repoFiles()),
    [],
    'Read the package name from package.json instead of writing it in code (proposal 4.11).',
  );
});

test('INFRA-47 5-4b scope scan catches a planted import', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-scope-'));
  try {
    mkdirSync(join(root, 'packages/engine/test/fixtures'), { recursive: true });
    writeFileSync(join(root, 'bad.mjs'), `import '${SCOPE}engine';\n`);
    writeFileSync(join(root, 'ok.mjs'), "import 'node:fs';\n");
    writeFileSync(join(root, 'packages/engine/test/fixtures/m.mjs'), `import '${SCOPE}engine';\n`);
    assert.deepEqual(scopeHits(root, ['bad.mjs', 'ok.mjs', 'packages/engine/test/fixtures/m.mjs']), [
      'bad.mjs',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function packList(name) {
  const out = execFileSync(
    'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts', '-w', `packages/${name}`],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out)[0].files.map((f) => f.path);
}

test('INFRA-47 5-5 tarballs ship no tests', () => {
  const required = {
    engine: ['LICENSE', 'README.md', 'package.json', 'bin/ticket-gate.mjs', 'config.mjs'],
    'supabase-next': [
      'LICENSE',
      'README.md',
      'package.json',
      'index.mjs',
      'commands.mjs',
      'checks/db-schema.mjs',
      'checks/stack-preflight.mjs',
    ],
    react: ['LICENSE', 'README.md', 'package.json', 'compiler.mjs'],
  };
  for (const name of PACKAGES) {
    const files = packList(name);
    assert.deepEqual(
      files.filter((p) => /(^|\/)test\//.test(p) || /\.test\.mjs$/.test(p)),
      [],
      `${name} tarball lists test files; fix "files" in packages/${name}/package.json`,
    );
    for (const need of required[name]) {
      assert.ok(files.includes(need), `${name} tarball is missing ${need}`);
    }
    if (name === 'engine') {
      assert.ok(
        files.some((p) => p.startsWith('hooks/')),
        'engine tarball is missing hooks/',
      );
    }
  }
});

test('INFRA-47 5-6 bin has a node shebang and pack imports resolve', () => {
  const bin = read('packages/engine/bin/ticket-gate.mjs');
  assert.equal(bin.split('\n')[0], '#!/usr/bin/env node');

  const pack = manifest('supabase-next');
  const target = pack.imports['#engine/*'];
  const packDir = join(REPO, 'packages/supabase-next');
  const requireFromPack = createRequire(join(packDir, 'index.mjs'));
  const engineDir = join(REPO, 'packages/engine');
  let seen = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(join(dir, e.name));
        continue;
      }
      if (!e.name.endsWith('.mjs')) continue;
      const src = readFileSync(join(dir, e.name), 'utf8');
      for (const m of src.matchAll(/['"]#engine\/([^'"]+)['"]/g)) {
        seen += 1;
        const resolved = requireFromPack.resolve(target.replace('*', m[1]));
        assert.equal(
          resolved,
          join(engineDir, m[1]),
          `#engine/${m[1]} in ${e.name} resolves outside the engine package; run npm ci`,
        );
      }
    }
  };
  walk(packDir);
  assert.ok(seen > 0, 'no #engine/ import found: the guard would pass on nothing');
});
