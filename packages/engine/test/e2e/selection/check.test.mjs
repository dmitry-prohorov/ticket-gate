// C-1..C-6. Run by `pnpm test:tools`. Mini repos under os.tmpdir();
// expected problem codes come from the contract.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { DEMO, checkE2eAreas } from '../__tests__/bound.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const E2E = 'apps/web/e2e';
const APP = 'apps/web/app';

function repo(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-e2e-areas-'));
  dirs.push(dir);
  const files = {
    [`${E2E}/calendar.spec.ts`]: `// e2e-areas: calendar\nimport { test } from './fixtures/seed-copy';\n`,
    [`${E2E}/editor.spec.ts`]: `// e2e-areas: editor, detail\n`,
    [`${APP}/layout.tsx`]: 'x\n',
    [`${APP}/page.tsx`]: 'x\n',
    [`${APP}/(app)/calendar/page.tsx`]: 'x\n',
    [`${APP}/(app)/event/[id]/page.tsx`]: 'x\n',
    [`${APP}/tg/page.tsx`]: 'x\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const has = (problems, code, needle) =>
  problems.some((p) => p.startsWith(`${code} `) && p.includes(needle));

test('C-1 a spec without a header line fails missing-header', () => {
  const dir = repo({
    [`${E2E}/nohdr.spec.ts`]: `import { test } from './fixtures/seed-copy';\n`,
    [`${E2E}/late.spec.ts`]: `\n// e2e-areas: calendar\n`,
    [`${E2E}/sloppy.spec.ts`]: `// e2e-areas:calendar\n`,
  });
  const problems = checkE2eAreas(dir);
  assert.ok(
    has(problems, 'missing-header', 'nohdr.spec.ts'),
    problems.join('\n'),
  );
  assert.ok(
    has(problems, 'missing-header', 'late.spec.ts'),
    'header must be line 1',
  );
  assert.ok(has(problems, 'missing-header', 'sloppy.spec.ts'), 'exact format');
  assert.ok(!has(problems, 'missing-header', 'calendar.spec.ts'));
});

test('C-2 an unknown area id fails unknown-area', () => {
  const dir = repo({
    [`${E2E}/odd.spec.ts`]: `// e2e-areas: calendar, bogus\n`,
  });
  const problems = checkE2eAreas(dir);
  assert.ok(
    has(problems, 'unknown-area', 'odd.spec.ts bogus'),
    problems.join('\n'),
  );
  assert.ok(
    !problems.some(
      (p) => p.includes('unknown-area') && p.includes('calendar.spec'),
    ),
  );
  assert.ok(
    !problems.some(
      (p) => p.startsWith('unknown-area') && p.endsWith(' calendar'),
    ),
  );
});

test('C-3 a page.tsx under an unmapped app root fails orphan-route', () => {
  const dir = repo({
    [`${APP}/zzz-new/page.tsx`]: 'x\n',
  });
  const problems = checkE2eAreas(dir);
  assert.ok(
    has(problems, 'orphan-route', 'zzz-new/page.tsx'),
    problems.join('\n'),
  );
  assert.ok(
    !problems.some(
      (p) => p.startsWith('orphan-route') && p.includes('tg/page.tsx'),
    ),
  );
  assert.ok(
    !problems.some(
      (p) => p.startsWith('orphan-route') && p.includes('calendar/page.tsx'),
    ),
  );
});

test('C-4 a new tk999- or tk9-99- spec fails ticket-named; a grandfathered name passes', () => {
  // Any entry: the set shrinks as grandfathered specs are renamed.
  const [grandfathered] = DEMO.specs.grandfathered;
  const dir = repo({
    [`${E2E}/tk999-thing.spec.ts`]: `// e2e-areas: calendar\n`,
    [`${E2E}/tk9-99-thing.spec.ts`]: `// e2e-areas: calendar\n`,
    [`${E2E}/${grandfathered}`]: `// e2e-areas: timetable\n`,
  });
  const problems = checkE2eAreas(dir);
  assert.ok(
    has(problems, 'ticket-named', 'tk999-thing.spec.ts'),
    problems.join('\n'),
  );
  assert.ok(has(problems, 'ticket-named', 'tk9-99-thing.spec.ts'));
  assert.ok(!problems.some((p) => p.includes(grandfathered)));
});

test('C-5 thirteen @smoke tags fail smoke-cap', () => {
  const tests = (n) =>
    Array.from(
      { length: n },
      (_, i) => `test('t${i}', { tag: '@smoke' }, async () => {});\n`,
    ).join('');
  const twelve = checkE2eAreas(
    repo({
      [`${E2E}/smoke.spec.ts`]: `// e2e-areas: calendar\n${tests(12)}`,
    }),
  );
  assert.deepEqual(twelve, [], '12 is the cap, not over it');
  const thirteen = checkE2eAreas(
    repo({
      [`${E2E}/smoke.spec.ts`]: `// e2e-areas: calendar\n${tests(7)}`,
      [`${E2E}/smoke2.spec.ts`]: `// e2e-areas: calendar\n${tests(6)}`,
    }),
  );
  assert.ok(thirteen.includes('smoke-cap 13'), thirteen.join('\n'));
});

test('C-6 a clean mini repo has no problems', () => {
  assert.deepEqual(checkE2eAreas(repo()), []);
});
