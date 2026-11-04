#!/usr/bin/env node
// Prepare a release locally: gates, versions, CHANGELOG, a release commit and an annotated tag.
//
//   node scripts/release.mjs <version> [--dry-run]
//   node scripts/release.mjs --verify-tag <tag>
//
// Exit 0 done, 1 a gate failed (nothing was tagged), 2 usage or a missing tool.
//
// This script never runs the commands that leave the machine: it does not push and it
// does not publish. It prints the two push commands for the maintainer to run. The tag
// push starts .github/workflows/publish.yml, which publishes with provenance.
//
// Order, stopping at the first failure: clean tree on main; version shape; tag absent;
// scrub with the denylist required; both scanners present, then run, output kept under
// .release/<version>/; npm test; versions and the exact internal dependency set; the
// CHANGELOG entry; release commit (only when a file changed); annotated tag.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const VERSION_RE = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;
const USAGE =
  'usage: node scripts/release.mjs <version> [--dry-run]   |   node scripts/release.mjs --verify-tag <tag>';

function fail(code, msg) {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(code);
}
const say = (msg) => process.stdout.write(`${msg}\n`);

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
}
const git = (...args) => run('git', args);

/** Every workspace package: { dir, file, text, json }. */
function workspacePackages() {
  const base = join(ROOT, 'packages');
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const file = join(base, e.name, 'package.json');
      const text = readFileSync(file, 'utf8');
      return { dir: e.name, file, text, json: JSON.parse(text) };
    });
}

/** Problems that make a package set unfit to publish as `version`; [] when fit. */
function versionProblems(pkgs, version) {
  const problems = [];
  const names = new Set(pkgs.map((p) => p.json.name));
  for (const p of pkgs) {
    if (p.json.version !== version)
      problems.push(`${p.json.name} is ${p.json.version}, expected ${version}`);
    for (const [dep, spec] of Object.entries(p.json.dependencies ?? {}))
      if (names.has(dep) && spec !== version)
        problems.push(`${p.json.name} depends on ${dep} at "${spec}", expected exactly "${version}"`);
  }
  return problems;
}

