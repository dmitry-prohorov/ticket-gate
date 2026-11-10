// F-1..F-3: the --for report.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { forLines, removedLocators, testCounts } from '../../../selection/for.mjs';
import { forFiles, select } from '../__tests__/bound.mjs';
import { WEB, EN, EN_BASE, mini } from '../__tests__/select-repo.mjs';

// ---------------------------------------------------------------- --for

const CHIP = `${WEB}/components/shared/Chip.tsx`;
const BADGE = `${WEB}/components/calendar/Badge.tsx`;
const NAV = `${WEB}/components/shell/Nav.tsx`;

const BADGE_BASE = `export const Badge = () => (
  <div role="tab" aria-label="Close panel" data-testid="fam-row" data-slot="family-check">
    {t('cal.title')}
  </div>
);
`;
const BADGE_HEAD = `export const Badge = () => <div />;\n`;

/** Chip is reached by calendar and timetable; both.spec.ts declares both areas. */
const BOTH = {
  [`${WEB}/e2e/both.spec.ts`]: `// e2e-areas: calendar, timetable\n`,
};

function chipMini(extra = {}) {
  return mini({
    [`${WEB}/app/(app)/calendar/page.tsx`]: `import { useA } from '@demo/core';\nimport { Chip } from '@/components/shared/Chip';\nimport { Badge } from '@/components/calendar/Badge';\nexport default function P() { return [useA(), Chip, Badge]; }\n`,
    [`${WEB}/app/(app)/timetable/page.tsx`]: `import { Grid } from '@/components/timetable/Grid';\nimport { Chip } from '@/components/shared/Chip';\nimport { useB } from '@demo/core';\nexport default function P() { return [Grid, Chip, useB()]; }\n`,
    [CHIP]: `export const Chip = 1;\n`,
    [BADGE]: BADGE_HEAD,
    ...extra,
  });
}

function forMini() {
  return chipMini({
    [`${WEB}/e2e/role.spec.ts`]: `// e2e-areas: calendar\nawait page.getByRole('tab');\n`,
    [`${WEB}/e2e/label.spec.ts`]: `// e2e-areas: calendar\nawait page.getByLabel('Close panel');\n`,
    [`${WEB}/e2e/testid.spec.ts`]: `// e2e-areas: calendar\nawait page.getByTestId('fam-row');\n`,
    [`${WEB}/e2e/slot.spec.ts`]: `// e2e-areas: calendar\nimport { slot } from './helpers/slot';\n`,
    [`${WEB}/e2e/helpers/slot.ts`]: `export const slot = '[data-slot="family-check"]';\n`,
    [`${WEB}/e2e/none.spec.ts`]: `// e2e-areas: calendar\n`,
  });
}

const baseOf = (map) => (p) => map[p] ?? null;

test("F-1 --for lists a leaf's areas smallest first with test counts; a shell file uses the gate; the gate's selection is unchanged", () => {
  const dir = chipMini(BOTH);
  const counts = new Map([
    ['both.spec.ts', 1],
    ['calendar.spec.ts', 5],
    ['timetable.spec.ts', 2],
  ]);
  const changed = [CHIP, NAV];
  const before = select({ root: dir, changed });
  const r = forFiles({ root: dir, files: [CHIP, NAV], counts, budget: 150 });
  assert.deepEqual(r.gated, [{ file: NAV, rule: 'shell' }]);
  assert.deepEqual(
    r.groups.map((g) => [g.area, g.tests, g.specs]),
    [
      [
        'timetable',
        3,
        [
          { spec: 'both.spec.ts', tests: 1 },
          { spec: 'timetable.spec.ts', tests: 2 },
        ],
      ],
      ['calendar', 6, [{ spec: 'calendar.spec.ts', tests: 5 }]],
    ],
  );
  assert.equal(r.total, 8);
  assert.equal(r.filtered, null);
  assert.deepEqual(r.specs, [
    'both.spec.ts',
    'calendar.spec.ts',
    'timetable.spec.ts',
  ]);
  const lines = forLines(r, 150);
  assert.ok(lines.includes(`${NAV}: shell: use the gate`));
  assert.ok(lines.includes(`${CHIP}: timetable, calendar`));
  assert.ok(
    lines.includes('for: 2 files, 2 areas, 3 specs, 8 tests (budget 150)'),
  );
  assert.deepEqual(select({ root: dir, changed }), before);
  assert.equal(existsSync(join(dir, '.turbo')), false);
  assert.ok(!readdirSync(dir).includes('.turbo'));
});

