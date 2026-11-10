// SF-*: the surface ratchet over throwaway git repos in os.tmpdir().
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import {
  codeLines,
  globMatch,
  importsOf,
  surface,
} from '../../checks/surface.mjs';

// Built from parts so this file carries no package-scope literal.
const SCOPE = '@ticket-' + 'gate/';
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CFG = {
  manifest: 'tools/surface.json',
  baseline: 'tools/surface-baseline.json',
  roots: ['tools/', 'gate.config.mjs'],
  comment: 'test baseline',
  fix: 'Fix: classify the file.',
  usage: 'Usage: surface [--update [--seed]]',
};
const entry = (match, kind, extra = {}) => ({
  match: [].concat(match),
  kind,
  why: 'test',
  ...extra,
});

/** Builds the repo, stages `files` (plus `untracked` left out of the index), returns helpers. */
function fixture({ files = {}, manifest, baseline, untracked = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'surface-'));
  dirs.push(root);
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  if (manifest)
    put(
      CFG.manifest,
      typeof manifest === 'string'
        ? manifest
        : JSON.stringify({ comment: 'm', entries: [], ...manifest }),
    );
  if (baseline) put(CFG.baseline, JSON.stringify(baseline));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  for (const [rel, text] of Object.entries(untracked)) put(rel, text);
  const check = (args = []) => surface(CFG).check({ root, args });
  return { root, check, read: (rel) => readFileSync(join(root, rel), 'utf8') };
}

/** Manifest covering the manifest and baseline files themselves, plus `entries`. */
const withSelf = (entries, extra = {}) => ({
  entries: [
    entry(['tools/surface.json', 'tools/surface-baseline.json'], 'data'),
    ...entries,
  ],
  ...extra,
});
const BASE = { pending: [] };
const text = (r) => r.lines.join('\n');

