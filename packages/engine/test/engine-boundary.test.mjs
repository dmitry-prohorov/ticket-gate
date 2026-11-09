import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// The supabase-next pack: tools/gate/packs/supabase-next in a project checkout, the
// sibling package packages/supabase-next in the two-package export. TICKET_GATE_PACK_DIR
// overrides both. Null (BT-9 skips, saying why) only when none exists.
const PACK_DIR = [
  process.env.TICKET_GATE_PACK_DIR,
  join(GATE_DIR, 'packs', 'supabase-next'),
  join(GATE_DIR, '..', 'supabase-next'),
].find((d) => d && existsSync(d));
const NEEDLES = [
  'apps/',
  'packages/',
  'supabase',
  'docs/tasks',
  '.claude/',
  '.agents/',
  // A project's package-manager command (INFRA-47 A): messages route through `commands`.
  'pnpm ',
];
// Any `tools/` path other than the engine's own `tools/gate` is a project script.
const TOOLS_NEEDLE = 'tools/<not gate>';
const TOOLS_RE = /tools\/(?!gate\/)/;
const KINDS = ['needle', 'import'];

// INFRA-44b R1 residual rows, drained by INFRA-45 S2: every project name now sits behind the
// config, the pack or `.ticket-gate/tree.json`. A new row needs a ticket that drains it.
const RESIDUAL = [];

const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);
const IMPORT_RES = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s*['"]([^'"]+)['"]/g,
];

function specifiersOf(line) {
  const found = [];
  for (const re of IMPORT_RES)
    for (const m of line.matchAll(re)) found.push(m[1]);
  return found;
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'packs' || e.name === 'test') continue;
      out.push(...walk(p));
    } else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

// Whether a specifier stays inside tools/gate (or node:) when imported from `rel` (posix, relative to gate dir).
function allowed(spec, rel) {
  if (spec.startsWith('node:')) return true;
  if (!spec.startsWith('.')) return false;
  const target = posix.normalize(posix.join(posix.dirname(rel), spec));
  return !target.startsWith('..');
}

// INFRA-47 A2: the engine reaches a pack only through the config (pack-hooks.mjs), never by import.
const PACK_IMPORT_RE = /(^|\/)packs\//;

export function scanEngine(gateDir) {
  const found = [];
  for (const file of walk(gateDir)) {
    const rel = relative(gateDir, file).split('\\').join('/');
    const name = `tools/gate/${rel}`;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (isComment(line)) return;
        let code = line;
        for (const spec of specifiersOf(line)) {
          if (!allowed(spec, rel) || PACK_IMPORT_RE.test(spec))
            found.push({
              file: name,
              line: i + 1,
              kind: 'import',
              value: spec,
            });
          code = code.split(spec).join('');
        }
        const lower = code.toLowerCase();
        for (const needle of NEEDLES)
          if (lower.includes(needle.toLowerCase()))
            found.push({
              file: name,
              line: i + 1,
              kind: 'needle',
              value: needle,
            });
        if (TOOLS_RE.test(lower))
          found.push({
            file: name,
            line: i + 1,
            kind: 'needle',
            value: TOOLS_NEEDLE,
          });
      });
  }
  return found;
}

// A pack file may import only tools/gate/ (engine modules, its own siblings) and node:. Paths
// are judged as if the pack sat at tools/gate/packs/supabase-next (its in-repo home); in the
// export the engine is reached as `#engine/<module>`, which counts as an engine import.
export function scanPack(packDir) {
  const found = [];
  const walkAll = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walkAll(join(dir, e.name))
        : e.name.endsWith('.mjs')
          ? [join(dir, e.name)]
          : [],
    );
  for (const file of walkAll(packDir)) {
    const rel = posix.join(
      'packs/supabase-next',
      relative(packDir, file).split('\\').join('/'),
    );
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (isComment(line)) return;
        for (const spec of specifiersOf(line))
          if (!spec.startsWith('#engine/') && !allowed(spec, rel))
            found.push({
              file: `tools/gate/${rel}`,
              line: i + 1,
              kind: 'import',
              value: spec,
            });
      });
  }
  return found;
}

const key = (r) => `${r.file}\t${r.kind}\t${r.value}`;

export function unexpected(found, residual) {
  const budget = new Map(residual.map((r) => [key(r), r.count]));
  const seen = new Map();
  for (const f of found) seen.set(key(f), (seen.get(key(f)) ?? 0) + 1);
  const problems = [];
  for (const [k, n] of seen) {
    const allowedN = budget.get(k) ?? 0;
    if (n !== allowedN) {
      const first = found.find((f) => key(f) === k);
      problems.push(
        `${first.file}:${first.line} ${first.kind} ${JSON.stringify(first.value)}: found ${n}, RESIDUAL allows ${allowedN}. ` +
          'Route it through the config or a pack, or (move-only) add a RESIDUAL row naming INFRA-45.',
      );
    }
  }
  for (const [k, n] of budget)
    if (!seen.has(k))
      problems.push(
        `RESIDUAL row ${k.split('\t').join(' ')} (count ${n}) matches nothing: delete it (shrink-only).`,
      );
  return problems;
}

