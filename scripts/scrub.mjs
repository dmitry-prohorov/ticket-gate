#!/usr/bin/env node
// Scrub: prove no project-specific or private material is in this repo, in its
// working tree or in any commit that ever existed (INFRA-47 section 2.3).
//
//   node scripts/scrub.mjs [--repo <dir>] [--require-denylist]
//
// Exit 0 clean, 1 findings, 2 configuration error.
//
// Shapes live here; literals do not. Anything that names a person, an employer, a
// hosted project or a product comes from the denylist file named by the env var
// TICKET_GATE_DENYLIST (an absolute path outside every git work tree; lines are
// DENY=<literal> or DENY_RE=<regex>, # starts a comment). A hit is printed as
// R9 DENY#<n>, never as the term. Matched text is never printed by any row.
//
// The patterns below are written so that this file does not match its own scan.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const ENV_DENYLIST = 'TICKET_GATE_DENYLIST';
const NOREPLY = /@users\.noreply\.github\.com$/i;
const EMAIL_OK = [/@example\.(com|org|net)$/i, /@test\.com$/i, NOREPLY];
// The trailer address agents add to commit messages; allowed in messages only.
const MESSAGE_EMAIL_OK = /^noreply@anthropic\.com$/i;

const SEG = '[^/\\s\'"`<>:]+';
const USERS = '/Us' + 'ers/';
const HOMES = '/ho' + 'me/';
const WIN_USERS = 'C:\\\\Us' + 'ers\\\\';

