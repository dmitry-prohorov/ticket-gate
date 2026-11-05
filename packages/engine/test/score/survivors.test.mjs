import assert from 'node:assert/strict';
import { test } from 'node:test';

import { A, at, fixtureFile, mut } from './__tests__/survivors.helpers.mjs';
import { renderSurvivors } from './__tests__/demo.mjs';
import { reportFiles, repoKey } from '../../score/survivors.mjs';

test('MS-MD renderSurvivors lists survivors with their tests and omits killed ones', () => {
  const report = {
    files: {
      'src/domain/a.ts': fixtureFile(
        [
          mut('Survived', {
            id: '1',
            location: at(3, 7, 12),
            coveredBy: ['t1'],
          }),
          mut('NoCoverage', {
            id: '2',
            mutatorName: 'StringLiteral',
            replacement: '""',
            location: at(2, 1, 2),
          }),
          mut('Killed', { id: '3', mutatorName: 'ArithmeticOperator' }),
        ],
        'x\ny\n      a > b;\n',
      ),
    },
    testFiles: {
      'src/domain/a.test.ts': { tests: [{ id: 't1', name: 'keeps order' }] },
    },
  };
  const md = renderSurvivors({
    base: '0123456789abcdef',
    verdicts: [
      {
        path: A,
        isNew: false,
        score: 60,
        baseScore: 70,
        reasons: ['score 60.00 dropped below base 70'],
        changed: new Set([3]),
        survivorsOnChanged: 1,
      },
    ],
    report,
    newDisables: [
      {
        path: A,
        line: 4,
        text: ' // Stryker disable next-line all: equivalent',
      },
    ],
  });
  const lines = md.split('\n');
  assert.equal(lines[0], '# Mutation survivors (base 0123456)');
  for (const want of [
    '- `a.ts:3:7/ConditionalExpression` Survived [changed]',
    '  - original: `a > b`',
    '  - mutated: `true`',
    '  - covered by: `src/domain/a.test.ts > keeps order`',
    '- `a.ts:2:1/StringLiteral` NoCoverage',
    '  - covered by: none (no coverage)',
    `- \`${A}:4\` // Stryker disable next-line all: equivalent`,
  ])
    assert.ok(lines.includes(want), `${want}\n---\n${md}`);
  assert.ok(!md.includes('ArithmeticOperator'));
  assert.ok(md.includes(`## ${A}  score 60 (base 70)`));
});

test('SC-9 packageDir "." matches root-relative report paths to root-relative changed files', () => {
  assert.equal(repoKey('src/classes/A.cls', '.'), 'src/classes/A.cls');
  assert.deepEqual(
    Object.keys(reportFiles({ files: { 'src/classes/A.cls': {} } }, '.')),
    ['src/classes/A.cls'],
  );
  assert.equal(repoKey('src/a.ts', 'packages/core'), 'packages/core/src/a.ts');
});
