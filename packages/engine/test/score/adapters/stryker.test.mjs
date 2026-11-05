import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { disablesWithoutReason } from '../__tests__/demo.mjs';
import { stryker } from '../../../score/adapters/stryker.mjs';

test('MS-D1 a Stryker disable needs a stated reason', () => {
  const bad = [
    '// Stryker disable next-line all',
    '// Stryker disable next-line StringLiteral:',
    '// Stryker disable all',
  ];
  for (const l of bad)
    assert.deepEqual(disablesWithoutReason(l), [{ line: 1 }], l);
  const ok = [
    '// Stryker disable next-line ConditionalExpression: equivalent, re-checked in parse',
    '// Stryker disable all: generated table',
    '// Stryker restore all',
    'const x = 1;',
  ];
  for (const l of ok) assert.deepEqual(disablesWithoutReason(l), [], l);
  assert.deepEqual(disablesWithoutReason(`a\n${bad[0]}`), [{ line: 2 }]);
});

test("packageDir '.' passes root-relative --mutate paths", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'stryker-rel-'));
  const out = join(tmp, 'argv.json');
  const recorder =
    'require("fs").writeFileSync(process.env.REC,JSON.stringify(process.argv.slice(1)))';
  process.env.REC = out;
  const mutateArg = () => {
    const argv = JSON.parse(readFileSync(out, 'utf8'));
    return argv[argv.indexOf('--mutate') + 1];
  };
  const adapter = stryker({
    branchCmd: [process.execPath, '-e', recorder, '--'],
    packageDir: '.',
    config: 'stryker.conf.json',
    reportPath: 'report.json',
  });
  adapter.runBranch({ root: tmp, files: ['src/a.ts'] });
  assert.equal(mutateArg(), 'src/a.ts');

  const bin = join(tmp, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'stryker');
  writeFileSync(script, `#!${process.execPath}\n${recorder}\n`);
  chmodSync(script, 0o755);
  adapter.runBase({ root: tmp, dir: tmp, files: ['src/a.ts'] });
  assert.equal(mutateArg(), 'src/a.ts');
});