test('F-1b --for names the gated rule even when the unresolved importer is another file', () => {
  const BROKEN = `${WEB}/components/shared/ChipBrokenHelper.tsx`;
  const dir = chipMini({
    [CHIP]: `import { b } from './ChipBrokenHelper';\nexport const Chip = b;\n`,
    [BROKEN]: `import { m } from './does-not-exist';\nexport const b = m;\n`,
  });
  const r = forFiles({
    root: dir,
    files: [CHIP],
    counts: new Map(),
    budget: 150,
  });
  assert.deepEqual(r.gated, [{ file: CHIP, rule: 'unresolved' }]);
  assert.ok(forLines(r, 150).includes(`${CHIP}: unresolved: use the gate`));
});

test('F-2 over budget only specs holding a removed locator are listed with the filtered line, the locators and the limit; under budget no filter', () => {
  const dir = forMini();
  const readBase = baseOf({ [BADGE]: BADGE_BASE, [EN]: EN_BASE });
  const counts = new Map(
    readdirSync(join(dir, WEB, 'e2e'))
      .filter((f) => f.endsWith('.spec.ts'))
      .map((f) => [f, 1]),
  );
  const over = forFiles({
    root: dir,
    files: [BADGE],
    readBase,
    counts,
    budget: 3,
  });
  assert.deepEqual(over.filtered, {
    kept: 5,
    of: 6,
    locators: [
      'Close panel',
      'Week overview',
      'fam-row',
      'family-check',
      'tab',
    ],
  });
  assert.deepEqual(over.specs, [
    'calendar.spec.ts',
    'label.spec.ts',
    'role.spec.ts',
    'slot.spec.ts',
    'testid.spec.ts',
  ]);
  const lines = forLines(over, 3);
  const tail = lines.slice(-4);
  assert.deepEqual(tail.slice(0, 3), [
    'filtered: 5 of 6 specs by 5 removed locators',
    'locators: Close panel, Week overview, fam-row, family-check, tab',
    'limit: an implicit role change (a <button> becoming role="radio") is not a removed locator',
  ]);
  const under = forFiles({
    root: dir,
    files: [BADGE],
    readBase,
    counts,
    budget: 100,
  });
  assert.equal(under.filtered, null);
  assert.equal(under.specs.length, 6);
  assert.ok(!forLines(under, 100).some((l) => l.startsWith('limit:')));
  const en = new Map([['cal.title', 'Week overview']]);
  assert.deepEqual(
    removedLocators(
      '<button className="x">go</button>',
      '<div role="radio">go</div>',
      en,
    ),
    [],
  );
});

test('F-3 the printed command is a playwright test line or none', () => {
  const dir = chipMini(BOTH);
  const counts = new Map([
    ['both.spec.ts', 1],
    ['calendar.spec.ts', 1],
    ['timetable.spec.ts', 1],
  ]);
  const ok = forFiles({ root: dir, files: [CHIP], counts });
  const last = forLines(ok, 150).at(-1);
  assert.match(
    last,
    /^pnpm -F web exec playwright test( e2e\/[\w.-]+\.spec\.ts)+$/,
  );
  for (const p of last.split(' ').filter((x) => x.startsWith('e2e/')))
    assert.ok(existsSync(join(dir, WEB, p)), p);
  const shellOnly = forFiles({ root: dir, files: [NAV], counts });
  assert.equal(forLines(shellOnly, 150).at(-1), 'none');
  const zero = forFiles({
    root: dir,
    files: [CHIP],
    readBase: baseOf({ [CHIP]: 'export const Chip = 1;\n' }),
    counts,
    budget: 1,
  });
  assert.equal(forLines(zero, 1).at(-1), 'none');
  assert.deepEqual(zero.filtered, { kept: 0, of: 3, locators: [] });
  assert.equal(
    testCounts({
      suites: [
        { file: 'a.spec.ts', specs: [{ file: 'a.spec.ts', tests: [{}, {}] }] },
      ],
    }).get('a.spec.ts'),
    2,
  );
});
