// INFRA-47 5-8: every scrub row fires on a planted violation and stays quiet on the
// allowed neighbour. Every repo and denylist here lives under os.tmpdir(); every
// violating string is built at runtime so 5-8j (the real repo scans clean) holds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

const SCRUB = join(import.meta.dirname, 'scrub.mjs');
const REAL_REPO = join(import.meta.dirname, '..');
const NOREPLY = '11081166+dmitry-prohorov@users.noreply.github.com';
const scratch = [];
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Strings that would trip a row if they were literals in this file.
const token = () => `${'1234'}${'56789'}:${'A'.repeat(35)}`;
const userPath = (name) => `${'/Us'}${'ers/'}${name}/x`;
const homePath = (name) => `${'/ho'}${'me/'}${name}/project`;
const winPath = () => `${'C:\\'}${'Us'}${'ers\\'}x`;
const ref20 = () => `${'abcdefghij'}${'klmnopqrst'}.supa${'base.co'}`;
const botHandle = () => `${'@'}some${'_bot'}`;
const corpMail = () => `a${'@'}corp.io`;

function run(args, env = {}, cwd = tmpdir()) {
  const base = { ...process.env };
  delete base.TICKET_GATE_DENYLIST;
  const r = spawnSync(process.execPath, [SCRUB, ...args], {
    cwd,
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function git(dir, args, env = {}) {
  const r = spawnSync('git', args, {
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
      ...env,
    },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function mkRepo(files = { 'a.txt': 'clean\n' }, env = {}) {
  const dir = tmp('tg-scrub-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  commit(dir, files, 'init', env);
  return dir;
}

function commit(dir, files, message, env = {}) {
  for (const [path, body] of Object.entries(files)) {
    if (body === null) git(dir, ['rm', '-q', path]);
    else {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message], env);
}

const rows = (out) => [...out.matchAll(/^(R\d+) /gm)].map((m) => m[1]);

test('INFRA-47 5-8a token-shaped string fails R4', () => {
  const dir = mkRepo({ 'a.txt': `x = "${token()}"\n` });
  const r = run(['--repo', dir]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^R4 [0-9a-f]{7}:a\.txt:1 /m);
  assert.ok(!r.out.includes(token()), 'the matched string must not be printed');
  const exempt = mkRepo({ 'fixtures/init-data.reference.json': `${token()}\n` });
  assert.equal(run(['--repo', exempt]).code, 0);
  const near = mkRepo({ 'a.txt': `${'1234'}${'56789'}:${'A'.repeat(34)}\n` });
  assert.equal(run(['--repo', near]).code, 0);
});

test('INFRA-47 5-8b user-shaped path fails R5, /home/u passes', () => {
  const bad = mkRepo({ 'a.txt': `${userPath('someone')}\n`, 'b.txt': `${homePath('alice')}\n`, 'c.txt': `${winPath()}\n` });
  const r = run(['--repo', bad]);
  assert.equal(r.code, 1);
  assert.deepEqual(
    [...r.out.matchAll(/^R5 \S+:(\w\.txt):1/gm)].map((m) => m[1]).sort(),
    ['a.txt', 'b.txt', 'c.txt'],
  );
  const ok = mkRepo({ 'a.txt': `${homePath('u')}\n` });
  assert.equal(run(['--repo', ok]).code, 0);
});

test('INFRA-47 5-8c receipt and docs/tasks paths fail R5 R7', () => {
  const dir = mkRepo({
    'x.old-receipt.json': '{}\n',
    'docs/tasks/a.md': 'plan\n',
    '.claude/s.json': '{}\n',
    'AGENTS.md': 'rules\n',
    'p/contracts/c.md': 'c\n',
    '.cursor/x': 'x\n',
    '.agents/x': 'x\n',
    'docs/guide/x.md': 'x\n',
    'MEMORY.md': 'x\n',
    'a/proposals/p.md': 'x\n',
    'a/memory/m.md': 'x\n',
    '.turbo/x.json': '{}\n',
    'ok.md': 'fine\n',
  });
  const r = run(['--repo', dir]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^R5 [0-9a-f]{7}:x\.old-receipt\.json /m);
  for (const p of [
    'docs/tasks/a.md', '.claude/s.json', 'AGENTS.md', 'p/contracts/c.md', '.cursor/x', '.agents/x',
    'docs/guide/x.md', 'MEMORY.md', 'a/proposals/p.md', 'a/memory/m.md',
  ])
    assert.match(r.out, new RegExp(`^R7 [0-9a-f]{7}:${p.replace(/[./]/g, '\\$&')} `, 'm'), p);
  assert.match(r.out, /^R5 [0-9a-f]{7}:\.turbo\/x\.json /m);
  assert.ok(!/ok\.md/.test(r.out));
});

test('INFRA-47 5-8d non-noreply email and author fail R6, a@example.com passes', () => {
  const inFile = mkRepo({ 'a.txt': `${corpMail()}\n` });
  assert.match(run(['--repo', inFile]).out, /^R6 [0-9a-f]{7}:a\.txt:1 /m);
  const asAuthor = mkRepo({ 'a.txt': 'clean\n' }, { GIT_AUTHOR_EMAIL: corpMail() });
  const r = run(['--repo', asAuthor]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^R6 [0-9a-f]{7}:commit-author /m);
  const asCommitter = mkRepo({ 'a.txt': 'clean\n' }, { GIT_COMMITTER_EMAIL: corpMail() });
  assert.match(run(['--repo', asCommitter]).out, /^R6 [0-9a-f]{7}:commit-committer /m);
  const fine = mkRepo({ 'a.txt': `a${'@'}example.com, b${'@'}test.com, c${'@'}users.noreply.github.com, pnpm${'@'}10.0.0\n` });
  assert.equal(run(['--repo', fine]).code, 0);
  const trailer = mkRepo({ 'a.txt': 'x\n' });
  commit(trailer, { 'b.txt': 'y\n' }, `feat: x\n\nCo-Authored-By: Claude <noreply${'@'}anthropic.com>`);
  assert.equal(run(['--repo', trailer]).code, 0);
  const msgMail = mkRepo({ 'a.txt': 'x\n' });
  commit(msgMail, { 'b.txt': 'y\n' }, `feat: x\n\nSigned-off-by: ${corpMail()}`);
  assert.match(run(['--repo', msgMail]).out, /^R6 [0-9a-f]{7}:commit-message:3 /m);
});

test('INFRA-47 5-8e history hit removed at HEAD still fails', () => {
  const dir = mkRepo({ 'a.txt': 'clean\n' });
  commit(dir, { 'b.txt': `${token()}\n` }, 'add');
  commit(dir, { 'b.txt': null }, 'remove');
  const r = run(['--repo', dir]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^R4 [0-9a-f]{7}:b\.txt:1 /m);
  assert.ok(!/^R\d+ WORKTREE/m.test(r.out), 'the hit exists only in history');
});

test('INFRA-47 5-8e an uncommitted working-tree hit fails and says WORKTREE', () => {
  const dir = mkRepo();
  writeFileSync(join(dir, 'new.txt'), `${token()}\n`);
  assert.match(run(['--repo', dir]).out, /^R4 WORKTREE:new\.txt:1 /m);
});

test('INFRA-47 5-8f shape rows R1-R3 fail', () => {
  const dir = mkRepo({
    'a.txt': `${ref20()}\n`,
    'b.txt': `https://x.vercel.${'app'}\n`,
    'c.txt': `${botHandle()}\n`,
    'd.txt': `https://api.telegram.org/${'bot'}x\n`,
  });
  const r = run(['--repo', dir]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^R1 [0-9a-f]{7}:a\.txt:1 /m);
  assert.match(r.out, /^R2 [0-9a-f]{7}:b\.txt:1 /m);
  assert.match(r.out, /^R3 [0-9a-f]{7}:c\.txt:1 /m);
  assert.match(r.out, /^R3 [0-9a-f]{7}:d\.txt:1 /m);
  const ok = mkRepo({ 'a.txt': 'abc.supabase.co and https://vercel.com\n' });
  assert.equal(run(['--repo', ok]).code, 0);
});

function denylist(lines) {
  const dir = tmp('tg-scrub-deny-');
  const file = join(dir, 'denylist.env');
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('INFRA-47 5-8g denylist hit fails and is redacted', () => {
  const term = 'zorblax-widgets';
  const dir = mkRepo({
    'a.txt': `we use ZorBlax-Widgets here\n`,
    [`${term}-notes.md`]: 'x\n',
    'b.txt': 'second: qq-7731\n',
    'c.txt': 'clean\n',
  });
  commit(dir, { 'z.txt': 'ok\n' }, `mention ${term}`);
  const file = denylist(['# comment', `DENY=${term}`, 'DENY_RE=qq-\\d+']);
  const r = run(['--repo', dir], { TICKET_GATE_DENYLIST: file });
  assert.equal(r.code, 1);
  assert.match(r.out, /^R9 [0-9a-f]{7}:a\.txt:1  DENY#1$/m);
  assert.match(r.out, /^R9 [0-9a-f]{7}:b\.txt:1  DENY#2$/m);
  assert.match(r.out, /DENY#2/);
  assert.match(r.out, /commit-message/);
  for (const secret of [term, 'ZorBlax', 'qq-7731', file]) assert.ok(!r.out.includes(secret), `output leaked ${secret}`);
  assert.ok(!r.out.includes(term), 'a path holding the term is redacted too');
  const clean = mkRepo();
  assert.equal(run(['--repo', clean], { TICKET_GATE_DENYLIST: file }).code, 0);
});

test('INFRA-47 5-8h refs/original fails R11', () => {
  const dir = mkRepo();
  git(dir, ['update-ref', 'refs/original/refs/heads/main', 'HEAD']);
  const r = run(['--repo', dir]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^R11 REFS:refs\/original\/refs\/heads\/main /m);
  const rep = mkRepo();
  git(rep, ['update-ref', 'refs/replace/' + 'a'.repeat(40), 'HEAD']);
  assert.match(run(['--repo', rep]).out, /^R11 REFS:refs\/replace\//m);
  const fr = mkRepo();
  mkdirSync(join(fr, '.git', 'filter-repo'));
  assert.match(run(['--repo', fr]).out, /^R11 GITDIR:filter-repo /m);
});

test('INFRA-47 5-8i denylist inside a work tree exits 2; unset skips; --require-denylist exits 2', () => {
  const dir = mkRepo();
  // inside a work tree
  const inside = join(dir, 'deny.env');
  writeFileSync(inside, 'DENY=anything\n');
  const a = run(['--repo', dir], { TICKET_GATE_DENYLIST: inside });
  assert.equal(a.code, 2);
  assert.match(a.out, /inside a git work tree/);
  assert.ok(!a.out.includes('anything'));
  // unset: skipped, exit 0
  const b = run(['--repo', dir]);
  assert.equal(b.code, 0);
  assert.match(b.out, /^R8 SKIPPED \(TICKET_GATE_DENYLIST unset\)$/m);
  assert.match(b.out, /^R9 SKIPPED \(TICKET_GATE_DENYLIST unset\)$/m);
  // unset with --require-denylist
  assert.equal(run(['--repo', dir, '--require-denylist']).code, 2);
  // other config errors
  assert.equal(run(['--repo', dir], { TICKET_GATE_DENYLIST: 'relative.env' }).code, 2);
  assert.equal(run(['--repo', dir], { TICKET_GATE_DENYLIST: join(tmpdir(), 'tg-none.env') }).code, 2);
  assert.equal(run(['--repo', dir], { TICKET_GATE_DENYLIST: denylist(['junk line']) }).code, 2);
  assert.equal(run(['--repo', dir], { TICKET_GATE_DENYLIST: denylist(['DENY_RE=(']) }).code, 2);
  assert.equal(run(['--repo', tmp('tg-notgit-')]).code, 2);
  // a valid outside file with --require-denylist works
  assert.equal(run(['--repo', dir, '--require-denylist'], { TICKET_GATE_DENYLIST: denylist(['DENY=nope-nope']) }).code, 0);
});

test('INFRA-47 5-8j the real repo scans clean', () => {
  const r = run(['--repo', REAL_REPO], process.env.TICKET_GATE_DENYLIST ? { TICKET_GATE_DENYLIST: process.env.TICKET_GATE_DENYLIST } : {});
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^scrub: clean$/m);
  assert.deepEqual(rows(r.out).filter((x) => !['R8', 'R9', 'R10'].includes(x)), []);
});

test('INFRA-47 5-8 annotated tags: a non-noreply tagger is R6, a denylisted tag message is R9', () => {
  const dir = mkRepo();
  git(dir, ['tag', '-a', 'v1', '-m', 'release'], { GIT_COMMITTER_EMAIL: corpMail() });
  const r = run(['--repo', dir]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^R6 TAG:v1:tagger /m);

  const term = `zorblax${'-'}widgets`;
  const msg = mkRepo();
  git(msg, ['tag', '-a', 'v2', '-m', `shipping ${term} now`]);
  const m = run(['--repo', msg], { TICKET_GATE_DENYLIST: denylist([`DENY=${term}`]) });
  assert.equal(m.code, 1);
  assert.match(m.out, /^R9 TAG:v2:tag-message:\d+  DENY#1$/m);
  assert.ok(!m.out.includes(term), 'the term is never printed');

  const ok = mkRepo();
  git(ok, ['tag', '-a', 'v3', '-m', 'v3']);
  git(ok, ['tag', 'light']);
  assert.equal(run(['--repo', ok]).code, 0);
});
