import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readReport } from '../../score/base.mjs';
import { schemaProblem } from '../../score/schema.mjs';

const loc = (line, column) => ({
  start: { line, column },
  end: { line, column: column + 1 },
});
const mutant = (over = {}) => ({
  id: '1',
  mutatorName: 'ConditionalExpression',
  replacement: 'true',
  status: 'Survived',
  location: loc(1, 1),
  ...over,
});
const report = (over = {}) => ({
  schemaVersion: '1.0',
  files: { 'src/a.ts': { source: 'x', mutants: [mutant()] } },
  testFiles: { 'src/a.test.ts': { tests: [{ id: 't', name: 'n' }] } },
  ...over,
});
const withMutant = (m) => report({ files: { 'src/a.ts': { mutants: [m] } } });

test('SG-1 schema versions 1, 1.0, 2.0.0 pass; a well-formed report has no problem', () => {
  for (const v of ['1', '1.0', '2.0.0', '2.3'])
    assert.equal(schemaProblem(report({ schemaVersion: v })), null, v);
  assert.equal(schemaProblem(report({ testFiles: undefined })), null);
});

test('SG-2 schemaVersion 3, 1.0.0.0, a number and a missing one are each named', () => {
  for (const v of ['3', '1.0.0.0', 1, undefined]) {
    const p = schemaProblem(report({ schemaVersion: v }));
    assert.match(p ?? '', /^schemaVersion .* is not a supported/, String(v));
  }
  assert.equal(schemaProblem([]), 'is not a JSON object');
});

test('SG-3 a status outside the schema enum is named with its path', () => {
  const p = schemaProblem(withMutant(mutant({ status: 'Killedd' })));
  assert.match(p, /^files\["src\/a\.ts"\]\.mutants\[0\]: status "Killedd"/);
});

test('SG-4 a location line or column that is missing, zero or fractional is named', () => {
  for (const location of [
    { start: { line: 1 }, end: { line: 1, column: 2 } },
    loc(0, 1),
    loc(1.5, 1),
    loc(1, 0),
  ])
    assert.match(
      schemaProblem(withMutant(mutant({ location }))),
      /location\.(start|end)\.(line|column) is not a positive integer/,
    );
});

test('SG-5 a file without a mutants array is named', () => {
  const p = schemaProblem(report({ files: { 'src/a.ts': { source: 'x' } } }));
  assert.equal(p, 'files["src/a.ts"].mutants is not an array');
  assert.equal(schemaProblem(report({ files: undefined })), 'files is missing');
});

test('SG-6 readReport throws the mutation: FAIL line for an unknown schemaVersion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'score-schema-'));
  try {
    const path = join(dir, 'r.json');
    writeFileSync(path, JSON.stringify(report({ schemaVersion: '3' })));
    assert.throws(
      () => readReport(path, 'branch'),
      /^GateError: mutation: FAIL branch report .+: schemaVersion "3"|mutation: FAIL branch report .+: schemaVersion "3"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
