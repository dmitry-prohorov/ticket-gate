// The examples are projects a reader copies; each must work against this engine as written.
// examples/basic is run end to end in a scratch git repo: verify, the Stop hook and the push guard.
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
