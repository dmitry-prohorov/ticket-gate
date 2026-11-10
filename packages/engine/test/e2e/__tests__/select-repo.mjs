// Shared mini-repo builders for the e2e selection tests. Not a test file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';

import { select } from './bound.mjs';

export const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

export const WEB = 'apps/web';
export const CORE = 'packages/core/src';
export const EN = `${CORE}/i18n/en.ts`;

export const EN_BASE = `export const en = {
  common: { save: 'Save changes', cancel: 'Cancel' },
  cal: { title: 'Week overview' },
  family: { greet: 'Hello {name}, welcome back' },
};
`;

/** Mini repo: five areas, a two-barrel core hook, shell files, e2e helpers. */
export function mini(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-select-'));
  dirs.push(dir);
  const files = {
    [`${WEB}/app/layout.tsx`]: `import { Nav } from '@/components/shell/Nav';\nexport default function L() { return Nav; }\n`,
    [`${WEB}/app/(app)/layout.tsx`]: `import { Nav } from '@/components/shell/Nav';\nexport default function L() { return Nav; }\n`,
    [`${WEB}/components/shell/Nav.tsx`]: `export const Nav = 1;\n`,
    [`${WEB}/app/(app)/calendar/page.tsx`]: `import { useA } from '@demo/core';\nexport default function P() { return useA(); }\n`,
    [`${WEB}/app/(app)/timetable/page.tsx`]: `import { Grid } from '@/components/timetable/Grid';\nimport { useB } from '@demo/core';\nexport default function P() { return [Grid, useB()]; }\n`,
    [`${WEB}/components/timetable/Grid.tsx`]: `import { Cell } from './Cell';\nexport const Grid = Cell;\n`,
    [`${WEB}/components/timetable/Cell.tsx`]: `export const Cell = 1;\n`,
    [`${WEB}/app/tg/page.tsx`]: `export default function P() { return null; }\n`,
    [`${WEB}/lib/dead.ts`]: `export const dead = 1;\n`,
    [`${CORE}/index.ts`]: `export * from './client/hooks';\n`,
    [`${CORE}/client/hooks/index.ts`]: `export { useA } from './useA';\nexport { useB } from './useB';\n`,
    [`${CORE}/client/hooks/useA.ts`]: `export function useA() { return 1; }\n`,
    [`${CORE}/client/hooks/useB.ts`]: `export function useB() { return 2; }\n`,
    [`${CORE}/domain/unreached.ts`]: `export const unreached = 1;\n`,
    [EN]: EN_BASE,
    [`${WEB}/e2e/calendar.spec.ts`]: `// e2e-areas: calendar\nimport { week } from './helpers/week';\nawait page.getByText('Week overview');\n`,
    [`${WEB}/e2e/timetable.spec.ts`]: `// e2e-areas: timetable\nimport { other } from './helpers/other';\n// uses t('common.cancel')\n`,
    [`${WEB}/e2e/telegram.spec.ts`]: `// e2e-areas: telegram\n`,
    [`${WEB}/e2e/invite.spec.ts`]: `// e2e-areas: invite, telegram\n`,
    [`${WEB}/e2e/family.spec.ts`]: `// e2e-areas: family\nawait page.getByText('Hello Mila, welcome back');\n`,
    [`${WEB}/e2e/helpers/week.ts`]: `import { base } from './base';\nexport const week = base;\n`,
    [`${WEB}/e2e/helpers/base.ts`]: `export const base = 1;\n`,
    [`${WEB}/e2e/helpers/other.ts`]: `export const other = 1;\n`,
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

export const sel = (dir, changed, more = {}) =>
  select({ root: dir, changed, ...more });

// The landscape overlays AppShell renders only on landscapeRoute.
export const SHELL = `${WEB}/components/AppShell.tsx`;
export const shellSrc = (
  week,
) => `import { LandscapeWeek } from '@/components/calendar/LandscapeWeek';
import { LandscapeTimetable } from '@/components/timetable/LandscapeTimetable';
import { Ui } from '@/components/ui/Ui';
export function AppShell() {
  return (
    <div>
      {landscapeRoute ? (scroller ? <LandscapeTimetable /> : ${week}) : null}
      <Ui />
    </div>
  );
}
`;
export const overlayRepo = (
  shell = shellSrc('<LandscapeWeek />'),
  extra = {},
) =>
  mini({
    [SHELL]: shell,
    [`${WEB}/app/(app)/layout.tsx`]: `import { AppShell } from '@/components/AppShell';\nexport default function L() { return AppShell; }\n`,
    [`${WEB}/components/calendar/LandscapeWeek.tsx`]: `import { Slot } from './Slot';\nexport const LandscapeWeek = Slot;\n`,
    [`${WEB}/components/calendar/Slot.tsx`]: `export const Slot = 1;\n`,
    [`${WEB}/components/timetable/LandscapeTimetable.tsx`]: `import { Row } from './Row';\nexport const LandscapeTimetable = Row;\n`,
    [`${WEB}/components/timetable/Row.tsx`]: `export const Row = 1;\n`,
    [`${WEB}/components/ui/Ui.tsx`]: `export const Ui = 1;\n`,
    ...extra,
  });
