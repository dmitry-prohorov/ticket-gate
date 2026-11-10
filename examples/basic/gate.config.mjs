// The gate of this example project. `ticket-gate` finds it by walking up from the working directory.
import { defineGate, step } from '@ticket-gate/engine';

export default defineGate({
  // The branch the diff is measured against. A ref that does not exist falls back to HEAD.
  base: 'main',

  // Run in order; a step runs only when its `when` matches a changed path.
  steps: [
    step({
      id: 'lint',
      when: ['src/**'],
      cmd: 'node --check src/sum.mjs',
      // A pass on an identical input can be reused; a change to a denied path never invalidates it.
      reuse: { deny: ['*.md', 'test/'] },
    }),
    step({
      id: 'test',
      when: ['src/**', 'test/**', 'package.json'],
      cmd: 'npm test',
      reuse: { deny: ['*.md'] },
      // The line of the output that goes into the receipt and the summary.
      summary: { pick: [/^ℹ pass \d+/, /^# pass \d+/] },
      limitS: 120,
    }),
  ],

  // Every changed path lands in exactly one tier; the first matching rule wins and an unmatched path is HUMAN.
  // `match` gets the changed file: { path, added, removed, addedLines: [{ line, text }], depsChanged, ... }.
  reviewMap: {
    rules: [
      {
        id: 'deps',
        tier: 'HUMAN',
        reason: 'a dependency changed',
        match: ({ path, depsChanged }) => path === 'package.json' && depsChanged,
      },
      {
        id: 'eval',
        tier: 'HUMAN',
        reason: 'adds eval or new Function',
        match: ({ addedLines }) => addedLines.some(({ text }) => /\beval\(|new Function\(/.test(text)),
      },
      { id: 'gate', tier: 'HUMAN', reason: 'the gate itself', match: ({ path }) => path === 'gate.config.mjs' },
      { id: 'src', tier: 'GATED', reason: 'library code: covered by test', match: ({ path }) => path.startsWith('src/') },
      { id: 'tests', tier: 'MACHINE', reason: 'tests', match: ({ path }) => path.startsWith('test/') },
      { id: 'docs', tier: 'MACHINE', reason: 'docs and tickets', match: ({ path }) => path.endsWith('.md') },
    ],
    // Rule ids (or globs) whose lines do not count toward the diff size warning.
    sizeExcluded: ['tests', 'docs'],
  },

  // The Definition of Done the Stop hook guards. A ticked line is attributed to the `## <ID>` heading above it.
  dod: {
    files: ['tickets/phase-*.md'],
    contract: 'tickets/{id}.md',
  },

  // Branches an agent may never push to (this is also the default).
  pushGuard: { protected: ['main', 'master'] },
});