test('SF-1a an unlisted tracked file fails rule 1', () => {
  const f = fixture({
    files: { 'tools/a.mjs': '', 'tools/b.mjs': '' },
    manifest: withSelf([entry('tools/a.mjs', 'data')]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(text(r), /\[rule 1\] tools\/b\.mjs: matches no entry/);
  assert.match(r.lines[0], /^surface: FAIL 1 problem\(s\) in 4 tracked files$/);
  assert.equal(r.lines.at(-1), CFG.fix);
});

test('SF-1b a stale glob fails rule 1', () => {
  const f = fixture({
    files: { 'tools/a.mjs': '' },
    manifest: withSelf([
      entry('tools/a.mjs', 'data'),
      entry('tools/gone/**', 'data'),
    ]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(
    text(r),
    /\[rule 1\] tools\/gone\/\*\*: matches no tracked file/,
  );
});

test('SF-1c a file in two globs fails rule 1', () => {
  const f = fixture({
    files: { 'tools/a.mjs': '' },
    manifest: withSelf([
      entry('tools/*.mjs', 'data'),
      entry('tools/a.mjs', 'check'),
    ]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(text(r), /\[rule 1\] tools\/a\.mjs: matches 2 entries/);
});

test('SF-1d roots, tracking and globs', () => {
  const f = fixture({
    files: {
      'gate.config.test.mjs': '',
      'tools/x/a/b.json': '',
      'tools/x/a.mjs': '',
    },
    untracked: { 'tools/u.mjs': '' },
    manifest: withSelf([
      entry('tools/x/**', 'data'),
      entry('tools/*.mjs', 'data'),
    ]),
    baseline: BASE,
  });
  const r = f.check();
  // gate.config.test.mjs is outside the exact root and tools/u.mjs is untracked.
  assert.equal(r.code, 1);
  assert.match(text(r), /\[rule 1\] tools\/\*\.mjs: matches no tracked file/);
  assert.doesNotMatch(text(r), /gate\.config\.test|tools\/u\.mjs/);
  assert.ok(globMatch('tools/x/**', 'tools/x/a/b.json'));
  assert.ok(globMatch('tools/x/**', 'tools/x/a.mjs'));
  assert.ok(!globMatch('tools/*.mjs', 'tools/x/a.mjs'));
  assert.ok(globMatch('tools/*.mjs', 'tools/a.mjs'));
  assert.ok(!globMatch('gate.config.mjs', 'gate.config.test.mjs'));
  assert.ok(globMatch('a/**/z', 'a/z'));
  assert.ok(globMatch('a/**/z', 'a/b/c/z'));
});

test('SF-2a an added pending glob fails rule 2', () => {
  const f = fixture({
    files: { 'tools/a.mjs': '', 'tools/b.mjs': '' },
    manifest: withSelf([
      entry('tools/a.mjs', 'pending', { owner: 'TK-1' }),
      entry('tools/b.mjs', 'pending', { owner: 'TK-1' }),
    ]),
    baseline: { pending: ['tools/a.mjs'] },
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(
    text(r),
    /\[rule 2\] tools\/b\.mjs: pending entry is not in the baseline/,
  );
  assert.doesNotMatch(text(r), /\[rule 2\] tools\/a\.mjs/);
});

test('SF-2b a removed pending glob passes and --update only drops', () => {
  const f = fixture({
    files: { 'tools/a.mjs': '', 'tools/b.mjs': '' },
    manifest: withSelf([
      entry('tools/a.mjs', 'pending', { owner: 'TK-1' }),
      entry('tools/b.mjs', 'data'),
    ]),
    baseline: { pending: ['tools/a.mjs', 'tools/z.mjs'] },
  });
  assert.equal(f.check().code, 0);
  const u = f.check(['--update']);
  assert.equal(u.code, 0);
  assert.equal(
    u.lines[0],
    'surface: baseline tools/surface-baseline.json: 1 pending globs (removed 1)',
  );
  assert.deepEqual(JSON.parse(f.read(CFG.baseline)), {
    comment: 'test baseline',
    pending: ['tools/a.mjs'],
  });
  assert.ok(f.read(CFG.baseline).endsWith('}\n'));
  // Now the manifest gains a pending glob the baseline lacks: --update refuses.
  writeFileSync(
    join(f.root, CFG.manifest),
    JSON.stringify({
      comment: 'm',
      entries: withSelf([
        entry('tools/a.mjs', 'pending', { owner: 'TK-1' }),
        entry('tools/b.mjs', 'pending', { owner: 'TK-1' }),
      ]).entries,
    }),
  );
  const before = f.read(CFG.baseline);
  const refused = f.check(['--update']);
  assert.equal(refused.code, 1);
  assert.match(text(refused), /tools\/b\.mjs/);
  assert.equal(f.read(CFG.baseline), before);
});

test('SF-2c a pending entry needs an owner matching ownerPattern', () => {
  const pattern = { ownerPattern: '^TK-[0-9]+[a-z]?$' };
  for (const owner of [undefined, 'later']) {
    const f = fixture({
      files: { 'tools/a.mjs': '' },
      manifest: withSelf(
        [entry('tools/a.mjs', 'pending', owner ? { owner } : {})],
        pattern,
      ),
      baseline: { pending: ['tools/a.mjs'] },
    });
    const r = f.check();
    assert.equal(r.code, 1, String(owner));
    assert.match(
      text(r),
      /\[rule 2\] tools\/a\.mjs: pending entry names no owner ticket/,
    );
  }
  const ok = fixture({
    files: { 'tools/a.mjs': '' },
    manifest: withSelf(
      [entry('tools/a.mjs', 'pending', { owner: 'TK-78' })],
      pattern,
    ),
    baseline: { pending: ['tools/a.mjs'] },
  });
  const r = ok.check();
  assert.equal(r.code, 0);
  assert.match(r.lines[2], /^ {2}pending: 1 globs \(TK-78 1\)$/);
});

test('SF-2d strict and a missing baseline are input errors', () => {
  const strict = fixture({
    files: { 'tools/a.mjs': '' },
    manifest: withSelf([entry('tools/a.mjs', 'data')], {
      strict: 'yes',
      budget: { check: 3, wiring: 1 },
    }),
    baseline: BASE,
  });
  const s = strict.check();
  assert.equal(s.code, 2);
  assert.match(s.lines[0], /^surface: strict must be true or false$/);

  const missing = fixture({
    files: { 'tools/a.mjs': '' },
    manifest: withSelf([entry('tools/a.mjs', 'pending', { owner: 'X-1' })]),
  });
  const m = missing.check();
  assert.equal(m.code, 2);
  assert.match(text(m), /no baseline at tools\/surface-baseline\.json/);
  const seeded = missing.check(['--update', '--seed']);
  assert.equal(seeded.code, 0);
  assert.deepEqual(JSON.parse(missing.read(CFG.baseline)).pending, [
    'tools/a.mjs',
  ]);
  execFileSync('git', ['add', '-A'], { cwd: missing.root });
  const again = missing.check();
  assert.equal(again.code, 0, text(again));

  const bad = missing.check(['--bogus']);
  assert.equal(bad.code, 2);
  assert.equal(bad.lines.at(-1), CFG.usage);
});

test('SF-3a a config file importing node:fs fails rule 3', () => {
  const f = fixture({
    files: {
      'tools/c.mjs': "import { readFileSync } from 'node:fs';\n",
      'tools/d.mjs': "import { execFileSync } from 'node:child_process';\n",
    },
    manifest: withSelf([
      entry('tools/c.mjs', 'config'),
      entry('tools/d.mjs', 'data'),
    ]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(text(r), /\[rule 3\] tools\/c\.mjs: imports node:fs/);
  assert.match(text(r), /\[rule 3\] tools\/d\.mjs: imports node:child_process/);
});

test('SF-3b a config file calling fetch fails rule 3', () => {
  const f = fixture({
    files: {
      'tools/c.mjs': 'export const x = await fetch(url);\n',
      'tools/d.mjs': '// fetch(url) is not called\nexport const y = 1;\n',
    },
    manifest: withSelf([
      entry('tools/c.mjs', 'config'),
      entry('tools/d.mjs', 'config'),
    ]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(text(r), /\[rule 3\] tools\/c\.mjs: calls fetch\(/);
  assert.doesNotMatch(text(r), /tools\/d\.mjs/);
});

test('SF-3c config imports: allowed targets', () => {
  const allowed = [
    `import a from '${SCOPE}engine/x.mjs';`,
    "import b from 'node:path';",
    "import c from 'node:url';",
    "import d from './d.mjs';",
    "import e from './p.mjs';",
    "import f from './k.mjs';",
  ].join('\n');
  const mk = (extra) =>
    fixture({
      files: {
        'tools/c.mjs': `${allowed}\n${extra}\n`,
        'tools/d.mjs': '',
        'tools/p.mjs': '',
        'tools/k.mjs': '',
        'tools/t.mjs': '',
      },
      manifest: withSelf(
        [
          entry('tools/c.mjs', 'config'),
          entry('tools/d.mjs', 'data'),
          entry('tools/k.mjs', 'check'),
          entry('tools/p.mjs', 'pending', { owner: 'X-1' }),
          entry('tools/t.mjs', 'test'),
        ],
        {},
      ),
      baseline: { pending: ['tools/p.mjs'] },
    });
  const ok = mk('').check();
  assert.equal(ok.code, 0, text(ok));
  const t = mk("import g from './t.mjs';").check();
  assert.equal(t.code, 1);
  assert.match(text(t), /\[rule 3\] tools\/c\.mjs: imports \.\/t\.mjs/);
  const bare = mk("import h from 'rrule';").check();
  assert.equal(bare.code, 1);
  assert.match(text(bare), /\[rule 3\] tools\/c\.mjs: imports rrule/);
});

test('SF-4a a 16-code-line shim fails rule 4, 15 passes', () => {
  const filler = Array.from({ length: 20 }, (_, i) => `// note ${i}\n\n`).join(
    '',
  );
  const body = (n) =>
    Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join(
      '\n',
    );
  const f = fixture({
    files: {
      'tools/s16.mjs': `${filler}${body(16)}\n`,
      'tools/s15.mjs': `${filler}/* block\n   comment */\n${body(15)}\n`,
    },
    manifest: withSelf([entry(['tools/s16.mjs', 'tools/s15.mjs'], 'shim')]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(text(r), /\[rule 4\] tools\/s16\.mjs: has 16 code lines/);
  assert.doesNotMatch(text(r), /s15/);
  assert.equal(
    codeLines('// c\n\nconst a = 1;\n/* x\n y */\nconst b = 2;\n'),
    2,
  );
});

test('SF-4b a shim importing a relative module fails rule 4', () => {
  const f = fixture({
    files: {
      'tools/s1.mjs': "import { x } from './impl.mjs';\n",
      'tools/s2.mjs': `import a from '${SCOPE}engine/a.mjs';\nimport b from 'node:url';\n`,
      'tools/impl.mjs': '',
    },
    manifest: withSelf([
      entry(['tools/s1.mjs', 'tools/s2.mjs'], 'shim'),
      entry('tools/impl.mjs', 'data'),
    ]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(text(r), /\[rule 4\] tools\/s1\.mjs: imports \.\/impl\.mjs/);
  assert.doesNotMatch(text(r), /s2/);
});

test('SF-4c an entry with no why is an input error', () => {
  const f = fixture({
    files: { 'tools/s.mjs': '' },
    manifest: withSelf([{ match: ['tools/s.mjs'], kind: 'shim', why: ' ' }]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 2);
  assert.match(
    r.lines[0],
    /^surface: entries\[1\] \(tools\/s\.mjs\): why must/,
  );
});

test(`SF-6a a test importing ${SCOPE}engine/plan.mjs fails rule 6`, () => {
  const f = fixture({
    files: {
      'tools/x.test.mjs': `import { p } from '${SCOPE}engine/plan.mjs';\n`,
      'tools/y.test.mjs': `import { c } from '${SCOPE}engine/config.mjs';\nimport d from '${SCOPE}engine';\n`,
      'tools/w.mjs': `import { p } from '${SCOPE}engine/plan.mjs';\n`,
    },
    manifest: withSelf([
      entry(['tools/x.test.mjs', 'tools/y.test.mjs'], 'test'),
      entry('tools/w.mjs', 'wiring'),
    ]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(
    text(r),
    /\[rule 6\] tools\/x\.test\.mjs: imports @ticket-gate\/engine\/plan\.mjs/,
  );
  assert.doesNotMatch(text(r), /y\.test|w\.mjs/);
});

test('SF-7 pending files skip rules 3, 4 and 6', () => {
  const f = fixture({
    files: {
      'tools/p.mjs':
        "import { readFileSync } from 'node:fs';\nawait fetch(u);\n",
      'tools/q.test.mjs': `import { p } from '${SCOPE}engine/plan.mjs';\n`,
    },
    manifest: withSelf([
      entry(['tools/p.mjs', 'tools/q.test.mjs'], 'pending', { owner: 'X-1' }),
    ]),
    baseline: { pending: ['tools/p.mjs', 'tools/q.test.mjs'] },
  });
  const r = f.check();
  assert.equal(r.code, 0, text(r));
  assert.match(r.lines[0], /^surface: OK 4 tracked files, 2 entries, 4 globs$/);
  assert.match(r.lines[1], /pending 2$/);
});

test('SF-10 an unknown kind is an input error', () => {
  const f = fixture({
    files: { 'tools/a.mjs': '' },
    manifest: withSelf([entry('tools/a.mjs', 'engine')]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 2);
  assert.match(
    r.lines[0],
    /entries\[1\] \(tools\/a\.mjs\): unknown kind engine/,
  );
});

test('SF-importsOf finds from, dynamic and bare imports on code lines only', () => {
  const src =
    "import a from 'x';\n// import b from 'y';\nimport 'z';\nconst m = await import('w');\n";
  assert.deepEqual(importsOf(src), ['x', 'w', 'z']);
});

test('SF-importsOf-str a quoted from, and from in a comment or string, are not specifiers', () => {
  assert.deepEqual(importsOf("const F = ['kind', 'from', 'why'];\n"), []);
  assert.deepEqual(importsOf('const s = "x from \'y\'";\n// import a from \'c\'\n'), []);
  const real =
    "import a from 'a';\nimport 'b';\nexport * from 'c';\nexport { d } from 'd';\nconst m = await import('e');\n";
  assert.deepEqual(importsOf(`const F = ['from', 'why'];\n${real}`), ['a', 'c', 'd', 'e', 'b']);
});

test('SF-importsOf-re a quote in a regex literal hides no import', () => {
  assert.deepEqual(importsOf("const r = /`/;\nimport('x');\nconst t = `y`;\n"), ['x']);
  assert.deepEqual(importsOf("const q = /['\"]/;\nimport a from 'a';\n"), ['a']);
  assert.equal(codeLines("const r = /`/;\nimport('x');\n"), 2);
});

test('SF-8 owner counts are per glob, not per match squared', () => {
  const f = fixture({
    files: { 'tools/a.mjs': '', 'tools/b.mjs': '', 'tools/c.mjs': '' },
    manifest: withSelf(
      [
        entry(['tools/a.mjs', 'tools/b.mjs', 'tools/c.mjs'], 'pending', {
          owner: 'TK-78',
        }),
      ],
      { ownerPattern: '^TK-[0-9]+$' },
    ),
    baseline: { pending: ['tools/a.mjs', 'tools/b.mjs', 'tools/c.mjs'] },
  });
  assert.match(f.check().lines[2], /\(TK-78 3\)$/);
});

test('an inline side-effect import after ; fails rule 3', () => {
  const f = fixture({
    files: { 'tools/c.mjs': "const a = 1; import 'node:fs';\n" },
    manifest: withSelf([entry('tools/c.mjs', 'config')]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(text(r), /\[rule 3\] tools\/c\.mjs: imports node:fs/);
});

test('a division is not a regex literal: a block comment after it is still stripped', () => {
  assert.equal(codeLines('const q = a / b; /* c\n d\n e */\n'), 1);
  assert.deepEqual(importsOf("const q = a / b; /* x from 'node:fs' */\n"), []);
});

test('codeLines ignores quotes and comment markers inside a regex literal', () => {
  assert.equal(codeLines("const r = /'/;\n// c\n"), 1);
  const f = fixture({
    files: {
      'tools/c.mjs': "const r = /a\\/*/;\nimport { x } from 'node:fs';\n",
    },
    manifest: withSelf([entry('tools/c.mjs', 'config')]),
    baseline: BASE,
  });
  const r = f.check();
  assert.equal(r.code, 1);
  assert.match(text(r), /\[rule 3\] tools\/c\.mjs: imports node:fs/);
});

const lines = (n) =>
  Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') +
  '\n';
const STRICT_BASE = { pending: [], budget: { check: 6 } };
const strictFixture = ({ files, entries, budget, baseline = STRICT_BASE }) =>
  fixture({
    files,
    manifest: withSelf(entries, { strict: true, budget }),
    baseline,
  });
const CHECK_FILES = {
  'tools/c1.mjs': `// c\n\n${lines(3)}/* x\n y */\n`,
  'tools/c2.mjs': lines(2),
  'tools/t.test.mjs': lines(4),
  'tools/w.mjs': lines(4),
  'tools/s.mjs': lines(4),
};
const CHECK_ENTRIES = [
  entry(['tools/c1.mjs', 'tools/c2.mjs'], 'check'),
  entry('tools/t.test.mjs', 'test'),
  entry('tools/w.mjs', 'wiring'),
  entry('tools/s.mjs', 'support'),
];

test('SF-11 strict needs budget.check and budget.wiring', () => {
  const cases = [
    [undefined, 'check'],
    [{ check: -1, wiring: 1 }, 'check'],
    [{ check: 3, wiring: 1.5 }, 'wiring'],
    [{ check: '3', wiring: 1 }, 'check'],
    [{ check: 3 }, 'wiring'],
  ];
  for (const [budget, key] of cases) {
    const f = strictFixture({
      files: { 'tools/a.mjs': '' },
      entries: [entry('tools/a.mjs', 'data')],
      budget,
    });
    const r = f.check();
    assert.equal(r.code, 2, JSON.stringify(budget));
    assert.equal(
      r.lines[0],
      `surface: strict needs budget.${key}, a non-negative integer`,
    );
  }
});

test('SF-2e a pending entry fails rule 2 in strict mode', () => {
  const mk = (strict) =>
    fixture({
      files: { 'tools/a.mjs': '' },
      manifest: withSelf([entry('tools/a.mjs', 'pending', { owner: 'TK-1' })], {
        strict,
        budget: { check: 9, wiring: 9 },
      }),
      baseline: { pending: ['tools/a.mjs'], budget: { check: 9 } },
    });
  const r = mk(true).check();
  assert.equal(r.code, 1);
  assert.match(
    text(r),
    /\[rule 2\] tools\/a\.mjs: pending entry in strict mode/,
  );
  assert.doesNotMatch(text(r), /not in the baseline|names no owner/);
  assert.equal(mk(false).check().code, 0);
});

test('SF-5a check code lines over budget.check fail rule 5, equal passes', () => {
  const mk = (check) =>
    strictFixture({
      files: CHECK_FILES,
      entries: CHECK_ENTRIES,
      budget: { check, wiring: 1 },
      baseline: { pending: [], budget: { check: 9 } },
    });
  const over = mk(4).check();
  assert.equal(over.code, 1);
  assert.match(
    text(over),
    /\[rule 5\] tools\/surface\.json: check files have 5 code lines, over budget\.check 4/,
  );
  const ok = mk(5).check();
  assert.equal(ok.code, 0, text(ok));
  assert.equal(ok.lines.length, 4);
  assert.equal(ok.lines[3], '  budget: check 5/5 code lines, wiring 1/1 files');
});

test('SF-5b budget.check over the baseline fails rule 5', () => {
  const mk = (check) =>
    strictFixture({
      files: { 'tools/c.mjs': lines(3) },
      entries: [entry('tools/c.mjs', 'check')],
      budget: { check, wiring: 0 },
      baseline: { pending: [], budget: { check: 5 } },
    });
  const over = mk(6).check();
  assert.equal(over.code, 1);
  assert.match(
    text(over),
    /\[rule 5\] tools\/surface\.json: budget\.check 6 is over 5 in tools\/surface-baseline\.json; the budget only goes down/,
  );
  const ok = mk(4).check();
  assert.equal(ok.code, 0, text(ok));
});

test('SF-5c strict --update records budget.check and refuses a raise', () => {
  const mk = (check, baseline = BASE) =>
    strictFixture({
      files: { 'tools/c.mjs': lines(3) },
      entries: [entry('tools/c.mjs', 'check')],
      budget: { check, wiring: 0 },
      baseline,
    });
  const first = mk(6);
  const u = first.check(['--update']);
  assert.equal(u.code, 0, text(u));
  assert.equal(
    u.lines[0],
    'surface: baseline tools/surface-baseline.json: 0 pending globs (removed 0), budget.check 6',
  );
  assert.deepEqual(JSON.parse(first.read(CFG.baseline)), {
    comment: 'test baseline',
    pending: [],
    budget: { check: 6 },
  });

  const raise = mk(7, STRICT_BASE);
  const before = raise.read(CFG.baseline);
  const refused = raise.check(['--update']);
  assert.equal(refused.code, 1);
  assert.equal(
    refused.lines[0],
    'surface: refused: budget.check 7 is over 6 in tools/surface-baseline.json. A budget only goes down.',
  );
  assert.equal(refused.lines[1], CFG.fix);
  assert.equal(raise.read(CFG.baseline), before);

  const lower = mk(4, STRICT_BASE);
  assert.equal(lower.check(['--update']).code, 0);
  assert.equal(JSON.parse(lower.read(CFG.baseline)).budget.check, 4);
});

test('SF-5d strict with no baseline budget.check is an input error', () => {
  const mk = (baseline) =>
    strictFixture({
      files: { 'tools/c.mjs': lines(1) },
      entries: [entry('tools/c.mjs', 'check')],
      budget: { check: 3, wiring: 0 },
      baseline,
    });
  const none = mk(BASE).check();
  assert.equal(none.code, 2);
  assert.match(
    text(none),
    /has no budget\.check\. Fix: run the ratchet once with --update/,
  );
  const bad = mk({ pending: [], budget: { check: 'x' } }).check();
  assert.equal(bad.code, 2);
  assert.match(text(bad), /budget\.check must be a non-negative integer/);
});

test('SF-6b more wiring files than budget.wiring fail rule 6', () => {
  const mk = (wiring) =>
    strictFixture({
      files: { 'tools/w1.mjs': '', 'tools/w2.mjs': '' },
      entries: [entry(['tools/w1.mjs', 'tools/w2.mjs'], 'wiring')],
      budget: { check: 0, wiring },
      baseline: { pending: [], budget: { check: 0 } },
    });
  const over = mk(1).check();
  assert.equal(over.code, 1);
  assert.match(
    text(over),
    /\[rule 6\] tools\/surface\.json: 2 files of kind wiring \(tools\/w1\.mjs, tools\/w2\.mjs\), over budget\.wiring 1/,
  );
  assert.equal(mk(2).check().code, 0);
});

test('SF-9 non-strict ignores budget', () => {
  for (const strict of [undefined, false]) {
    const f = fixture({
      files: {
        'tools/c.mjs': lines(3),
        'tools/w1.mjs': '',
        'tools/w2.mjs': '',
      },
      manifest: withSelf(
        [
          entry('tools/c.mjs', 'check'),
          entry(['tools/w1.mjs', 'tools/w2.mjs'], 'wiring'),
        ],
        { strict, budget: { check: 0, wiring: 0 } },
      ),
      baseline: BASE,
    });
    const r = f.check();
    assert.equal(r.code, 0, text(r));
    assert.equal(r.lines.length, 3);
    assert.equal(f.check(['--update']).code, 0);
    assert.deepEqual(JSON.parse(f.read(CFG.baseline)), {
      comment: 'test baseline',
      pending: [],
    });
  }
});
