// INFRA-45 CL-*: the engine CLI (tools/gate/bin/ticket-gate.mjs) in throwaway projects under
// os.tmpdir(); every case spawns the bin so the exit status is the one a script sees.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(GATE, '..', '..');
const BIN = join(GATE, 'bin', 'ticket-gate.mjs');
const CONFIG_URL = pathToFileURL(join(GATE, 'config.mjs')).href;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const put = (dir, f, body) => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), body);
};

/** A project dir whose gate.config.mjs is `defineGate({ ...body })`. */
function project(body = '', extra = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-cli-')));
  dirs.push(dir);
  put(
    dir,
    'gate.config.mjs',
    `import { defineGate } from ${JSON.stringify(CONFIG_URL)};\nexport default defineGate({ steps: [], ${body} });\n`,
  );
  for (const [f, text] of Object.entries(extra)) put(dir, f, text);
  return dir;
}
const bin = (cwd, args, input = '') =>
  spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    input,
    encoding: 'utf8',
  });

test('CL-1 usage: --help exits 0, no command exits 2, an unknown command exits 2 on stderr', () => {
  const help = bin(REPO, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: ticket-gate <command>/);
  const none = bin(REPO, []);
  assert.equal(none.status, 2);
  assert.match(none.stdout, /usage: ticket-gate/);
  for (const cmd of ['analyze', 'sync', 'skills', 'bogus']) {
    const r = bin(REPO, [cmd]);
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, new RegExp(`unknown command ${cmd}`));
    assert.match(r.stderr, /usage: ticket-gate/);
    assert.equal(r.stdout, '');
  }
});

test('CL-2 a ratchet failing code is the exit status, its lines go to stderr', () => {
  const dir = project(
    `ratchets: { bad: { check: () => ({ code: 3, lines: ['not good', 'fix it'] }) },
      good: { check: () => ({ code: 0, lines: ['all fine'] }) } }`,
  );
  const bad = bin(dir, ['ratchet', 'bad']);
  assert.equal(bad.status, 3, bad.stderr);
  assert.equal(bad.stderr.trim(), 'not good\nfix it');
  assert.equal(bad.stdout, '');
  const good = bin(dir, ['ratchet', 'good']);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout.trim(), 'all fine');
  assert.equal(good.stderr, '');
});

test('CL-3 an unknown ratchet exits 2 and names the configured ones', () => {
  const dir = project(
    `ratchets: { a: { check: () => ({ code: 0, lines: [] }) }, 'b-c': { check: () => ({ code: 0, lines: [] }) } }`,
  );
  const r = bin(dir, ['ratchet', 'nope']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), 'ratchet: unknown nope; configured: a, b-c');
  const bare = bin(project(), ['ratchet', 'nope']);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /configured: none/);
});

test('CL-4 a ratchet gets { root, args, update, baseline }', () => {
  const dir = project(
    `ratchets: { show: { baseline: 'data/base.json', check: (ctx) => ({ code: 0, lines: [JSON.stringify(ctx)] }) },
      plain: { check: (ctx) => ({ code: 0, lines: [JSON.stringify(ctx)] }) } }`,
  );
  const a = JSON.parse(
    bin(dir, ['ratchet', 'show', '--x=1', '--update']).stdout,
  );
  assert.deepEqual(a, {
    root: dir,
    args: ['--x=1', '--update'],
    update: true,
    baseline: 'data/base.json',
  });
  const b = JSON.parse(bin(dir, ['ratchet', 'plain']).stdout);
  assert.deepEqual(b, { root: dir, args: [], update: false, baseline: null });
});

test('CL-5 a malformed ratchet entry fails config load', async () => {
  const { defineGate } = await import(CONFIG_URL);
  const ok = () => ({ code: 0, lines: [] });
  assert.doesNotThrow(() =>
    defineGate({
      steps: [],
      ratchets: { 'a-1': { check: ok, baseline: 'x' } },
    }),
  );
  assert.throws(
    () => defineGate({ steps: [], ratchets: { x: {} } }),
    /gate\.config: ratchets\.x\.check must be a function/,
  );
  assert.throws(
    () => defineGate({ steps: [], ratchets: { x: { check: 'node y' } } }),
    /ratchets\.x\.check must be a function/,
  );
  assert.throws(
    () => defineGate({ steps: [], ratchets: { Bad_Name: { check: ok } } }),
    /ratchets\.Bad_Name: name must match/,
  );
  assert.throws(
    () =>
      defineGate({ steps: [], ratchets: { x: { check: ok, baseline: 3 } } }),
    /ratchets\.x\.baseline: must be a string/,
  );
  const dir = project(`ratchets: { x: {} }`);
  const r = bin(dir, ['ratchet', 'x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ratchets\.x\.check must be a function/);
});

function git(dir, ...a) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a],
    {
      cwd: dir,
      stdio: 'pipe',
    },
  );
}

