// INFRA-47 5-9: the release script refuses before it tags, never pushes or publishes, and
// proves the manifests match a tag. Each case runs a copy of the scripts inside a temp git
// repo, with PATH holding only recording stubs, so nothing real is scanned, pushed or tagged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const SCRIPTS = import.meta.dirname;
const REPO = join(SCRIPTS, '..');
const NOREPLY = '11081166+dmitry-prohorov@users.noreply.github.com';
const OLD = '0.0.1';
const NEW = '0.1.0-rc.1';
const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
const scratch = [];
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  scratch.push(d);
  return d;
};
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

function sh(file, body) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

// Stub bin dirs are built once: the first run of a new executable is slow on some systems.
// Behaviour comes from the environment of each run (STUB_LOG, GITLEAKS_EXIT, TRUFFLEHOG_EXIT).
const BIN_DIRS = {};
function binDir(omit) {
  const key = omit ?? 'none';
  if (BIN_DIRS[key]) return BIN_DIRS[key];
  const dir = tmp('tg-rel-bin-');
  sh(join(dir, 'git'), `echo "git $*" >> "$STUB_LOG"\nexec "${REAL_GIT}" "$@"`);
  sh(join(dir, 'pnpm'), 'echo "pnpm $*" >> "$STUB_LOG"\nexit 0');
  if (omit !== 'gitleaks')
    sh(join(dir, 'gitleaks'), 'echo "gitleaks $*" >> "$STUB_LOG"\necho clean\nexit ${GITLEAKS_EXIT:-0}');
  if (omit !== 'trufflehog')
    sh(join(dir, 'trufflehog'), 'echo "trufflehog $*" >> "$STUB_LOG"\necho scanned\nexit ${TRUFFLEHOG_EXIT:-0}');
  return (BIN_DIRS[key] = dir);
}

