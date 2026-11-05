import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  A,
  at,
  many,
  mut,
  on,
  verdict,
} from './__tests__/survivors.helpers.mjs';
import {
  baseToHeadLines,
  judge,
  needsForcedRerun,
  regressedMutants,
  scoreFile,
  summaryLine,
  warnings,
} from './__tests__/demo.mjs';

test('MS-S1 scoreFile counts timeouts as killed and ignores ignored and error mutants', () => {
  const r = scoreFile([
    ...many('Killed', 7),
    ...many('Timeout', 1),
    ...many('Survived', 1),
    ...many('NoCoverage', 1),
    ...many('Ignored', 5),
    ...many('CompileError', 2),
    ...many('RuntimeError', 1),
  ]);
  assert.equal(r.valid, 10);
  assert.equal(r.score, 80);
});

test('MS-S2 scoreFile of no valid mutants is 100', () => {
  assert.equal(scoreFile([]).score, 100);
  assert.equal(scoreFile(many('Ignored', 3)).score, 100);
});

test('MS-R1 a new file below 80 fails, 80 passes', () => {
  const low = judge(verdict({ isNew: true, score: 79.99 }));
  assert.equal(low.length, 1);
  assert.match(low[0], /new file score 79.99 < 80/);
  assert.deepEqual(judge(verdict({ isNew: true, score: 80 })), []);
});

test('MS-R2 an existing file below its base score with no regressed mutant is a warning, not a failure', () => {
  assert.deepEqual(judge(verdict({ baseScore: 85, score: 84.99 })), []);
  const w = warnings(verdict({ baseScore: 85, score: 84.99 }));
  assert.equal(w.length, 1);
  assert.match(w[0], /dropped below base 85/);
  // A regressed mutant is a failure (MS-R5), so the drop is not also a warning.
  assert.deepEqual(
    warnings(
      verdict({ baseScore: 85, score: 84.99, regressed: [mut('Survived')] }),
    ),
    [],
  );
  assert.deepEqual(warnings(verdict({ baseScore: 85, score: 85 })), []);
  assert.deepEqual(warnings(verdict({ baseScore: 85, score: 90 })), []);
  assert.deepEqual(
    warnings(verdict({ isNew: true, baseScore: 100, score: 90 })),
    [],
  );
});

test('MS-R2b an existing file fails on a surviving mutant on a changed line, whatever its score', () => {
  const r = judge(verdict({ survivedOnChanged: 2, score: 99, baseScore: 50 }));
  assert.equal(r.length, 1);
  assert.match(r[0], /2 surviving mutant\(s\) on changed lines/);
  assert.deepEqual(judge(verdict({ survivedOnChanged: 0 })), []);
  assert.deepEqual(judge(verdict({ isNew: true, survivedOnChanged: 4 })), []);
});

test('MS-R3 an existing file fails on a no-coverage mutant on a changed line', () => {
  const r = judge(verdict({ noCoverageOnChanged: 1 }));
  assert.equal(r.length, 1);
  assert.match(r[0], /1 no-coverage mutant\(s\) on changed lines/);
  assert.deepEqual(judge(verdict({ noCoverageOnChanged: 0 })), []);
});

test('MS-R4 a new file is judged only by the 80 floor, never against base', () => {
  assert.deepEqual(
    judge(
      verdict({
        isNew: true,
        score: 90,
        baseScore: 95,
        noCoverageOnChanged: 3,
      }),
    ),
    [],
  );
});

test('MS-R5 an existing file fails on a mutant the base killed that now survives on an unchanged line', () => {
  const r = judge(verdict({ regressed: [mut('Survived'), mut('NoCoverage')] }));
  assert.equal(r.length, 1);
  assert.match(
    r[0],
    /2 mutant\(s\) killed on base now survive on unchanged lines/,
  );
  assert.deepEqual(judge(verdict({ regressed: [] })), []);
  assert.deepEqual(
    judge(verdict({ isNew: true, score: 90, regressed: [mut('Survived')] })),
    [],
  );
});

test('MS-RG regressedMutants matches a base-killed mutant across a line shift', () => {
  // two lines inserted at the top: base line 5 is head line 7.
  const diff = '@@ -0,0 +1,2 @@\n';
  const head = on('Survived', 7);
  const r = regressedMutants([on('Killed', 5)], [head], baseToHeadLines(diff));
  assert.deepEqual(r, [head]);
  // Timeout counts as killed on base; NoCoverage counts as open on head.
  assert.equal(
    regressedMutants(
      [on('Timeout', 5)],
      [on('NoCoverage', 7)],
      baseToHeadLines(diff),
    ).length,
    1,
  );
});

test('MS-RG2 regressedMutants ignores changed lines, base-open mutants, other mutators and unmatched lines', () => {
  const diff = '@@ -3 +3 @@\n';
  const toHead = baseToHeadLines(diff);
  const none = (base, head) =>
    assert.deepEqual(regressedMutants(base, head, toHead), []);
  none([on('Killed', 3)], [on('Survived', 3)]); // changed line: judged by MS-R2b
  none([on('Survived', 1)], [on('Survived', 1)]); // already open on base
  none([on('Killed', 1)], [on('Killed', 1)]); // still killed
  none([on('Killed', 1)], [on('Survived', 1, { replacement: 'false' })]);
  none([on('Killed', 1)], [on('Survived', 1, { mutatorName: 'Other' })]);
  none([on('Killed', 2)], [on('Survived', 1)]);
  // per key: base 2 killed + 1 open, head 2 open -> 1 regressed
  const head = [on('Survived', 1), on('Survived', 1)];
  assert.equal(
    regressedMutants(
      [on('Killed', 1), on('Killed', 1), on('Survived', 1)],
      head,
      toHead,
    ).length,
    1,
  );
});

test('MS-RG3 a regressed mutant is confirmed by a forced rerun only when this run ran Stryker', () => {
  const v = [
    verdict({ regressed: [mut('Survived')] }),
    verdict({ regressed: [] }),
  ];
  assert.equal(needsForcedRerun(v, true), true);
  assert.equal(needsForcedRerun(v, false), false);
  assert.equal(needsForcedRerun([verdict({ regressed: [] })], true), false);
});

test('MS-SUM summaryLine matches the verify:ticket pattern', () => {
  assert.equal(
    summaryLine([
      { score: 80.9, survivorsOnChanged: 1 },
      { score: 98.1, survivorsOnChanged: 2 },
    ]),
    'mutation: 2 files, score 80.9..98.1, 3 survivors on changed lines',
  );
  assert.equal(
    summaryLine([{ score: 90, survivorsOnChanged: 0, regressed: [1, 2] }]),
    'mutation: 1 files, score 90.0..90.0, 0 survivors on changed lines, 2 regressed on unchanged lines',
  );
});
