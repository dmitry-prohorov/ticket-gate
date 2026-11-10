// A synthetic project for the assertions ratchet: other counters, areas and paths than the
// ported EA tests use. Built under os.tmpdir() at run time; nothing here is tracked.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { assertions } from '../../../checks/assertions.mjs';
import { unguardedKind } from '../../../checks/assertions-unguarded.mjs';
import { resolveSetup } from '../../../mutations/kinds.mjs';

export const setup = resolveSetup({
  dir: 'registry',
  kinds: {
    unguarded: unguardedKind({
      from: /^tests\/.+\.test\.ts$/,
      fromHint: 'tests/<...>.test.ts',
    }),
  },
});

export const cfg = {
  name: 'demo-assertions',
  specs: {
    dir: 'src/tests',
    match: /\.test\.ts$/,
    header: /^\/\/ test-areas: ([a-z]+(, [a-z]+)*)$/,
  },
  areas: ['billing', 'search'],
  counters: { cases: 'it(', asserts: 'expect(' },
  from: 'tests/',
  receipt: 'out/mutations.json',
  baseline: 'gate/assertions.json',
  registry: 'registry/',
  comment: 'demo',
  commands: {
    update: 'demo update',
    mutate: 'demo mutate',
    usage: 'demo check',
  },
  setup,
};

export const ratchet = assertions(cfg);

export function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const spec = (areas, asserts, cases) =>
  `// test-areas: ${areas}\n${'it(\n'.repeat(cases)}${'expect(\n'.repeat(asserts)}`;

export const A_FILE = 'src/tests/a.test.ts';
export const aSpec = (asserts) => spec('billing', asserts, 1);

/** Writes the project and its baseline; returns { root, cleanup }. */
export function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'assertions-project-'));
  put(root, A_FILE, aSpec(3));
  put(root, 'src/tests/b.test.ts', spec('billing, search', 2, 2));
  put(root, 'src/tests/notes.md', 'expect(\nexpect(\n');
  const r = ratchet.checkE2eAssertions(root, { update: true });
  if (r.code !== 0) throw new Error(`baseline not written: ${r.lines.join('\n')}`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