// Rules applied to the text of one line. `skipPath` exempts a path.
const LINE_RULES = [
  { id: 'R1', re: /[a-z]{20}\.supabase\.(co|in)/, what: 'hosted database reference' },
  { id: 'R2', re: /\.vercel\.app/, what: 'hosted app domain' },
  { id: 'R3', re: /@\w+_bot\b|api\.telegram\.org\/bot/, what: 'bot handle or bot api url' },
  {
    id: 'R4',
    re: /(?<![A-Za-z0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
    what: 'token-shaped string',
    skipPath: /init-data\.reference/,
  },
  {
    id: 'R5',
    re: new RegExp(`${USERS}${SEG}/|${HOMES}(?!u/)${SEG}/|${WIN_USERS}`),
    what: 'user-shaped absolute path',
  },
];

// Rules applied to a tracked path.
const PATH_RULES = [
  { id: 'R5', re: /receipt[^/]*\.json$|(^|\/)\.turbo\//, what: 'receipt or turbo artifact path' },
  {
    id: 'R7',
    re: /^(docs\/tasks\/|docs\/guide\/|\.claude\/|\.cursor\/|\.agents\/|AGENTS\.md$|MEMORY\.md$)|(^|\/)(contracts|proposals|memory)\//,
    what: 'project planning or agent material path',
  },
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function git(repo, args, opts = {}) {
  return spawnSync('git', args, { cwd: repo, maxBuffer: 1 << 30, ...opts });
}

function die(msg) {
  process.stderr.write(`scrub: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { repo: resolve(import.meta.dirname, '..'), requireDenylist: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') opts.repo = resolve(argv[(i += 1)] ?? die('--repo needs a directory'));
    else if (argv[i] === '--require-denylist') opts.requireDenylist = true;
    else die(`unknown argument ${argv[i]}. Usage: node scripts/scrub.mjs [--repo <dir>] [--require-denylist]`);
  }
  return opts;
}

/** Entries of the denylist file, or null when the env var is unset. Never echoes content. */
function loadDenylist() {
  const file = process.env[ENV_DENYLIST];
  if (!file) return null;
  if (!isAbsolute(file)) die(`${ENV_DENYLIST} must be an absolute path.`);
  if (!existsSync(file) || !statSync(file).isFile())
    die(`${ENV_DENYLIST} does not name a readable file.`);
  const dir = dirname(file);
  const inside = git(dir, ['rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'], {
    encoding: 'utf8',
  });
  if (inside.status === 0 && /true/.test(inside.stdout))
    die(
      `the file named by ${ENV_DENYLIST} sits inside a git work tree. Move it outside every ` +
        'repository (for example into your home directory) so it can never be committed.',
    );
  const entries = [];
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((raw, idx) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const m = /^(DENY|DENY_RE)=(.+)$/.exec(line);
      if (!m) die(`denylist line ${idx + 1} is neither DENY=<literal> nor DENY_RE=<regex>.`);
      if (m[1] === 'DENY') {
        const needle = m[2].toLowerCase();
        entries.push({ test: (s) => s.toLowerCase().includes(needle) });
      } else {
        let re;
        try {
          re = new RegExp(m[2], 'i');
        } catch {
          die(`denylist line ${idx + 1}: DENY_RE is not a valid regular expression.`);
        }
        entries.push({ test: (s) => re.test(s) });
      }
    });
  return entries;
}

function blobId(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function readBlobs(repo, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const r = git(repo, ['cat-file', '--batch'], { input: `${ids.join('\n')}\n` });
  let pos = 0;
  const buf = r.stdout;
  while (pos < buf.length) {
    const eol = buf.indexOf(10, pos);
    const [sha, , size] = buf.toString('utf8', pos, eol).split(' ');
    const n = Number(size);
    out.set(sha, buf.subarray(eol + 1, eol + 1 + n));
    pos = eol + 1 + n + 1;
  }
  return out;
}

const isText = (buf) => !buf.subarray(0, 8000).includes(0);

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = opts.repo;
  if (git(repo, ['rev-parse', '--git-dir'], { encoding: 'utf8' }).status !== 0)
    die('not a git repository. Pass --repo <dir> or run from the repository.');
  const deny = loadDenylist();
  if (!deny && opts.requireDenylist)
    die(
      `${ENV_DENYLIST} is unset and --require-denylist was given. Export it, pointing at the ` +
        'denylist file outside the repository (format in scripts/scrub.mjs).',
    );

  const findings = new Set();
  const denyHit = (s) => {
    if (!deny) return 0;
    const i = deny.findIndex((d) => d.test(s));
    return i === -1 ? 0 : i + 1;
  };
  // A path is printed as itself unless it matches the denylist.
  const safe = (p) => {
    const n = denyHit(p);
    return n ? `<path:DENY#${n}>` : p;
  };
  const add = (id, loc, what) => findings.add(`${id} ${loc}  ${what}`);

  const scanText = (text, where, path, { message = false } = {}) => {
    text.split('\n').forEach((line, idx) => {
      const loc = `${where}:${safe(path)}:${idx + 1}`;
      for (const rule of LINE_RULES) {
        if (rule.skipPath?.test(path)) continue;
        if (rule.re.test(line)) add(rule.id, loc, rule.what);
      }
      for (const m of line.matchAll(EMAIL_RE)) {
        const ok =
          EMAIL_OK.some((re) => re.test(m[0])) || (message && MESSAGE_EMAIL_OK.test(m[0]));
        if (!ok) add('R6', loc, 'email address outside the allowed domains');
      }
      const n = denyHit(line);
      if (n) add('R9', loc, `DENY#${n}`);
    });
  };

  const scanPath = (path, where) => {
    for (const rule of PATH_RULES) if (rule.re.test(path)) add(rule.id, `${where}:${safe(path)}`, rule.what);
    const n = denyHit(path);
    if (n) add('R9', `${where}:<path>`, `DENY#${n}`);
  };

  // Every commit, oldest first, so a hit is reported at the commit that introduced it.
  const revs = git(repo, ['rev-list', '--all', '--reverse'], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean);
  const seen = new Set();
  let blobsScanned = 0;
  for (const rev of revs) {
    const where = rev.slice(0, 7);
    const tree = git(repo, ['ls-tree', '-r', '-z', rev], { encoding: 'utf8' }).stdout;
    const entries = tree
      .split('\0')
      .filter(Boolean)
      .map((e) => {
        const tab = e.indexOf('\t');
        const [, type, sha] = e.slice(0, tab).split(' ');
        return { type, sha, path: e.slice(tab + 1) };
      })
      .filter((e) => e.type === 'blob');
    const fresh = entries.filter((e) => !seen.has(`${e.sha}:${e.path}`));
    const blobs = readBlobs(repo, [...new Set(fresh.map((e) => e.sha))]);
    for (const e of fresh) {
      seen.add(`${e.sha}:${e.path}`);
      scanPath(e.path, where);
      const buf = blobs.get(e.sha);
      blobsScanned += 1;
      if (buf && isText(buf)) scanText(buf.toString('utf8'), where, e.path);
    }
  }

  // The working tree, only where it differs from every committed blob.
  const files = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .stdout.split('\0')
    .filter(Boolean);
  for (const path of new Set(files)) {
    const abs = join(repo, path);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const buf = readFileSync(abs);
    if (seen.has(`${blobId(buf)}:${path}`)) continue;
    scanPath(path, 'WORKTREE');
    if (isText(buf)) scanText(buf.toString('utf8'), 'WORKTREE', path);
  }

  // Commit identities and messages.
  const log = git(repo, ['log', '--all', '--reverse', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e'], {
    encoding: 'utf8',
  }).stdout;
  for (const rec of log.split('\x1e').filter((r) => r.trim())) {
    const [hash, an, ae, cn, ce, body] = rec.trim().split('\x1f');
    const where = hash.slice(0, 7);
    for (const [who, email] of [
      ['author', ae],
      ['committer', ce],
    ])
      if (!NOREPLY.test(email))
        add('R6', `${where}:commit-${who}`, 'commit email is not a users.noreply.github.com address');
    for (const name of [an, cn]) {
      const n = denyHit(name);
      if (n) add('R9', `${where}:commit-name`, `DENY#${n}`);
    }
    scanText(body ?? '', where, 'commit-message', { message: true });
  }

  // Annotated tags: the tagger identity, the tag name and the message.
  const tagRefs = git(
    repo,
    ['for-each-ref', 'refs/tags', '--format=%(objecttype)%1f%(refname:short)%1f%(taggeremail)%1f%(taggername)%1f%(contents)%1e'],
    { encoding: 'utf8' },
  ).stdout;
  for (const rec of tagRefs.split('\x1e').filter((r) => r.trim())) {
    const [type, name, email, taggerName, body] = rec.trim().split('\x1f');
    if (type !== 'tag') continue;
    const where = `TAG:${safe(name)}`;
    const addr = (email ?? '').replace(/^<|>$/g, '');
    if (!NOREPLY.test(addr)) add('R6', `${where}:tagger`, 'tagger email is not a users.noreply.github.com address');
    for (const text of [name, taggerName ?? '']) {
      const n = denyHit(text);
      if (n) add('R9', `${where}:tag-name`, `DENY#${n}`);
    }
    scanText(`${name}\n${body ?? ''}`, where, 'tag-message', { message: true });
  }

  // History rewrite leftovers.
  const refs = git(repo, ['for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout;
  for (const ref of refs.split('\n').filter(Boolean))
    if (/^refs\/(original|replace)\//.test(ref)) add('R11', `REFS:${safe(ref)}`, 'rewrite leftover ref');
  const gitDir = join(repo, git(repo, ['rev-parse', '--git-dir'], { encoding: 'utf8' }).stdout.trim());
  if (existsSync(join(gitDir, 'filter-repo'))) add('R11', 'GITDIR:filter-repo', 'filter-repo state directory');

  // Report.
  const out = [];
  out.push(`scrub: ${revs.length} commit(s), ${blobsScanned} blob version(s), working tree`);
  if (deny) out.push(`R8 R9 denylist: ${deny.length} entr${deny.length === 1 ? 'y' : 'ies'} applied`);
  else {
    out.push(`R8 SKIPPED (${ENV_DENYLIST} unset)`);
    out.push(`R9 SKIPPED (${ENV_DENYLIST} unset)`);
  }
  for (const scanner of ['gitleaks', 'trufflehog']) {
    const found = spawnSync(scanner, ['--version'], { stdio: 'ignore' }).error === undefined;
    out.push(`R10 ${scanner}: ${found ? 'installed (pnpm run release runs it)' : 'not installed (human step H2)'}`);
  }
  out.push(
    'R10 release runs: gitleaks detect --source . --redact --no-banner ; trufflehog git file://. --fail --no-update',
  );
  const list = [...findings].sort();
  for (const f of list) out.push(f);
  if (list.length) {
    out.push(
      `scrub: ${list.length} finding(s). A hit under WORKTREE: edit the file and rerun. ` +
        'A hit under a commit id: the history must be rewritten before anything is published.',
    );
  } else out.push('scrub: clean');
  process.stdout.write(`${out.join('\n')}\n`);
  process.exit(list.length ? 1 : 0);
}

main();
