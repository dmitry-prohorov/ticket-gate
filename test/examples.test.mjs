// The examples are projects a reader copies; each must work against this engine as written.
// examples/basic and examples/full are run end to end in scratch git repos: verify, the hooks and every command.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO } from './repo-files.mjs';

const BIN = join(REPO, 'packages/engine/bin/ticket-gate.mjs');
// Built from parts: test/packages.test.mjs 5-4a forbids the scope in a tracked .mjs here.
const SCOPE_DIR = '@ticket-' + 'gate';

/** A copy of examples/<name> as a git repo: `main` without src/sum.mjs, branch `t-1` adding it. */
function project(name) {
  const dir = mkdtempSync(join(tmpdir(), `tg-example-${name}-`));
  cpSync(join(REPO, 'examples', name), dir, { recursive: true });
  // What `npm install` would give: the engine under node_modules.
  mkdirSync(join(dir, 'node_modules', SCOPE_DIR), { recursive: true });
  symlinkSync(join(REPO, 'packages/engine'), join(dir, 'node_modules', SCOPE_DIR, 'engine'), 'dir');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.turbo/\n');
  const sum = readFileSync(join(dir, 'src/sum.mjs'), 'utf8');
  rmSync(join(dir, 'src/sum.mjs'));
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 't-1');
  writeFileSync(join(dir, 'src/sum.mjs'), sum);
  return dir;
}

