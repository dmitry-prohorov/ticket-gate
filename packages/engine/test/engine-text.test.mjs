import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// Same resolver as engine-boundary.test.mjs: the pack sits at packs/supabase-next inside the
// engine folder in a full checkout and at ../supabase-next in the two-package layout.
const PACK_DIR = [
  process.env.TICKET_GATE_PACK_DIR,
  join(GATE_DIR, 'packs', 'supabase-next'),
  join(GATE_DIR, '..', 'supabase-next'),
].find((d) => d && existsSync(d));

// Comments included, no allowlist: the engine and the pack are published, so no ticket id,
// planning-doc path or project name may appear anywhere in their text.
const PRIVATE_RE =
  /\b(INFRA|FU)-?\d+|\bP\d-\d+|docs\/tasks/i;

function mjsUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? mjsUnder(join(dir, e.name))
      : e.name.endsWith('.mjs')
        ? [join(dir, e.name)]
        : [],
  );
}

export function scanText(gateDir, packDir) {
  const files = [
    ...readdirSync(gateDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => join(gateDir, e.name)),
    ...['hooks', 'bin']
      .filter((d) => existsSync(join(gateDir, d)))
      .flatMap((d) => mjsUnder(join(gateDir, d))),
    ...(packDir ? mjsUnder(packDir) : []),
  ];
  const hits = [];
  for (const file of files)
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = PRIVATE_RE.exec(line);
        if (m)
          hits.push(
            `${relative(gateDir, file)}:${i + 1} "${m[0]}": reword it to the technical reason with no ticket id, doc path or project name`,
          );
      });
  return hits;
}

test('ET-1 the engine and the pack text names no private ticket, doc path or project', () => {
  assert.ok(PACK_DIR, 'no supabase-next pack: set TICKET_GATE_PACK_DIR');
  assert.deepEqual(scanText(GATE_DIR, PACK_DIR), []);
});

test('ET-2 a planted line in a copy of the engine or the pack is reported', () => {
  assert.ok(PACK_DIR, 'no supabase-next pack: set TICKET_GATE_PACK_DIR');
  const root = mkdtempSync(join(tmpdir(), 'engine-text-'));
  try {
    const gate = join(root, 'gate');
    const pack = join(root, 'pack');
    cpSync(GATE_DIR, gate, { recursive: true });
    cpSync(PACK_DIR, pack, { recursive: true });
    for (const [dir, rel] of [
      [gate, 'plan.mjs'],
      [gate, join('hooks', 'stop.mjs')],
      [gate, join('bin', 'ticket-gate.mjs')],
      [pack, 'steps.mjs'],
    ])
      for (const text of [
        '// INFRA-99: a ticket id',
        '// see FU12',
        '// P0-09 history',
        '// docs/tasks/contracts/x.md',
      ]) {
        const p = join(dir, rel);
        const before = readFileSync(p, 'utf8');
        writeFileSync(p, `${before}\n${text}\n`);
        const hits = scanText(gate, pack);
        assert.equal(hits.length, 1, `${rel} + ${text}: ${hits.join('; ')}`);
        assert.match(hits[0], new RegExp(rel.replace(/\\/g, '\\\\')));
        writeFileSync(p, before);
      }
    assert.deepEqual(scanText(gate, pack), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