/** A per-run stub set: recording git and pnpm, scanners that exit as told. */
function stubs({ gitleaks = 0, trufflehog = 0, omit } = {}) {
  const log = join(tmp('tg-rel-log-'), 'calls.log');
  writeFileSync(log, '');
  return {
    dir: binDir(omit),
    env: { STUB_LOG: log, GITLEAKS_EXIT: String(gitleaks), TRUFFLEHOG_EXIT: String(trufflehog) },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

function gitIn(dir, args) {
  const r = spawnSync(REAL_GIT, args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: NOREPLY,
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: NOREPLY,
    },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function pkg(name, version, deps) {
  return `${JSON.stringify({ name, version, ...(deps ? { dependencies: deps } : {}) }, null, 2)}\n`;
}

function mkProject({ changelog = '## Unreleased\n\n- Added a thing.\n', version = OLD } = {}) {
  const dir = tmp('tg-rel-repo-');
  gitIn(dir, ['init', '-q', '-b', 'main']);
  mkdirSync(join(dir, 'scripts'));
  for (const f of ['release.mjs', 'scrub.mjs']) copyFileSync(join(SCRIPTS, f), join(dir, 'scripts', f));
  mkdirSync(join(dir, 'packages/engine'), { recursive: true });
  mkdirSync(join(dir, 'packages/pack'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "name": "w", "private": true, "scripts": { "test": "true" } }\n');
  writeFileSync(join(dir, '.gitignore'), '.release/\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  writeFileSync(join(dir, 'packages/engine/package.json'), pkg('acme-engine', version));
  writeFileSync(join(dir, 'packages/pack/package.json'), pkg('acme-pack', version, { 'acme-engine': version }));
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function denylist() {
  const d = tmp('tg-rel-deny-');
  const f = join(d, 'denylist.env');
  writeFileSync(f, 'DENY=zorblax-widgets\n');
  return f;
}

function release(dir, args, { bin = stubs(), deny = denylist(), env: extra = {} } = {}) {
  const env = { PATH: bin.dir, HOME: dir, LANG: 'C', ...bin.env };
  if (deny) env.TICKET_GATE_DENYLIST = deny;
  const r = spawnSync(process.execPath, [join(dir, 'scripts/release.mjs'), ...args], {
    cwd: dir,
    env: {
      ...env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'tester',
      GIT_AUTHOR_EMAIL: NOREPLY,
      GIT_COMMITTER_NAME: 'tester',
      GIT_COMMITTER_EMAIL: NOREPLY,
      ...extra,
    },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, bin };
}

const tags = (dir) => gitIn(dir, ['tag', '--list']);
const json = (dir, p) => JSON.parse(readFileSync(join(dir, p), 'utf8'));

test('INFRA-47 5-9a dirty tree or existing tag refuses, no tag', () => {
  const dirty = mkProject();
  writeFileSync(join(dirty, 'stray.txt'), 'x\n');
  const a = release(dirty, [NEW]);
  assert.equal(a.code, 1);
  assert.match(a.out, /not clean/);
  assert.equal(tags(dirty), '');

  const tagged = mkProject();
  gitIn(tagged, ['tag', '-a', `v${NEW}`, '-m', 'old']);
  const head = gitIn(tagged, ['rev-parse', 'HEAD']);
  const b = release(tagged, [NEW]);
  assert.equal(b.code, 1);
  assert.match(b.out, /already exists/);
  assert.equal(gitIn(tagged, ['rev-parse', `v${NEW}^{commit}`]), head);

  const off = mkProject();
  gitIn(off, ['checkout', '-q', '-b', 'topic']);
  assert.match(release(off, [NEW]).out, /not "topic"/);
  assert.equal(tags(off), '');

  assert.equal(release(mkProject(), ['v1']).code, 1, 'a malformed version refuses');
  assert.equal(release(mkProject(), []).code, 2, 'no version is a usage error');
});

test('INFRA-47 5-9b unset denylist refuses', () => {
  const dir = mkProject();
  const r = release(dir, [NEW], { deny: null });
  assert.equal(r.code, 1);
  assert.match(r.out, /TICKET_GATE_DENYLIST is unset/);
  assert.equal(tags(dir), '');
  assert.deepEqual(r.bin.calls().filter((c) => /^(gitleaks|trufflehog)/.test(c)), []);
});

test('INFRA-47 5-9c missing scanner exits 2', () => {
  for (const omit of [['gitleaks'], ['trufflehog']]) {
    const dir = mkProject();
    const r = release(dir, [NEW], { bin: stubs({ omit: omit[0] }) });
    assert.equal(r.code, 2, `${omit} missing`);
    assert.match(r.out, new RegExp(`${omit[0]}.*not found on PATH`));
    assert.match(r.out, /Install/);
    assert.equal(tags(dir), '');
  }
});

test('INFRA-47 5-9d scanner finding stops before the tag', () => {
  for (const [name, bin] of [
    ['trufflehog', stubs({ trufflehog: 1 })],
    ['gitleaks', stubs({ gitleaks: 1 })],
  ]) {
    const dir = mkProject();
    const r = release(dir, [NEW], { bin });
    assert.equal(r.code, 1, name);
    assert.match(r.out, new RegExp(`${name} reported findings`));
    assert.equal(tags(dir), '');
    assert.ok(existsSync(join(dir, '.release', NEW, `${name}.txt`)), 'scanner output is kept');
    assert.equal(json(dir, 'packages/engine/package.json').version, OLD, 'versions untouched');
  }
});

test('INFRA-47 5-9e happy path tags and moves CHANGELOG, never pushes', () => {
  const dir = mkProject({ changelog: '# Changelog\n\n## Unreleased\n\n- Added a thing.\n\n## 0.0.1 - 2026-01-01\n\n- First.\n' });
  const r = release(dir, [NEW]);
  assert.equal(r.code, 0, r.out);
  assert.equal(gitIn(dir, ['cat-file', '-t', `refs/tags/v${NEW}`]), 'tag', 'annotated tag');
  assert.equal(gitIn(dir, ['rev-parse', `v${NEW}^{commit}`]), gitIn(dir, ['rev-parse', 'HEAD']));
  assert.equal(gitIn(dir, ['log', '-1', '--format=%s']), `chore(release): v${NEW}`);
  assert.equal(json(dir, 'packages/engine/package.json').version, NEW);
  assert.equal(json(dir, 'packages/pack/package.json').version, NEW);
  assert.equal(json(dir, 'packages/pack/package.json').dependencies['acme-engine'], NEW, 'exact internal dependency');
  const log = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(log, new RegExp(`## Unreleased\\n\\n## ${NEW.replace(/\./g, '\\.')} - \\d{4}-\\d\\d-\\d\\d\\n\\n- Added a thing\\.\\n\\n## 0\\.0\\.1`));
  assert.equal(gitIn(dir, ['status', '--porcelain']), '', 'tree is clean after the release commit');
  assert.ok(existsSync(join(dir, '.release', NEW, 'gitleaks.txt')));
  assert.ok(existsSync(join(dir, '.release', NEW, 'trufflehog.txt')));
  assert.match(r.out, /Nothing was pushed or published/);
  assert.ok(r.out.includes(`origin v${NEW}`), 'prints the tag push command');

  const calls = r.bin.calls();
  assert.ok(calls.some((c) => /^git tag -a /.test(c)), 'the spawn recorder sees the tag');
  assert.ok(calls.includes('pnpm run mutate --registry --all'), 'every registry guard is proven before the tag');
  assert.deepEqual(calls.filter((c) => /^git (push|remote)|^p?npm (publish|login)/.test(c)), []);
});

test('INFRA-47 5-9e an empty Unreleased with no entry refuses before any commit', () => {
  const dir = mkProject({ changelog: '## Unreleased\n\n## 0.0.1 - 2026-01-01\n\n- First.\n' });
  const r = release(dir, [NEW]);
  assert.equal(r.code, 1);
  assert.match(r.out, /"## Unreleased" is empty/);
  assert.equal(tags(dir), '');
  assert.equal(gitIn(dir, ['log', '--format=%s']), 'init');
});

test('INFRA-47 5-9e when versions and the entry already match it tags without an empty commit', () => {
  const dir = mkProject({ version: NEW, changelog: `## Unreleased\n\n## ${NEW} - 2026-01-01\n\n- First.\n` });
  const r = release(dir, [NEW]);
  assert.equal(r.code, 0, r.out);
  assert.equal(gitIn(dir, ['log', '--format=%s']), 'init');
  assert.equal(gitIn(dir, ['cat-file', '-t', `refs/tags/v${NEW}`]), 'tag');
});

test('INFRA-47 5-9f --verify-tag rejects a mismatch', () => {
  const run = (args, cwd = REPO) =>
    spawnSync(process.execPath, [join(SCRIPTS, 'release.mjs'), ...args], { cwd, encoding: 'utf8' });
  assert.equal(run(['--verify-tag', 'v0.1.0']).status, 1, 'manifests say the rc');
  assert.equal(run(['--verify-tag', `v${NEW}`]).status, 0);
  assert.equal(run(['--verify-tag', NEW]).status, 1, 'no leading v');
  assert.equal(run(['--verify-tag']).status, 2);

  for (const spec of [`^${NEW}`, `~${NEW}`, '0.0.9']) {
    const dir = mkProject({ version: NEW });
    writeFileSync(join(dir, 'packages/pack/package.json'), pkg('acme-pack', NEW, { 'acme-engine': spec }));
    const r = spawnSync(process.execPath, [join(dir, 'scripts/release.mjs'), '--verify-tag', `v${NEW}`], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1, `dependency "${spec}" must not pass`);
    assert.match(r.stderr, /exactly/);
  }
  const ok = mkProject({ version: NEW });
  assert.equal(spawnSync(process.execPath, [join(ok, 'scripts/release.mjs'), '--verify-tag', `v${NEW}`], { cwd: ok }).status, 0);
});

test('INFRA-47 5-9g --dry-run writes nothing', () => {
  const dir = mkProject();
  const headBefore = gitIn(dir, ['rev-parse', 'HEAD']);
  const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  const r = release(dir, [NEW, '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /nothing was written/);
  assert.equal(gitIn(dir, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(tags(dir), '');
  assert.equal(gitIn(dir, ['status', '--porcelain', '--ignored']), '');
  assert.equal(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'), before);
  assert.equal(json(dir, 'packages/engine/package.json').version, OLD);
  assert.ok(!existsSync(join(dir, '.release')));
  assert.deepEqual(r.bin.calls().filter((c) => /^(gitleaks|trufflehog) (detect|git)/.test(c)), []);
});

test('INFRA-47 5-9 a non-noreply git identity refuses and writes nothing', () => {
  for (const key of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) {
    const dir = mkProject();
    const head = gitIn(dir, ['rev-parse', 'HEAD']);
    const r = release(dir, [NEW], { env: { [key]: `a${'@'}corp.io` } });
    assert.equal(r.code, 1, key);
    assert.match(r.out, /users\.noreply\.github\.com/);
    assert.match(r.out, /git config user\.email/);
    assert.equal(tags(dir), '');
    assert.equal(gitIn(dir, ['rev-parse', 'HEAD']), head);
    assert.equal(gitIn(dir, ['status', '--porcelain', '--ignored']), '');
  }
});
