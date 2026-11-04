// Run by `pnpm test:tools`. INFRA-45 EA-1..EA-12: the engine API a second project's
// gate.config.mjs needs (step, globRe, glob `when`, units, function health, a stop list,
// human lines, packs, defaults, the precheck slot, baseRef). Synthetic configs only: no
// project-specific step, path or command appears here. Cases that need the engine's own
// config (digest, precheck, baseRef) run it in a throwaway git repo under os.tmpdir().
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { enterScratchProject } from './scratch-project.mjs';

// plan.mjs and review-map.mjs load gate.config.mjs from the cwd at import: a scratch project
// keeps this file independent of the checkout it runs in.
enterScratchProject();
// root.mjs fixes ROOT when first imported, so config.mjs is imported after the chdir too.
const { defineGate, globRe, step } = await import('../config.mjs');
const { planCtx, planFor, selectUnits } = await import('../plan.mjs');
const { humanLinesFor, renderMarkdown } = await import('../review-map.mjs');

const GATE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const s = (id, extra = {}) =>
  step({ id, when: true, cmd: `run ${id}`, reuse: false, ...extra });
const gate = (over = {}) => defineGate({ steps: [s('a')], ...over });
const plan = (config, paths = ['x'], opts = {}) =>
  planFor(config, paths, { exists: () => true, base: 'HEAD', ...opts });
const ids = (list) => list.map((x) => x.id);

/** A temp git repo holding the engine, the project tools and `config` as gate.config.mjs. */
function engineRepo(config, branch = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'gate-api-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'tools'));
  cpSync(GATE_DIR, join(dir, 'tools', 'gate'), { recursive: true });
  writeFileSync(join(dir, 'gate.config.mjs'), config);
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: dir,
      stdio: 'pipe',
    })
      .toString()
      .trim();
  git('init', '-q', '-b', branch);
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { dir, git };
}

