// NX-1..NX-4: the whole nightly through `ticket-gate nightly ...` in a synthetic project: a bare
// origin, a clone holding a gate.config.mjs whose `nightly` key comes from this checkout's engine,
// a fake runner and a pack that gives a payload. Nothing here needs docker, a browser or a network.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const ENGINE = join(import.meta.dirname, '..', '..');
const BIN = join(ENGINE, 'bin', 'ticket-gate.mjs');
const CONFIG_URL = pathToFileURL(join(ENGINE, 'config.mjs')).href;
const H = 3_600_000;

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd, ...a) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();

// The config text: two suites (the second writes a traces dir and an `extra`), a pack payload
// whose preflight needs the `probe` it ships in its own `io`, a fake scheduler.
const CONFIG = `import { defineGate, step } from '${CONFIG_URL}';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const summary = {
  stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 0 },
  flakySpecs: [],
  failedSpecs: [],
  redTests: [],
  navigation: {},
};
const a = { name: 'a', limitS: 60, runner: { run: async () => ({ timedOut: false, summary, report: null }) } };
const b = {
  name: 'b',
  limitS: 60,
  keep: { traces: 1 },
  runner: {
    statusLine: (view) => '  suite-b ' + view.status + ' note ' + view.extra.note,
    run: async ({ dir }) => {
      mkdirSync(join(dir, 'traces'), { recursive: true });
      writeFileSync(join(dir, 'traces', 't.txt'), 'trace');
      return { timedOut: false, summary, report: null, extra: { note: 'b-extra' } };
    },
  },
};
const pack = {
  name: 'demo-pack',
  version: '0.0.0',
  nightlyPayloads: [
    {
      name: 'probe-payload',
      io: { probe: async () => true },
      preflight: async (main, io) => ((await io.probe()) ? { ok: true } : { reason: 'probe-failed' }),
    },
  ],
};
export default defineGate({
  steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })],
  packs: [pack],
  nightly: {
    suites: [a, b],
    worktree: { dir: 'synth', install: ['node', '-e', '0'] },
    scheduler: { name: 'fake', install: (io, dir) => console.log('installed ' + dir) },
  },
});
`;

/** A bare origin with one commit, a clone of it holding the config, and a private TMPDIR. */
function project({ config = CONFIG } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nightly-synth-'));
  dirs.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');
  const scratch = join(root, 'tmp');
  mkdirSync(scratch);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'base.txt'), '1\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'one');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', origin, clone);
  writeFileSync(join(clone, 'gate.config.mjs'), config);
  const push = (n) => {
    writeFileSync(join(seed, 'base.txt'), `${n}\n`);
    git(seed, 'commit', '-qam', `commit ${n}`);
    git(seed, 'push', '-q', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  const sha = () => git(seed, 'rev-parse', 'HEAD');
  const nightly = (...args) =>
    spawnSync(process.execPath, [BIN, 'nightly', ...args], {
      cwd: clone,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: scratch },
    });
  const dir = join(clone, '.turbo', 'nightly');
  return { clone, dir, nightly, push, sha };
}

test('NX-1 a synthetic project runs a night through ticket-gate nightly run --now and nightly status prints it', () => {
  const p = project();
  const sha = p.sha();
  mkdirSync(p.dir, { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(p.dir, 'e2e-runs.jsonl'),
    [
      { ranAt: new Date(now - H).toISOString(), ms: 1_800_000, mode: 'full', why: 'nightly red' },
      { ranAt: new Date(now - 2 * H).toISOString(), ms: 1_800_000, mode: 'affected', why: 'affected: 1 areas' },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  );

  const run = p.nightly('run', '--now');
  assert.equal(run.status, 0, `run failed:\n${run.stdout}\n${run.stderr}`);
  const latest = JSON.parse(readFileSync(join(p.dir, 'latest.json'), 'utf8'));
  assert.equal(latest.status, 'green');
  assert.equal(latest.sha, sha);
  const hist = readFileSync(join(p.dir, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(hist.length, 1);
  assert.equal(hist[0].sha, sha);
  assert.equal(hist[0].status, 'green');

  const st = p.nightly('status');
  assert.equal(st.status, 0, st.stderr);
  const lines = st.stdout.split('\n');
  assert.ok(lines[0].startsWith(`green ${sha.slice(0, 12)}`), lines[0]);
  assert.ok(
    lines.includes(
      'move-to-ci 2: forced-full share 50% of 1.0 h in 14 days, queued branches 0 (MET; move at over 25% or 3 or more)',
    ),
    st.stdout,
  );
});

test('NX-2 two suites: the second\'s extra and statusLine reach the record and status, and keep.traces 1 keeps only the newest traces dir', () => {
  const p = project();
  const first = p.sha();
  assert.equal(p.nightly('run', '--now').status, 0);
  const second = p.push(2);
  const run = p.nightly('run', '--now');
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const latest = JSON.parse(readFileSync(join(p.dir, 'latest.json'), 'utf8'));
  assert.equal(latest.sha, second);
  assert.deepEqual(latest.suites.b.extra, { note: 'b-extra' });
  const st = p.nightly('status');
  assert.equal(st.stdout.split('\n')[1], '  suite-b green note b-extra');

  const nights = (sha) =>
    readFileSync(join(p.dir, 'history.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((l) => l.sha === sha)
      .map((l) => l.suites.b.report.split('/')[1]);
  const [n1] = nights(first);
  const [n2] = nights(second);
  assert.ok(n1 && n2 && n1 !== n2);
  assert.equal(existsSync(join(p.dir, 'b', n2, 'traces', 't.txt')), true, 'newest traces kept');
  assert.equal(existsSync(join(p.dir, 'b', n1, 'traces')), false, 'older traces dir removed');
});

test('NX-3 ticket-gate nightly without a nightly key exits 2 with the not-configured line; an unknown subcommand exits 2 with the usage', () => {
  const bare = project({
    config: `import { defineGate, step } from '${CONFIG_URL}';
export default defineGate({ steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })] });
`,
  });
  const r = bare.nightly('status');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nightly: FAIL nightly is not configured: add a nightly key to gate\.config\.mjs/);

  const p = project();
  const u = p.nightly('bogus');
  assert.equal(u.status, 2);
  assert.match(u.stderr, /usage: ticket-gate nightly run \[--now\] \| install \| status/);
});

test('NX-4 ticket-gate nightly install calls the configured scheduler with the nightly dir', () => {
  const p = project();
  const r = p.nightly('install');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^installed \S+\/\.turbo\/nightly$/m);
  assert.equal(r.stdout.trim().split('\n').at(-1).endsWith('.turbo/nightly'), true);
});
