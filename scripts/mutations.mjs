#!/usr/bin/env node
// This repo's mutation commands: the registry in mutation-registry/ proves that each guarded
// line in the engine and the pack is bitten by a test.
//
//   node scripts/mutations.mjs mutate <ID> | --registry (--ids=|--all|--changed) [flags]
//   node scripts/mutations.mjs mutations check [--fix]
//   node scripts/mutations.mjs mutations select [--affected --paths=]
//
// The repo has no gate.config.mjs of its own: the config below is written for the engine's
// import and built with the same defineGate the consumers use. Exit 0 done, 1 a guard survived
// or the registry is invalid, 2 usage or configuration.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The engine loads the project's gate config at import (its project module), and this repo
// ships none: a config in the tree would be a consumer's file (test/repo-shape.test.mjs). So
// the config is written to a private temp directory, the engine is pointed at it with
// TICKET_GATE_CONFIG_DIR, and the directory is removed once the import has finished. Nothing is
// written to the repo, so parallel runs do not collide and a killed run leaves the tree clean.
const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);
const configUrl = pathToFileURL(join(ROOT, 'packages/engine/config.mjs')).href;
const tmp = mkdtempSync(join(tmpdir(), 'ticket-gate-mutations-'));
let GATE;
try {
  writeFileSync(
    join(tmp, 'gate.config.mjs'),
    `import { defineGate } from ${JSON.stringify(configUrl)};
export default defineGate({
  mutations: { dir: 'mutation-registry' },
  commands: {
    mutate: 'npm run mutate --',
    checkMutations: 'npm run mutations:check',
    checkMutationsScript: 'npm run mutations:check',
  },
});
`,
  );
  process.env.TICKET_GATE_CONFIG_DIR = tmp;
  ({ GATE } = await import('../packages/engine/project.mjs'));
} finally {
  delete process.env.TICKET_GATE_CONFIG_DIR; // not for the test commands this process spawns
  rmSync(tmp, { recursive: true, force: true });
}
const { runMutationCommand } = await import('../packages/engine/mutations/gate.mjs');

const USAGE =
  'usage: node scripts/mutations.mjs mutate <ID> | --registry (--ids=|--all|--changed) | mutations check [--fix] | mutations select [--affected --paths=]';

const [first, ...rest] = process.argv.slice(2);
let cmd = first;
let args = rest;
if (first === 'mutations') {
  const [sub, ...more] = rest;
  if (sub !== 'check' && sub !== 'select') {
    console.error(`mutations takes check or select, got ${sub ?? '(nothing)'}\n${USAGE}`);
    process.exit(2);
  }
  cmd = `mutations ${sub}`;
  args = more;
} else if (first !== 'mutate') {
  console.error(USAGE);
  process.exit(2);
}

process.exitCode = await runMutationCommand(cmd, args, GATE);