test('CL-6 hook stop and pre-tool-use pass stdin, stdout and exit code through', () => {
  const push = bin(
    REPO,
    ['hook', 'pre-tool-use'],
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    }),
  );
  assert.equal(push.status, 0, push.stderr);
  assert.match(push.stdout, /"permissionDecision":"deny"/);
  assert.match(push.stdout, /push to main/);
  const quiet = bin(
    REPO,
    ['hook', 'pre-tool-use'],
    JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    }),
  );
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, '');
  // The Stop hook's exit code 2 (a new tick, no receipt) reaches the caller.
  const dir = project('', {
    'docs/tasks/phase-9.md': '## X-01 thing\n\n- [ ] do it\n',
  });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feat/x');
  assert.equal(bin(dir, ['hook', 'stop'], '{}').status, 0);
  put(dir, 'docs/tasks/phase-9.md', '## X-01 thing\n\n- [x] do it\n');
  const tick = bin(dir, ['hook', 'stop'], '{}');
  assert.equal(tick.status, 2, tick.stderr);
  assert.equal(bin(REPO, ['hook', 'bogus']).status, 2);
});

const FU = (id, owner) =>
  `---\nid: ${id}\nstatus: open\nseverity: LOW\nowner: ${owner}\n---\nbody of ${id}\n`;