function tempEngine(files) {
  const root = mkdtempSync(join(tmpdir(), 'engine-boundary-'));
  const dir = join(root, 'gate');
  cpSync(GATE_DIR, dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    const p = join(dir, rel);
    let prior = '';
    try {
      prior = readFileSync(p, 'utf8');
    } catch {
      /* new file */
    }
    writeFileSync(p, prior + text);
  }
  return { dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

function plantAndScan(files) {
  const t = tempEngine(files);
  try {
    return scanEngine(t.dir);
  } finally {
    t.done();
  }
}

const base = scanEngine(GATE_DIR);
const added = (after) =>
  after.filter(
    (a) =>
      !base.some(
        (b) => key(b) === key(a) && b.line === a.line && b.file === a.file,
      ),
  );

test('BT-1 the engine names no project path beyond RESIDUAL', () => {
  assert.deepEqual(RESIDUAL, []);
  assert.deepEqual(unexpected(scanEngine(GATE_DIR), RESIDUAL), []);
});

test('BT-2 a planted apps/ literal in plan.mjs is reported', () => {
  const after = plantAndScan({ 'plan.mjs': "\nconst x = 'apps/web';\n" });
  const hit = added(after).find(
    (f) => f.file === 'tools/gate/plan.mjs' && f.value === 'apps/',
  );
  assert.ok(hit, 'no violation naming tools/gate/plan.mjs and apps/');
  assert.match(
    unexpected(after, RESIDUAL).join('\n'),
    /tools\/gate\/plan\.mjs:\d+ needle "apps\/"/,
  );
});

test('BT-3 imports outside tools/gate and node: are reported', () => {
  const after = plantAndScan({
    'plan.mjs': [
      '',
      "import { x } from '../e2e-select.mjs';",
      'import {',
      '  y,',
      "} from '../../gate.config.mjs';",
      "const z = import('../mutate-check.mjs');",
      "import w from 'lodash';",
      "import fs from 'node:fs';",
      "import { r } from './run.mjs';",
      "import { s } from './packs/supabase-next/stack.mjs';",
      '',
    ].join('\n'),
  });
  const imports = added(after).filter(
    (f) => f.file === 'tools/gate/plan.mjs' && f.kind === 'import',
  );
  assert.deepEqual(imports.map((f) => f.value).sort(), [
    '../../gate.config.mjs',
    '../e2e-select.mjs',
    '../mutate-check.mjs',
    './packs/supabase-next/stack.mjs',
    'lodash',
  ]);
  assert.deepEqual(
    added(after).filter((f) => f.kind === 'needle'),
    [],
    'a pack import path must not count as a needle',
  );
});

test('BT-4 packs, tests and whole-line comments are outside the scan', () => {
  const quiet = plantAndScan({
    'packs/supabase-next/x.mjs': "export const a = 'apps/web';\n",
    'test/x.test.mjs': "export const a = 'apps/web';\n",
    'plan.mjs':
      '\n// apps/ in a comment\n/* supabase */\n * packages/ in a block\n',
  });
  assert.deepEqual(added(quiet), []);
  const loud = plantAndScan({ 'plan.mjs': '\nf(); // apps/\n' });
  assert.ok(
    added(loud).some(
      (f) => f.file === 'tools/gate/plan.mjs' && f.value === 'apps/',
    ),
  );
});

test('BT-5 each needle is matched case-insensitively', () => {
  for (const needle of [
    'apps/',
    'packages/',
    'Supabase',
    'docs/tasks',
  ]) {
    const after = plantAndScan({
      'plan.mjs': `\nconst q = '${needle.toUpperCase()} ${needle}';\n`,
    });
    assert.ok(
      added(after).some(
        (f) =>
          f.file === 'tools/gate/plan.mjs' &&
          f.value.toLowerCase() === needle.toLowerCase(),
      ),
      `${needle} not reported`,
    );
  }
});

test('BT-7 a planted tools/ script path or .claude/.agents path is reported', () => {
  for (const [text, value] of [
    ['node tools/mutate-check.mjs', TOOLS_NEEDLE],
    ["'tools/module-size-baseline.json'", TOOLS_NEEDLE],
    ['node tools/gate-sibling.mjs', TOOLS_NEEDLE],
    ["'.claude/agents'", '.claude/'],
    ["'.agents/skills'", '.agents/'],
    ['run pnpm verify:ticket', 'pnpm '],
  ]) {
    const after = plantAndScan({
      'precheck.mjs': `\nconst cmd = \`${text}\`;\n`,
    });
    assert.ok(
      added(after).some(
        (f) => f.file === 'tools/gate/precheck.mjs' && f.value === value,
      ),
      `${text} not reported`,
    );
  }
  const own = plantAndScan({
    'precheck.mjs': "\nconst own = 'tools/gate/run.mjs';\n",
  });
  assert.deepEqual(added(own), [], 'tools/gate is the engine itself');
});

test('BT-6 RESIDUAL entries are well-formed', () => {
  for (const r of RESIDUAL) {
    assert.ok(
      r.file && r.value && Number.isInteger(r.count) && r.count > 0,
      `bad row ${JSON.stringify(r)}`,
    );
    assert.ok(KINDS.includes(r.kind), `kind ${r.kind} not needle|import`);
    assert.equal(
      r.drain,
      'INFRA-45',
      `row ${key(r)} must name INFRA-45 in drain`,
    );
  }
  assert.equal(
    new Set(RESIDUAL.map(key)).size,
    RESIDUAL.length,
    'duplicate RESIDUAL row',
  );
});

test('BT-8 an engine file importing packs/ is reported (static, dynamic, side-effect)', () => {
  const after = plantAndScan({
    'plan.mjs': [
      '',
      "import { a } from './packs/supabase-next/index.mjs';",
      "const b = await import('./packs/supabase-next/steps.mjs');",
      "import './packs/other/x.mjs';",
      '',
    ].join('\n'),
  });
  assert.deepEqual(
    added(after)
      .filter((f) => f.file === 'tools/gate/plan.mjs' && f.kind === 'import')
      .map((f) => f.value)
      .sort(),
    [
      './packs/other/x.mjs',
      './packs/supabase-next/index.mjs',
      './packs/supabase-next/steps.mjs',
    ],
  );
  assert.match(
    unexpected(after, RESIDUAL).join('\n'),
    /tools\/gate\/plan\.mjs:\d+ import "\.\/packs\/supabase-next\/index\.mjs"/,
  );
});

test(
  'BT-9 a supabase-next pack file importing outside tools/gate and node: is reported',
  {
    skip: PACK_DIR ? false : 'no supabase-next pack: set TICKET_GATE_PACK_DIR',
  },
  () => {
    assert.deepEqual(
      scanPack(PACK_DIR),
      [],
      'the pack is closed over tools/gate',
    );
    const root = mkdtempSync(join(tmpdir(), 'engine-boundary-pack-'));
    const dir = join(root, 'supabase-next');
    cpSync(PACK_DIR, dir, { recursive: true });
    const steps = join(dir, 'index.mjs');
    writeFileSync(
      steps,
      readFileSync(steps, 'utf8') +
        [
          '',
          "import { x } from '../../../mutation-select.mjs';",
          "import y from 'lodash';",
          "const z = await import('../../../../gate.config.mjs');",
          "import { ok } from '../../root.mjs';",
          "import { ok2 } from './tools.mjs';",
          "import { ok3 } from '#engine/root.mjs';",
          "import fs from 'node:fs';",
          '',
        ].join('\n'),
    );
    try {
      assert.deepEqual(
        scanPack(dir)
          .map((f) => f.value)
          .sort(),
        [
          '../../../../gate.config.mjs',
          '../../../mutation-select.mjs',
          'lodash',
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// INFRA-72: the previous environment prefix is spelled in env-name.mjs and nowhere else in the
// engine. The needle is built from parts so this file does not match itself.
const OLD_PREFIX = new RegExp(
  '\\b' + 'F' + 'P_|[\'"]F[\'"]\\s*\\+\\s*[\'"]P_',
);

function scanOldPrefix(gateDir) {
  const found = [];
  for (const file of walk(gateDir)) {
    const rel = relative(gateDir, file).split('\\').join('/');
    if (rel === 'env-name.mjs') continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!isComment(line) && OLD_PREFIX.test(line))
          found.push(`${rel}:${i + 1}`);
      });
  }
  return found;
}

test('BT-9 only env-name.mjs names the old prefix', () => {
  assert.deepEqual(
    scanOldPrefix(GATE_DIR),
    [],
    'Read an environment name through envName(env, NAME) and set it through bothNames(NAME, value) from env-name.mjs; do not spell the old prefix elsewhere.',
  );
});

test('BT-9b a planted old-prefix read is reported', () => {
  const whole = 'F' + 'P_E2E_JSON';
  const t = tempEngine({
    'plan.mjs': `\nconst a = process.env.${whole};\n`,
    'lock.mjs': "\nconst b = process.env['F' + 'P_E2E_JSON'];\n",
  });
  try {
    const hits = scanOldPrefix(t.dir);
    assert.ok(hits.some((h) => h.startsWith('plan.mjs:')), hits.join('\n'));
    assert.ok(hits.some((h) => h.startsWith('lock.mjs:')), hits.join('\n'));
  } finally {
    t.done();
  }
});