/** Runs `code` (ESM, top-level await) in `dir`; returns its last stdout line parsed as JSON. */
function inRepo(dir, code) {
  const r = spawnSync('node', ['--input-type=module', '-e', code], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const SIMPLE = `import { defineGate, step } from './tools/gate/config.mjs';
export default defineGate({
  packs: [{ name: 'p', version: '1' }],
  steps: [step({ id: 'a', when: true, cmd: 'x', reuse: { deny: [] } })],
  precheck: [
    { id: 'p1', cmd: 'echo one', fix: 'fix one <ID>' },
    { id: 'p2', cmd: ({ base }) => 'echo ' + base, fix: 'fix two' },
  ],
});
`;

test('EA-1 step fills why, notRun, summary and limitS and never reuse', () => {
  const st = step({ id: 'a', when: true, cmd: 'x', reuse: false });
  assert.equal(st.why, 'selected by when');
  assert.equal(st.notRun, 'not selected by when');
  assert.equal(st.limitS, 600);
  assert.equal(st.reuse, false);
  assert.equal(st.summary('one\n\ntwo \n'), 'two');
  assert.equal(st.summary(''), 'passed');
  // A given field is never overridden by a default.
  const own = step({
    id: 'a',
    when: true,
    cmd: 'x',
    why: 'w',
    notRun: 'n',
    limitS: 5,
    summary: () => 'mine',
  });
  assert.deepEqual(
    [own.why, own.notRun, own.limitS, own.summary('z')],
    ['w', 'n', 5, 'mine'],
  );
  // summary: { pick } is pick() over the output.
  const picked = step({
    id: 'a',
    when: true,
    cmd: 'x',
    summary: { pick: [/ok/] },
  });
  assert.equal(picked.summary('start\nit is ok 3\ntail'), 'it is ok 3');
  // reuse stays opt-in; a human step carries no limitS.
  assert.equal('reuse' in step({ id: 'a', when: true, cmd: 'x' }), false);
  const human = step({ id: 'h', when: true, cmd: 'x', human: true });
  assert.equal(human.limitS, undefined);
  assert.doesNotThrow(() => defineGate({ steps: [human] }));
});

test('EA-2 defineGate accepts the 4.2 surface and rejects its malformed forms', () => {
  const surface = {
    base: 'trunk',
    packs: [{ name: 'p', version: '1', extra: 'opaque' }],
    steps: [
      s('a'),
      s('b', {
        when: ['force-app/**'],
        stack: 'st',
        reuse: { deny: ['docs/'] },
      }),
      s('c', {
        when: () => true,
        units: { select: () => ({}), cmd: () => 'x' },
      }),
      step({ id: 'h', when: false, cmd: 'by hand', human: true }),
    ],
    stacks: {
      st: { health: (run) => `up ${run}`, start: 'go', lock: { path: 'l' } },
    },
    stopOnRedBefore: ['b', 'c'],
    reviewMap: {
      sizeExcluded: ['docs/**', '*.lock'],
      humanLines: [
        { match: 'force-app/**', line: 'deploy by hand' },
        { match: /\.sql$/, line: 'read the sql' },
      ],
    },
    dod: { files: ['docs/**/*.md'], contract: 'docs/{id}.md' },
    roles: { dev: { owns: ['src/**'], axis: 'BUG' } },
    skills: { dir: '.skills', lock: 'skills.lock' },
    precheck: [{ id: 'p', cmd: 'x', fix: 'y' }],
  };
  assert.doesNotThrow(() => defineGate(surface));
  const bad = (over, re) =>
    assert.throws(() => defineGate({ ...surface, ...over }), re);
  const withStep = (extra) => ({ steps: [s('a', extra)] });
  // M9: a bare string is not a glob list.
  bad(
    { ...withStep({ when: 'src/' }), stacks: {}, stopOnRedBefore: 'a' },
    /when must be a boolean, a glob list or a function/,
  );
  bad(
    { ...withStep({ when: [''] }), stacks: {}, stopOnRedBefore: 'a' },
    /when must be/,
  );
  // M11: a pack needs a string name and version.
  bad({ packs: [{ name: 'p' }] }, /a pack needs a string name and version/);
  bad({ packs: [{ version: '1' }] }, /a pack needs a string name and version/);
  // M13: units needs select and cmd.
  bad(
    {
      steps: [s('a', { units: { select: () => ({}) } })],
      stacks: {},
      stopOnRedBefore: 'a',
    },
    /units needs select\(ctx\) and cmd\(units\)/,
  );
  bad(
    {
      steps: [s('a', { units: { cmd: () => '' } })],
      stacks: {},
      stopOnRedBefore: 'a',
    },
    /units needs select\(ctx\) and cmd\(units\)/,
  );
  // M19: a humanLines entry needs a string line and a match.
  const rm = (humanLines) => ({ reviewMap: { sizeExcluded: [], humanLines } });
  bad(rm([{ match: 'a/**' }]), /humanLines need \{ match, line \}/);
  bad(rm([{ match: 'a/**', line: '' }]), /humanLines need \{ match, line \}/);
  bad(rm([{ line: 'x' }]), /humanLines need \{ match, line \}/);
  // An unknown key, and a sizeExcluded entry that is neither a glob nor a rule id.
  bad({ stopOnRedBfore: 'a' }, /stopOnRedBfore: unknown key/);
  bad({ reviewMap: { sizeExcluded: ['ZZ'] } }, /sizeExcluded.*"ZZ"/);
  bad({ roles: { dev: { owns: 'src' } } }, /roles\.dev/);
  bad({ precheck: [{ id: 'p', cmd: 'x' }] }, /precheck\[0\]: fix/);
});

test('EA-3 a non-human step without limitS still throws', () => {
  const plain = {
    id: 'a',
    when: true,
    cmd: 'x',
    why: 'w',
    notRun: 'n',
    summary: () => 'ok',
    reuse: false,
  };
  assert.throws(
    () => defineGate({ steps: [plain] }),
    /limitS must be a positive integer/,
  );
  assert.doesNotThrow(() => defineGate({ steps: [{ ...plain, limitS: 9 }] }));
  // step() never supplies reuse: a step it builds without one fails V4.
  assert.throws(
    () => defineGate({ steps: [step({ id: 'a', when: true, cmd: 'x' })] }),
    /reuse must be false/,
  );
});

test('EA-4 a glob when selects only on a matching path', () => {
  const lwc = gate({
    steps: [s('a', { when: ['force-app/**/lwc/**'] })],
    stopOnRedBefore: undefined,
  });
  const runs = (config, path) => ids(plan(config, [path]).steps);
  assert.deepEqual(runs(lwc, 'force-app/main/default/lwc/a/a.js'), ['a']);
  assert.deepEqual(runs(lwc, 'force-app/main/x.cls'), []);
  const braces = gate({
    steps: [
      s('a', { when: ['force-app/main/default/{objects,permissionsets}/**'] }),
    ],
  });
  assert.deepEqual(runs(braces, 'force-app/main/default/objects/A__c/f.xml'), [
    'a',
  ]);
  assert.deepEqual(
    runs(braces, 'force-app/main/default/permissionsets/p.xml'),
    ['a'],
  );
  assert.deepEqual(runs(braces, 'force-app/main/default/classes/p.cls'), []);
  const exact = gate({ steps: [s('a', { when: ['sfdx-project.json'] })] });
  assert.deepEqual(runs(exact, 'sfdx-project.json'), ['a']);
  assert.deepEqual(runs(exact, 'sfdx-projectXjson'), []);
  assert.deepEqual(runs(exact, 'pkg/sfdx-project.json'), []);
  // any path of the list matches
  assert.deepEqual(
    plan(braces, ['a', 'force-app/main/default/objects/o']).steps.length,
    1,
  );
  assert.ok(globRe('docs/**/*.md').test('docs/a.md'));
  assert.ok(globRe('a?c').test('abc') && !globRe('a?c').test('a/c'));
  assert.ok(!globRe('*.md').test('docs/a.md'));
});

test('EA-5 human lines follow the changed paths', () => {
  const lines = [
    { match: 'force-app/**', line: 'deploy by hand' },
    { match: /\.sql$/, line: 'read the sql' },
    { match: 'force-app/main/**', line: 'deploy by hand' },
  ];
  assert.deepEqual(humanLinesFor(lines, ['force-app/main/a.cls']), [
    'deploy by hand',
  ]);
  assert.deepEqual(humanLinesFor(lines, ['docs/a.md']), []);
  assert.deepEqual(humanLinesFor(lines, ['x/a.sql', 'force-app/main/a.cls']), [
    'deploy by hand',
    'read the sql',
  ]);
  const empty = { files: 0, lines: 0 };
  const map = {
    base: '0000000',
    files: [],
    totals: { HUMAN: empty, GATED: empty, MACHINE: empty },
  };
  assert.doesNotMatch(renderMarkdown(map), /Human steps:/);
  const out = renderMarkdown({ ...map, human: ['deploy by hand'] });
  assert.match(out, /Human steps:\n- deploy by hand$/);
});

const unitsStep = (select, extra = {}) =>
  s('u', {
    units: {
      select,
      cmd: (units) => `run ${units.map((u) => u.id).join(',')}`,
    },
    ...extra,
  });

test('EA-6 the planner calls units select and cmd', async () => {
  const one = (sel) => gate({ steps: [unitsStep(() => sel)] });
  const affected = {
    mode: 'affected',
    why: 'w',
    units: [{ id: 'U1', inputs: [] }],
  };
  // cmd composes the command from the selected units
  const p1 = plan(one(affected));
  assert.equal(p1.steps[0].cmd, 'run U1');
  assert.equal(p1.steps[0].selection.mode, 'affected');
  // zero affected units: the step does not run, and says why
  const none = plan(
    one({ mode: 'affected', why: 'nothing affected', units: [] }),
  );
  assert.deepEqual(ids(none.steps), []);
  assert.equal(none.notRun[0].notRun, 'nothing affected');
  // a full selection runs
  assert.deepEqual(
    ids(plan(one({ mode: 'full', why: 'w', units: [] })).steps),
    ['u'],
  );
  // a throwing selector runs the step in full, naming the error
  const boom = plan(
    gate({
      steps: [
        unitsStep(() => {
          throw new Error('boom');
        }),
      ],
    }),
  );
  assert.deepEqual(ids(boom.steps), ['u']);
  assert.equal(boom.steps[0].selection.mode, 'full');
  assert.match(boom.steps[0].selection.why, /boom/);
  // an async selector needs selectUnits first
  const asyncCfg = gate({ steps: [unitsStep(async () => affected)] });
  assert.throws(
    () => plan(asyncCfg),
    /units\.select of u is async: precompute with selectUnits\(\)/,
  );
  const ctx = planCtx(['x'], { exists: () => true });
  const sels = await selectUnits(asyncCfg, ctx);
  assert.deepEqual(Object.keys(sels), ['u']);
  assert.equal(plan(asyncCfg, ['x'], { units: sels }).steps[0].cmd, 'run U1');
  // a rejecting selector is a full Sel too
  const rejecting = gate({
    steps: [unitsStep(async () => Promise.reject(new Error('late')))],
  });
  const failed = await selectUnits(rejecting, ctx);
  assert.equal(failed.u.mode, 'full');
  assert.match(failed.u.why, /late/);
  // a step whose when does not hold is not selected
  const off = gate({ steps: [unitsStep(() => affected, { when: false })] });
  assert.deepEqual(await selectUnits(off, ctx), {});
  // a precomputed map without the step leaves it on its own cmd
  assert.equal(plan(asyncCfg, ['x'], { units: {} }).steps[0].cmd, 'run u');
});

test('EA-7 stopOnRedBefore takes a list', () => {
  const steps = [s('a'), s('b'), s('c')];
  assert.deepEqual(
    plan(defineGate({ steps, stopOnRedBefore: ['b', 'c'] })).stopBefore,
    ['b', 'c'],
  );
  assert.deepEqual(
    plan(defineGate({ steps, stopOnRedBefore: 'b' })).stopBefore,
    ['b'],
  );
  assert.deepEqual(plan(defineGate({ steps })).stopBefore, []);
  assert.throws(
    () => defineGate({ steps, stopOnRedBefore: ['b', 'zz'] }),
    /stopOnRedBefore: unknown step id "zz"/,
  );
});

test('EA-8 a pack version is a digest input', () => {
  const { dir } = engineRepo(SIMPLE);
  const got = inRepo(
    dir,
    `const { inputState, stepDigest } = await import('./tools/gate/digest.mjs');
     const state = inputState({ base: 'HEAD' });
     const bumped = { ...state, packs: ['p@2'] };
     console.log(JSON.stringify({
       packs: state.packs,
       same: stepDigest('a', 'x', { state }) === stepDigest('a', 'x', { state: bumped }),
     }));`,
  );
  assert.deepEqual(got.packs, ['p@1']);
  assert.equal(got.same, false);
});

test('EA-9 a function health is planned and a stack needs no reset', () => {
  const config = defineGate({
    steps: [s('a'), s('b', { stack: 'st' }), s('c', { stack: 'st' })],
    stacks: { st: { health: (run) => `up ${run.join()}` } },
  });
  const got = plan(config).steps;
  assert.deepEqual(ids(got), ['a', 'st:health', 'b', 'c']);
  assert.equal(got[1].cmd, 'up b,c');
  assert.equal(got[1].limitS, 120);
  // no stack step runs: no health step; a stack with no health at all plans too
  assert.deepEqual(ids(plan(config, ['x'], { skip: ['b', 'c'] }).steps), [
    'a',
    'b',
    'c',
  ]);
  const bare = defineGate({
    steps: [s('b', { stack: 'st' })],
    stacks: { st: {} },
  });
  assert.deepEqual(ids(plan(bare).steps), ['b']);
  const noRun = defineGate({
    steps: [s('b', { stack: 'st', when: false })],
    stacks: { st: { health: (run) => `up ${run}` } },
  });
  assert.deepEqual(ids(plan(noRun).steps), []);
});

test('EA-10 defaults are the safe ones', () => {
  const g = defineGate({
    steps: [s('a')],
    dod: { files: ['docs/*.md'], contract: 'docs/{id}.md' },
    reviewMap: {},
  });
  assert.deepEqual(g.pushGuard.protected, ['main', 'master']);
  assert.equal(g.dod.human, '(human)');
  assert.ok(g.dod.oversize.test('- oversize-accepted: because'));
  assert.ok(g.dod.oversize.test('oversize-accepted: because'));
  assert.ok(!g.dod.oversize.test('oversize-accepted:'));
  assert.deepEqual(
    [g.reviewMap.rules, g.reviewMap.warn, g.reviewMap.oversize],
    [[], 800, 1500],
  );
  assert.deepEqual([g.dataPaths, g.precheck, g.packs], [{}, [], []]);
  // an explicit empty guard is still refused, not defaulted
  assert.throws(
    () => defineGate({ steps: [s('a')], pushGuard: { protected: [] } }),
    /pushGuard\.protected/,
  );
});

test('EA-11 precheck entries run in order with base and ticket filled', async () => {
  const { dir } = engineRepo(SIMPLE);
  const got = inRepo(
    dir,
    `const { runPrecheck } = await import('./tools/gate/precheck.mjs');
     const cmds = [];
     const logs = [];
     const io = {
       run: (cmd) => { cmds.push(cmd); return { code: cmd === 'echo one' ? 1 : 0, out: 'bad' }; },
       log: (l) => logs.push(l),
       branch: () => 'main',
       registry: () => new Map(),
       baseRegistry: () => new Map(),
     };
     const code = await runPrecheck({ base: 'BASE1', ticket: 'T-9' }, io);
     console.log(JSON.stringify({ code, first: cmds.slice(0, 2), logs }));`,
  );
  assert.equal(got.code, 1);
  assert.deepEqual(got.first, ['echo one', 'echo BASE1']);
  assert.match(got.logs[0], /precheck p1: FAIL .*Fix: fix one T-9$/);
  assert.equal(got.logs[1], 'precheck p2: ok');
});

test('EA-12 baseRef prefers the configured base', () => {
  const { dir, git } = engineRepo(SIMPLE, 'trunk');
  const want = git('merge-base', 'trunk', 'HEAD');
  const got = inRepo(
    dir,
    `const { baseRef } = await import('./tools/gate/tree.mjs');
     console.log(JSON.stringify({ configured: baseRef('trunk'), none: baseRef() }));`,
  );
  assert.equal(got.configured, want);
  // no main, no origin/main and no preferred ref: HEAD
  assert.equal(got.none, 'HEAD');
});