test('CL-7 fu forwards to the register and check; no followUps exits 2', () => {
  const dir = project(`followUps: { dir: 'reg', pointer: 'POINTER.md' }`, {
    'reg/README.md': '# register\n',
    'reg/FU4.md': FU('FU4', 'INFRA-1'),
    'POINTER.md': 'see reg/\n',
  });
  const next = bin(dir, ['fu', 'next']);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(next.stdout.trim(), 'FU5');
  const list = bin(dir, ['fu', 'list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^FU4\t/);
  const show = bin(dir, ['fu', 'show', 'FU9']);
  assert.equal(show.status, 1);
  assert.match(show.stderr, /show: no follow-up FU9 in reg\//);
  const ok = bin(dir, ['fu', 'check']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'check:follow-ups OK');
  put(dir, 'reg/FU6.md', FU('FU6', ''));
  const bad = bin(dir, ['fu', 'check']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /check:follow-ups FAILED/);
  for (const sub of ['list', 'check']) {
    const none = bin(project(), ['fu', sub]);
    assert.equal(none.status, 2);
    assert.equal(none.stderr.trim(), 'fu: followUps.dir is not configured');
  }
});

const CMD_STEPS = `steps: [{ id: 'a', when: true, cmd: 'true', why: 'w', notRun: 'n', summary: (o) => o, limitS: 5, reuse: false }],`;
const CMD_DOD = `dod: { files: ['docs/tasks/phase-*.md'], contract: 'docs/tasks/contracts/{id}.md' },`;

function tickedProject(commands) {
  const dir = project(
    `${CMD_STEPS} ${CMD_DOD} followUps: { dir: 'reg' }, ${commands ? `commands: ${commands},` : ''}`,
    {
      'docs/tasks/phase-9.md': '## X-01 thing\n\n- [ ] do it\n',
      'reg/README.md': '# register\n',
    },
  );
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feat/x');
  put(dir, 'docs/tasks/phase-9.md', '## X-01 thing\n\n- [x] do it\n');
  return dir;
}

test('CL-8 a config without `commands` gets the ticket-gate defaults in a hook message and a CLI message', () => {
  const dir = tickedProject();
  const stop = bin(dir, ['hook', 'stop'], '{}');
  assert.equal(stop.status, 0, stop.stderr);
  const { reason } = JSON.parse(stop.stdout);
  assert.match(reason, /Run `ticket-gate verify`, paste its output/);
  assert.doesNotMatch(reason, /pnpm/);
  const fu = bin(dir, ['fu']);
  assert.equal(fu.status, 2);
  assert.match(fu.stderr, /^usage: ticket-gate fu list /);
  assert.doesNotMatch(fu.stderr, /pnpm/);
});

test('CL-9 `commands` in the config replaces the defaults in those messages; a bad value fails config load', async () => {
  const dir = tickedProject(`{ verify: 'make verify', fu: 'make fu' }`);
  const { reason } = JSON.parse(bin(dir, ['hook', 'stop'], '{}').stdout);
  assert.match(reason, /Run `make verify`, paste its output/);
  assert.match(bin(dir, ['fu']).stderr, /^usage: make fu list /);
  const { defineGate } = await import(CONFIG_URL);
  for (const [commands, msg] of [
    [{ nope: 'x' }, /gate\.config: commands\.nope: unknown key/],
    [{ verify: '' }, /gate\.config: commands\.verify: must be a non-empty/],
    [{ fu: 'a\nb' }, /gate\.config: commands\.fu: must be a non-empty/],
    ['x', /gate\.config: commands: must be an object/],
  ])
    assert.throws(() => defineGate({ commands }), msg);
});

test('CL-10 move-check [--base=REF] prints unmatched lines, exits 1 while any remain and 0 once the move is whole; a stray argument exits 2', () => {
  const dir = project('', { 'src/a.js': 'const one = 1;\nconst two = 2;\n' });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feat/x');
  put(dir, 'src/a.js', 'const one = 1;\nconst two = 2;\nconst three = 3;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'add');
  const bad = bin(dir, ['move-check', '--base=main']);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout, /src\/a\.js:3 {2}const three = 3;/);
  assert.match(bad.stdout, /unmatched: 1\n$/);
  put(dir, 'src/a.js', 'const one = 1;\n');
  put(dir, 'src/b.js', 'const two = 2;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'move');
  const ok = bin(dir, ['move-check', '--base=main']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(ok.stdout.trim(), 'unmatched: 0');
  const stray = bin(dir, ['move-check', '--bogus']);
  assert.equal(stray.status, 2);
  assert.match(
    stray.stderr,
    /unknown argument --bogus\. Usage: ticket-gate move-check/,
  );
});

// A gate whose one step carries nightly units, run through `verify`.
const e2eProject = (nightly) => {
  const dir = project();
  put(
    dir,
    'gate.config.mjs',
    `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [step({ id: 'e2e', when: true, cmd: 'x', reuse: false, units: { nightly: { finish: (r) => ({ ...r, mode: 'full', why: 'w' }) },
    select: () => ({ mode: 'full', why: 'w', units: ['u'], plan: { mode: 'full' } }), cmd: () => 'node -e 0' } })],
  dod: { files: ['plans/phase-*.md'], contract: 'plans/contracts/{id}.md' },
  reviewMap: { splitHint: 'split' },
  ${nightly}
});
`,
  );
  return dir;
};
const withGit = (dir) => {
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'one');
  git('checkout', '-qb', 'feat');
  writeFileSync(join(dir, 'new.txt'), 'x\n');
  return dir;
};

test('CL-N1 verify appends one e2e-runs line for the nightly step, and none without a nightly key', () => {
  const nightly = `nightly: { suites: [{ name: 'web', runner: { run: async () => ({}) }, limitS: 60 }],
      worktree: { dir: 'wt', install: ['node', '-e', '0'] } }`;
  const on = withGit(e2eProject(nightly));
  const r = bin(on, ['verify']);
  const file = join(on, '.turbo', 'nightly', 'e2e-runs.jsonl');
  assert.ok(existsSync(file), r.stdout + r.stderr);
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['mode', 'ms', 'ranAt', 'why']);
  const off = withGit(e2eProject(''));
  bin(off, ['verify']);
  assert.equal(existsSync(join(off, '.turbo', 'nightly')), false);
});

test('EN-5e the e2e step child sees the report path under both names', () => {
  const dir = project();
  put(
    dir,
    'seen.mjs',
    `import { writeFileSync } from 'node:fs';
const old = 'F' + 'P_E2E_JSON';
writeFileSync('seen.json', JSON.stringify([process.env.TICKET_GATE_E2E_JSON, process.env[old]]));
`,
  );
  put(
    dir,
    'gate.config.mjs',
    `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [step({ id: 'e2e', when: true, cmd: 'x', reuse: false, units: { nightly: { reportPath: '.turbo/e2e-report.json', finish: (r) => ({ ...r, mode: 'full', why: 'w' }) },
    select: () => ({ mode: 'full', why: 'w', units: ['u'], plan: { mode: 'full' } }), cmd: () => 'node seen.mjs' } })],
  dod: { files: ['plans/phase-*.md'], contract: 'plans/contracts/{id}.md' },
  reviewMap: { splitHint: 'split' },
});
`,
  );
  const r = bin(withGit(dir), ['verify']);
  const seenFile = join(dir, 'seen.json');
  assert.ok(existsSync(seenFile), r.stdout + r.stderr);
  const [current, old] = JSON.parse(readFileSync(seenFile, 'utf8'));
  assert.equal(current, '.turbo/e2e-report.json');
  assert.equal(old, current);
});