function verifyTag(tag) {
  const m = /^v(.+)$/.exec(tag ?? '');
  if (!m || !VERSION_RE.test(m[1])) fail(1, `"${tag}" is not a v<major>.<minor>.<patch>[-rc.<n>] tag.`);
  const problems = versionProblems(workspacePackages(), m[1]);
  if (problems.length)
    fail(
      1,
      `the tag does not match the manifests:\n  ${problems.join('\n  ')}\n` +
        'Run node scripts/release.mjs <version> on main, then tag from that commit.',
    );
  say(`release: manifests match ${tag}`);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The CHANGELOG with `## Unreleased` moved under `## <version> - <date>`; same text when already there. */
function moveChangelog(text, version, date) {
  const lines = text.split('\n');
  if (lines.some((l) => new RegExp(`^## ${escapeRe(version)}( - .*)?\\s*$`).test(l))) return text;
  const at = lines.findIndex((l) => /^## Unreleased\s*$/.test(l));
  if (at === -1) throw new Error('CHANGELOG.md has no "## Unreleased" heading; add one.');
  let stop = lines.findIndex((l, i) => i > at && /^## /.test(l));
  if (stop === -1) stop = lines.length;
  const body = lines.slice(at + 1, stop);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  if (!body.length)
    throw new Error(
      `CHANGELOG.md "## Unreleased" is empty and there is no "## ${version}" entry; write what changed first.`,
    );
  const rest = lines.slice(stop);
  const out = [...lines.slice(0, at + 1), '', `## ${version} - ${date}`, '', ...body, ''];
  if (rest.length) out.push(...rest);
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** Text edit, so the manifests keep their own formatting. */
function setVersions(pkgs, version) {
  const names = pkgs.map((p) => p.json.name);
  const changed = [];
  for (const p of pkgs) {
    let text = p.text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
    for (const dep of names)
      text = text.replace(new RegExp(`("${escapeRe(dep)}"\\s*:\\s*")[^"]*(")`, 'g'), `$1${version}$2`);
    if (text !== p.text) {
      writeFileSync(p.file, text);
      changed.push(p.file);
    }
  }
  return changed;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--verify-tag') {
    if (argv.length !== 2) fail(2, USAGE);
    return verifyTag(argv[1]);
  }
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  if (rest.length !== 1 || rest[0].startsWith('-')) fail(2, USAGE);
  const [version] = rest;
  const tag = `v${version}`;

  // 1. clean tree on main
  const status = git('status', '--porcelain');
  if (status.status !== 0) fail(1, 'not a git repository.');
  if (status.stdout.trim()) fail(1, 'the working tree is not clean. Commit or stash your changes first.');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  if (branch !== 'main') fail(1, `releases are cut from main, not "${branch}". Check out main first.`);

  // 2. version shape, 3. tag absent
  if (!VERSION_RE.test(version))
    fail(1, `"${version}" does not match <major>.<minor>.<patch> or <major>.<minor>.<patch>-rc.<n>.`);
  if (git('rev-parse', '-q', '--verify', `refs/tags/${tag}`).status === 0)
    fail(1, `tag ${tag} already exists. Pick the next version; a published tag is never moved.`);

  // 3b. the git identity that will sign the commit and the tag must be a noreply address
  for (const v of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const ident = git('var', v).stdout.trim();
    const email = /<([^>]*)>/.exec(ident)?.[1] ?? '';
    if (!/@users\.noreply\.github\.com$/i.test(email))
      fail(
        1,
        'the git identity in effect is not a users.noreply.github.com address, so the release commit ' +
          'and tag would carry a personal email. Run: git config user.email <id>+<login>@users.noreply.github.com ' +
          '(this repository only), then rerun. Nothing was written.',
      );
  }

  // 4. scrub, denylist required
  if (!process.env.TICKET_GATE_DENYLIST)
    fail(
      1,
      'TICKET_GATE_DENYLIST is unset. Export it, pointing at the denylist file outside every ' +
        'repository (format in scripts/scrub.mjs), then rerun.',
    );
  const scrub = run(process.execPath, [join(ROOT, 'scripts', 'scrub.mjs'), '--require-denylist']);
  if (scrub.status !== 0) {
    process.stderr.write(`${scrub.stdout}${scrub.stderr}`);
    fail(scrub.status === 2 ? 2 : 1, 'scrub did not pass. Fix what it names, then rerun.');
  }

  // 5. scanners present
  const scanners = [
    { name: 'gitleaks', args: ['detect', '--source', '.', '--redact', '--no-banner'] },
    { name: 'trufflehog', args: ['git', 'file://.', '--fail', '--no-update'] },
  ];
  const missing = scanners.filter((s) => run(s.name, ['--version']).error?.code === 'ENOENT');
  if (missing.length)
    fail(
      2,
      `${missing.map((s) => s.name).join(' and ')} not found on PATH. Install gitleaks ` +
        '(https://github.com/gitleaks/gitleaks) and trufflehog (https://github.com/trufflesecurity/trufflehog), then rerun.',
    );

  if (dryRun) {
    say(`release: dry run for ${tag}. Gates 1-5 passed; nothing was written.`);
    say('would run: both scanners, npm test, set versions, move the CHANGELOG, commit, tag.');
    return;
  }

  // 5b. scanner runs, output kept
  const outDir = join(ROOT, '.release', version);
  mkdirSync(outDir, { recursive: true });
  for (const s of scanners) {
    const r = run(s.name, s.args);
    writeFileSync(join(outDir, `${s.name}.txt`), `${r.stdout ?? ''}${r.stderr ?? ''}`);
    if (r.status !== 0)
      fail(1, `${s.name} reported findings (exit ${r.status}). Read .release/${version}/${s.name}.txt; nothing was tagged.`);
  }

  // 6. tests
  if (run('npm', ['test'], { stdio: 'inherit' }).status !== 0)
    fail(1, 'npm test failed. Fix it and rerun; nothing was tagged.');

  // 7. versions, 8. CHANGELOG
  const pkgs = workspacePackages();
  const changed = setVersions(pkgs, version);
  const changelogFile = join(ROOT, 'CHANGELOG.md');
  const before = readFileSync(changelogFile, 'utf8');
  let after;
  try {
    after = moveChangelog(before, version, new Date().toISOString().slice(0, 10));
  } catch (err) {
    fail(1, `${err.message} (manifest edits so far: ${changed.length}; see git status).`);
  }
  if (after !== before) {
    writeFileSync(changelogFile, after);
    changed.push(changelogFile);
  }
  const problems = versionProblems(workspacePackages(), version);
  if (problems.length) fail(1, `manifests still disagree after the edit:\n  ${problems.join('\n  ')}`);
  if (changed.some((f) => f.endsWith('package.json')) && existsSync(join(ROOT, 'package-lock.json'))) {
    const lock = run('npm', ['install', '--package-lock-only', '--offline', '--ignore-scripts']);
    if (lock.status !== 0) fail(1, `could not refresh package-lock.json:\n${lock.stderr}`);
  }

  // 9. release commit (only when a file changed), annotated tag
  if (git('status', '--porcelain').stdout.trim()) {
    git('add', '-A');
    const c = git('commit', '-q', '-m', `chore(release): ${tag}`);
    if (c.status !== 0) fail(1, `release commit failed:\n${c.stderr}`);
  } else say('release: versions and CHANGELOG already match; no release commit needed.');
  const t = git('tag', '-a', tag, '-m', tag);
  if (t.status !== 0) fail(1, `tagging failed:\n${t.stderr}`);

  say(`release: ${tag} is tagged locally. Nothing was pushed or published. Run these yourself:`);
  say('  git push origin main');
  say(`  git push origin ${tag}`);
  say(`Attach .release/${version}/gitleaks.txt and trufflehog.txt to the pull request.`);
}

main();
