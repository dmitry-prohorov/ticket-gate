// BS-1, BS-2: the score engine is generic. No non-test module beside this
// file names a project: not in code, not in a comment. Unlike the gate
// engine's boundary test, comments are scanned too. Needles that would name
// a project are built from parts so this file passes its own scan.
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../../score', import.meta.url));

const NEEDLES = [
  'apps/',
  'packages/',
  'supabase',
  'docs/' + 'tasks',
  '.claude/',
  '.agents/',
  'pnpm ',
  '@f' + 'p/',
  'f' + 'p-',
  'f' + 'p_',
  'family' + '-planner',
  'dev-qa',
  'tools' + '/',
];
const TICKET_ID = /\b(?:INFRA|FU|P\d)-?\d+/;
// Known, reasoned exceptions: file -> [needle]. Empty: the engine names nothing.
const RESIDUAL = [];

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(join(dir, e.name))
      : e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')
        ? [join(dir, e.name)]
        : [],
  );

// Every violation in one source: needles and ticket ids anywhere (comments
// included), and imports that are neither node:* nor inside `root`.
export function scan(rel, text, root = ENGINE, file = join(root, rel)) {
  const found = [];
  const lower = text.toLowerCase();
  for (const needle of NEEDLES)
    if (lower.includes(needle)) found.push(`${rel}: names "${needle}"`);
  const id = TICKET_ID.exec(text);
  if (id) found.push(`${rel}: names ticket id "${id[0]}"`);
  const specs = [
    ...text.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm,
    ),
  ].map((m) => m[2]);
  for (const spec of specs) {
    if (spec.startsWith('node:')) continue;
    if (spec.startsWith('.')) {
      const target = join(dirname(file), spec);
      if (relative(root, target).startsWith('..'))
        found.push(`${rel}: imports outside the engine "${spec}"`);
      continue;
    }
    found.push(`${rel}: imports "${spec}" (only node:* or relative)`);
  }
  return found;
}

test('BS-1 the score engine names no project', () => {
  const found = walk(ENGINE).flatMap((f) =>
    scan(relative(ENGINE, f), readFileSync(f, 'utf8')),
  );
  assert.deepEqual(
    found.filter((v) => !RESIDUAL.includes(v)),
    [],
    'The score engine must stay project-free. Move the project value into the score config and read it from the cfg argument.',
  );
});

test('BS-2 each needle, a ticket id in a comment and a ../../ import are found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-boundary-'));
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    for (const needle of NEEDLES) {
      const hits = scan('x.mjs', `// see ${needle}x\n`, dir);
      assert.equal(hits.length > 0, true, `needle ${needle} not found`);
    }
    const comment = scan(
      'x.mjs',
      `// fixed in ${'INFRA' + '-62'}\nexport const a = 1;\n`,
      dir,
    );
    assert.ok(
      comment.some((v) => v.includes('ticket id')),
      comment.join('\n'),
    );
    for (const id of ['FU' + '12', 'P3' + '-04'])
      assert.ok(scan('x.mjs', `// ${id}\n`, dir).length > 0, id);
    writeFileSync(
      join(dir, 'sub', 'y.mjs'),
      "import { z } from '../../z.mjs';\n",
    );
    const imp = scan(
      'sub/y.mjs',
      readFileSync(join(dir, 'sub', 'y.mjs'), 'utf8'),
      dir,
    );
    assert.ok(
      imp.some((v) => v.includes('outside the engine')),
      imp.join('\n'),
    );
    assert.ok(
      scan('x.mjs', "import { a } from 'left-pad';\n", dir).length > 0,
      'a bare package import is found',
    );
    assert.deepEqual(
      scan(
        'x.mjs',
        "import { a } from 'node:fs';\nimport { b } from './b.mjs';\n",
        dir,
      ),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