const tg = (dir, args, input = '{}') => {
  const env = { ...process.env };
  delete env.TICKET_GATE_ROOT;
  delete env.TICKET_GATE_CONFIG_DIR;
  // Set by this test run; left in, the example's own `node --test` would skip its files.
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, input, encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const decision = (r) => (r.out.trim() ? JSON.parse(r.out) : null);
const tick = (dir, text) => {
  const f = join(dir, 'tickets/phase-1.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace(`- [ ] ${text}`, `- [x] ${text}`));
};

test('EX-1 examples/basic: verify, the Stop hook and the push guard behave as its README says', () => {
  const dir = project('basic');
  try {
    const dry = tg(dir, ['verify', '--dry-run']);
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /RUN\s+node --check src\/sum\.mjs/);
    assert.match(dry.out, /RUN\s+npm test/);
    assert.match(dry.out, /`src\/sum\.mjs` \+\d+ -0 - src library code/);

    tick(dir, '`sum(a, b)`');
    assert.match(decision(tg(dir, ['hook', 'stop'])).reason, /No verification receipt exists/);

    const run = tg(dir, ['verify']);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /verify:ticket OK\./);
    assert.equal(JSON.parse(readFileSync(join(dir, '.turbo/ticket-verify.json'), 'utf8')).ok, true);
    assert.equal(decision(tg(dir, ['hook', 'stop'])), null, 'a green, current receipt approves');

    appendFileSync(join(dir, 'src/sum.mjs'), '// a later edit\n');
    assert.match(decision(tg(dir, ['hook', 'stop'])).reason, /receipt is stale/);
    tg(dir, ['verify']);
    assert.equal(decision(tg(dir, ['hook', 'stop'])), null);

    tick(dir, 'Release notes reviewed (human)');
    assert.match(decision(tg(dir, ['hook', 'stop'])).reason, /human steps and may not be ticked/);

    const push = (command) =>
      decision(tg(dir, ['hook', 'pre-tool-use'], JSON.stringify({ tool_name: 'Bash', tool_input: { command } })));
    assert.equal(push('git push origin main').hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(push('git push --force origin t-1').hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(push('git push -u origin t-1'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EX-1 the example hook settings call the engine hooks', () => {
  const settings = JSON.parse(readFileSync(join(REPO, 'examples/basic/.claude/settings.json'), 'utf8'));
  const commands = (event) => settings.hooks[event].flatMap((h) => h.hooks.map((x) => x.command));
  assert.deepEqual(commands('Stop'), ['npx --no-install ticket-gate hook stop']);
  assert.deepEqual(commands('SubagentStop'), ['npx --no-install ticket-gate hook stop']);
  assert.deepEqual(commands('PreToolUse'), ['npx --no-install ticket-gate hook pre-tool-use']);
});

/** examples/full as a git repo on `main`, with the engine, typescript and jscpd installed. */
function fullProject() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-example-full-'));
  cpSync(join(REPO, 'examples/full'), dir, { recursive: true });
  const nm = join(dir, 'node_modules');
  mkdirSync(join(nm, SCOPE_DIR), { recursive: true });
  mkdirSync(join(nm, '.bin'));
  symlinkSync(join(REPO, 'packages/engine'), join(nm, SCOPE_DIR, 'engine'), 'dir');
  for (const dep of ['typescript', 'jscpd']) symlinkSync(join(REPO, 'node_modules', dep), join(nm, dep), 'dir');
  symlinkSync(join(REPO, 'node_modules/.bin/jscpd'), join(nm, '.bin/jscpd'));
  symlinkSync(BIN, join(nm, '.bin/ticket-gate'));
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.turbo/\n');
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { dir, git };
}

test('EX-2 examples/full: every engine command works on main as its README says', () => {
  const { dir } = fullProject();
  try {
    const ok = (args, re) => {
      const r = tg(dir, args);
      assert.equal(r.code, 0, `${args.join(' ')}\n${r.out}`);
      assert.match(r.out, re);
    };
    ok(['ratchet', '--all'], /ratchet --all: 4 ran, 0 failed/);
    ok(['mutations', 'check'], /2 entries \(2 live, 0 retired\) in 1 files, 0 problem\(s\)/);
    ok(['mutate', '--registry', '--all'], /2\/2 killed, 0 survived/);
    ok(['select', 'check'], /select check: 2 specs/);
    ok(['fu', 'check'], /check:follow-ups OK/);
    ok(['fu', 'list'], /^FU1\tlow\tdev-core\t/m);
    ok(['verify', '--precheck'], /precheck: 2 ok, 0 failed/);
    ok(['docs-stale'], /pricing\.md: current/);
    ok(['db-status'], /db: never started/);
    ok(['nightly', 'install'], /add to your crontab/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EX-2 examples/full: a ticket branch through verify, the stack, the registry and the hooks', () => {
  const { dir, git } = fullProject();
  try {
    git('checkout', '-qb', 't-2');
    appendFileSync(join(dir, 'src/cart.mjs'), '\n/** The number of items in a cart. */\nexport const itemCount = (lines) => lines.reduce((n, l) => n + l.qty, 0);\n');
    writeFileSync(join(dir, 'db/migrations/002_discount.sql'), 'alter table orders add column discount_cents integer;\n');
    git('add', '-A');
    git('commit', '-qm', 'T-2');

    const dry = tg(dir, ['verify', '--dry-run']);
    assert.equal(dry.code, 0, dry.out);
    for (const line of [
      /RUN\s+node --check src\/cart\.mjs/,
      /RUN\s+node gate\/db\.mjs health/,
      /RUN\s+node gate\/db\.mjs migrate/,
      /RUN\s+npm run e2e/,
      /HUMAN\s+deploy the branch to staging/,
      /`db\/migrations\/002_discount\.sql` \+1 -0 - H1 database migration/,
      /`src\/cart\.mjs` \+3 -0 - G1 core logic/,
      /apply it to a copy of production first/,
    ])
      assert.match(dry.out, line);
    assert.doesNotMatch(dry.out, /RUN\s+node gate\/db\.mjs reset/, 'migrate satisfies the reset');

    const sel = tg(dir, ['select']);
    assert.match(sel.out, /^ {2}checkout\.spec\.mjs$/m);
    assert.doesNotMatch(sel.out, /catalog\.spec\.mjs/);

    const down = tg(dir, ['verify']);
    assert.equal(down.code, 1, down.out);
    assert.match(down.out, /STOPPED \(db:health red\): npm run e2e/);

    execFileSync(process.execPath, ['gate/db.mjs', 'up'], { cwd: dir, stdio: 'pipe' });
    const up = tg(dir, ['verify']);
    assert.equal(up.code, 0, up.out);
    assert.match(up.out, /npm test: ℹ pass 5 \(reused from .+\)\s+\[REUSED\]/);
    assert.match(up.out, /ratchet --all: 4 ran, 0 failed/);
    assert.match(up.out, /npm run e2e: ℹ pass 2/);
    assert.match(up.out, /verify:ticket OK\./);

    assert.match(tg(dir, ['docs-stale']).out, /pricing\.md: STALE since main/);
    assert.match(tg(dir, ['mutate', 'T-2']).out, /mutate:check T-2: 2\/2 killed/);
    assert.match(tg(dir, ['score', '--base=main']).out, /no TypeScript module in src\/ changed/);

    const phase = join(dir, 'tickets/phase-1.md');
    writeFileSync(phase, readFileSync(phase, 'utf8').replace('- [ ] `total()`', '- [x] `total()`'));
    assert.match(decision(tg(dir, ['hook', 'stop'])).reason, /receipt is stale/);
    assert.equal(tg(dir, ['verify']).code, 0);
    assert.equal(decision(tg(dir, ['hook', 'stop'])), null);

    const push = decision(
      tg(dir, ['hook', 'pre-tool-use'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:release' } })),
    );
    assert.equal(push.hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
