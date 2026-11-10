// E-L1..E-L3: load-time code that every shell page evaluates, and the shell-edge rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WEB,
  CORE,
  mini,
  sel,
  SHELL,
  overlayRepo,
} from '../__tests__/select-repo.mjs';

const HOOK_B = `${CORE}/client/hooks/useB.ts`;
const hookB = (init, body = 'return 2;') =>
  `const LIMIT = ${init};\nexport function useB() { ${body} }\n`;
const readFrom = (map) => (p) => map[p] ?? null;

test('E-L1 a changed load-time statement in a core module behind a barrel gives full; an inert body edit does not', () => {
  const dir = mini({
    [`${WEB}/app/(app)/layout.tsx`]: `import { useA } from '@demo/core';\nexport default function L() { return useA(); }\n`,
    [HOOK_B]: hookB('compute(4)'),
  });
  const readBase = readFrom({ [HOOK_B]: hookB('compute(3)') });
  const r = sel(dir, [HOOK_B], { readBase });
  assert.equal(r.mode, 'full');
  assert.equal(r.why, `${HOOK_B}: load-time`);

  const bodyDir = mini({
    [`${WEB}/app/(app)/layout.tsx`]: `import { useA } from '@demo/core';\nexport default function L() { return useA(); }\n`,
    [HOOK_B]: hookB('compute(3)', 'return 3;'),
  });
  const body = sel(bodyDir, [HOOK_B], {
    readBase: readFrom({ [HOOK_B]: hookB('compute(3)') }),
  });
  assert.equal(body.mode, 'affected');
  assert.deepEqual(body.areas, ['timetable']);

  const commentDir = mini({
    [`${WEB}/app/(app)/layout.tsx`]: `import { useA } from '@demo/core';\nexport default function L() { return useA(); }\n`,
    [HOOK_B]: hookB('compute(/* why */ 3)'),
  });
  const comment = sel(commentDir, [HOOK_B], {
    readBase: readFrom({ [HOOK_B]: hookB('compute(3)') }),
  });
  assert.equal(comment.mode, 'affected');
  assert.deepEqual(comment.areas, ['timetable']);

  const noBase = sel(dir, [HOOK_B]);
  assert.equal(noBase.mode, 'affected');
  assert.deepEqual(noBase.areas, ['timetable']);

  const useA = `${CORE}/client/hooks/useA.ts`;
  const shell = sel(dir, [useA], { readBase: readFrom({}) });
  assert.equal(shell.mode, 'full');
  assert.equal(shell.why, `${useA}: shell`);
});

const METRICS = `${WEB}/components/calendar/metrics.ts`;
const metrics = (n, body = 'return n;') =>
  `export const BAND = band(${n});\nexport function band(n) { ${body} }\n`;
const slotWith = (extra = '') =>
  `${extra}import { BAND } from './metrics';\nexport const Slot = BAND;\n`;

test('E-L2 the SHELL_EDGE_AREAS edges still evaluate: load-time code under an overlay gives full, an inert edit stays on its area', () => {
  const dir = overlayRepo(undefined, {
    [`${WEB}/components/calendar/Slot.tsx`]: slotWith(),
    [METRICS]: metrics(2),
  });
  const body = sel(dir, [METRICS], {
    readBase: readFrom({ [METRICS]: metrics(2, 'return n + 1;') }),
  });
  assert.equal(body.mode, 'affected');
  assert.deepEqual(body.areas, ['calendar']);
  const init = sel(dir, [METRICS], {
    readBase: readFrom({ [METRICS]: metrics(1) }),
  });
  assert.equal(init.mode, 'full');
  assert.equal(init.why, `${METRICS}: load-time`);
});

const SLOT = `${WEB}/components/calendar/Slot.tsx`;
const HEAVY = `${WEB}/components/calendar/heavy.ts`;
const ROW = `${WEB}/components/timetable/Row.tsx`;
const HEAVY_SRC = `export const H = make();\n`;

test('E-L3 an added import that newly evaluates load-time code gives full; type imports and already-evaluated targets do not', () => {
  const base = { [SLOT]: `export function Slot() { return 1; }\n` };
  const dir = overlayRepo(undefined, {
    [SLOT]: `import { H } from './heavy';\nexport function Slot() { return H; }\n`,
    [HEAVY]: HEAVY_SRC,
  });
  const added = sel(dir, [SLOT], { readBase: readFrom(base) });
  assert.equal(added.mode, 'full');
  assert.equal(added.why, `${SLOT}: load-time`);

  const typed = overlayRepo(undefined, {
    [SLOT]: `import type { H } from './heavy';\nexport function Slot(): typeof H { return 1; }\n`,
    [HEAVY]: HEAVY_SRC,
  });
  const t = sel(typed, [SLOT], { readBase: readFrom(base) });
  assert.equal(t.mode, 'affected');
  assert.deepEqual(t.areas, ['calendar']);

  const already = overlayRepo(undefined, {
    [SLOT]: `import { BAND } from './metrics';\nexport function Slot() { return BAND; }\n`,
    [METRICS]: metrics(1),
    [`${WEB}/components/ui/Ui.tsx`]: `import { BAND } from '@/components/calendar/metrics';\nexport const Ui = 1;\nexport function use() { return BAND; }\n`,
  });
  const a = sel(already, [SLOT], {
    readBase: readFrom({ [SLOT]: `export function Slot() { return 1; }\n` }),
  });
  assert.equal(a.mode, 'affected');
  assert.deepEqual(a.areas, ['calendar']);

  const two = overlayRepo(undefined, {
    [SLOT]: `import { H } from './heavy';\nexport function Slot() { return H; }\n`,
    [ROW]: `import { H } from '@/components/calendar/heavy';\nexport function Row() { return H; }\n`,
    [HEAVY]: HEAVY_SRC,
  });
  const both = sel(two, [SLOT, ROW], {
    readBase: readFrom({
      [SLOT]: base[SLOT],
      [ROW]: `export function Row() { return 1; }\n`,
    }),
  });
  assert.equal(both.mode, 'full');
  assert.match(both.why, /: load-time$/);

  const reorder = overlayRepo(undefined, {
    [SLOT]: slotWith(),
    [METRICS]: `export function band(n) { return n; }\nexport const BAND = band(1);\n`,
  });
  const re = sel(reorder, [METRICS], {
    readBase: readFrom({
      [METRICS]: `export const BAND = band(1);\nexport function band(n) { return n; }\n`,
    }),
  });
  assert.equal(re.mode, 'full');
  assert.equal(re.why, `${METRICS}: load-time`);
});
