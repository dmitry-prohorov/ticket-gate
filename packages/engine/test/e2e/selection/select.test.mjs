// E-1..E-12. Run by `pnpm test:tools`. Each case builds a throwaway
// mini repo under os.tmpdir() (real path shapes) and calls the public surface
// of the selection engine. Expected values come from the contract, never from running the implementation.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  WEB,
  CORE,
  EN,
  EN_BASE,
  mini,
  sel,
} from '../__tests__/select-repo.mjs';

const SPECS_ALL = [
  'calendar.spec.ts',
  'family.spec.ts',
  'invite.spec.ts',
  'telegram.spec.ts',
  'timetable.spec.ts',
];

test('E-1 each full trigger gives full with rule trigger', () => {
  const dir = mini();
  const samples = [
    `${WEB}/app/globals.css`,
    `${WEB}/tailwind.config.ts`,
    `${WEB}/postcss.config.mjs`,
    `${WEB}/next.config.ts`,
    `${WEB}/proxy.ts`,
    `${WEB}/package.json`,
    `${WEB}/playwright.config.ts`,
    `${WEB}/public/x.svg`,
    `${WEB}/e2e/fixtures/postgrest.ts`,
    `${WEB}/e2e/sign-in.ts`,
    `${WEB}/e2e/inbucket.ts`,
    `${WEB}/e2e/seed-integrity.ts`,
    'tools/e2e-seed-copy.ts',
    'tools/e2e-select.mjs',
    'tools/e2e-areas.mjs',
    'supabase/migrations/0099_x.sql',
    'supabase/seed.sql',
    'supabase/config.toml',
    'supabase/schema/x.sql',
    'supabase/templates/x.html',
    'supabase/functions/deno.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'turbo.json',
    'tsconfig.json',
    '.npmrc',
    'packages/config/x.json',
    'packages/core/package.json',
    'packages/core/tsup.config.ts',
  ];
  for (const p of samples) {
    const r = sel(dir, [p]);
    assert.equal(r.mode, 'full', p);
    assert.equal(r.why, `${p}: trigger`, p);
    assert.deepEqual(r.specs, [], p);
    assert.deepEqual(r.areas, [], p);
  }
});

test('E-2 a components/timetable leaf selects timetable specs only', () => {
  const dir = mini();
  const r = sel(dir, [`${WEB}/components/timetable/Cell.tsx`]);
  assert.equal(r.mode, 'affected');
  assert.deepEqual(r.areas, ['timetable']);
  assert.deepEqual(r.specs, ['timetable.spec.ts']);
  assert.equal(r.why, 'affected: 1 areas, 1 specs');
});

test('E-3 app/(app)/layout.tsx and a component it imports give full with rule shell', () => {
  const dir = mini();
  for (const p of [
    `${WEB}/app/(app)/layout.tsx`,
    `${WEB}/app/layout.tsx`,
    `${WEB}/components/shell/Nav.tsx`,
  ]) {
    const r = sel(dir, [p]);
    assert.equal(r.mode, 'full', p);
    assert.equal(r.why, `${p}: shell`, p);
  }
});

test("E-4 a core hook re-exported through two barrels reaches only its consumers' areas", () => {
  const dir = mini();
  const a = sel(dir, [`${CORE}/client/hooks/useA.ts`]);
  assert.equal(a.mode, 'affected');
  assert.deepEqual(a.areas, ['calendar'], 'useA is imported by calendar only');
  assert.deepEqual(a.specs, ['calendar.spec.ts']);
  const b = sel(dir, [`${CORE}/client/hooks/useB.ts`]);
  assert.deepEqual(
    b.areas,
    ['timetable'],
    'useB is imported by timetable only',
  );
  assert.deepEqual(b.specs, ['timetable.spec.ts']);
});

test('E-5 an added i18n key selects nothing; a changed value selects the spec holding the old string; a removed key selects the spec naming the key', () => {
  const dir = mini();
  const withHead = (head) => {
    writeFileSync(join(dir, EN), head);
    return sel(dir, [EN], { readBase: (p) => (p === EN ? EN_BASE : null) });
  };

  const added = withHead(
    EN_BASE.replace(
      'cal: {',
      "extra: { brandNew: 'Totally new text' },\n  cal: {",
    ),
  );
  assert.equal(added.mode, 'affected', 'an added key is not a full trigger');
  assert.deepEqual(added.specs, []);
  assert.deepEqual(added.areas, []);

  const changed = withHead(EN_BASE.replace('Week overview', 'Weekly agenda'));
  assert.deepEqual(changed.specs, ['calendar.spec.ts']);

  const fragment = withHead(
    EN_BASE.replace('Hello {name}, welcome back', 'Hey {name}'),
  );
  assert.deepEqual(
    fragment.specs,
    ['family.spec.ts'],
    'placeholder-free fragment ", welcome back" (>= 8 chars) of the old value',
  );

  const removed = withHead(EN_BASE.replace(", cancel: 'Cancel'", ''));
  assert.deepEqual(
    removed.specs,
    ['timetable.spec.ts'],
    'the dotted key common.cancel appears in timetable.spec.ts',
  );
});

test('E-6 a changed e2e helper selects the specs importing it, transitively', () => {
  const dir = mini();
  const base = sel(dir, [`${WEB}/e2e/helpers/base.ts`]);
  assert.equal(base.mode, 'affected');
  assert.deepEqual(
    base.specs,
    ['calendar.spec.ts'],
    'base <- week <- calendar',
  );
  const other = sel(dir, [`${WEB}/e2e/helpers/other.ts`]);
  assert.deepEqual(other.specs, ['timetable.spec.ts']);
  const spec = sel(dir, [`${WEB}/e2e/family.spec.ts`]);
  assert.deepEqual(spec.specs, ['family.spec.ts'], 'a spec selects itself');
  const gone = sel(dir, [`${WEB}/e2e/gone.spec.ts`]);
  assert.equal(gone.mode, 'affected');
  assert.deepEqual(gone.specs, [], 'a deleted spec selects nothing');
});

test('E-7 supabase/functions/telegram selects telegram specs; supabase/functions/_shared gives full with rule function', () => {
  const dir = mini();
  const tg = sel(dir, ['supabase/functions/telegram/index.ts']);
  assert.equal(tg.mode, 'affected');
  assert.deepEqual(tg.areas, ['telegram']);
  assert.deepEqual(
    tg.specs,
    ['invite.spec.ts', 'telegram.spec.ts'],
    'every spec whose header holds telegram',
  );
  const shared = sel(dir, ['supabase/functions/_shared/x.ts']);
  assert.equal(shared.mode, 'full');
  assert.equal(shared.why, 'supabase/functions/_shared/x.ts: function');
  const other = sel(dir, ['supabase/functions/notify/index.ts']);
  assert.equal(other.why, 'supabase/functions/notify/index.ts: function');
});

test('E-8 an unknown apps/web path gives full with rule unknown; docs/x.md and apps/mobile/x.ts select nothing', () => {
  const dir = mini();
  const dead = sel(dir, [`${WEB}/lib/dead.ts`]);
  assert.equal(dead.mode, 'full');
  assert.equal(dead.why, `${WEB}/lib/dead.ts: unknown`);
  for (const p of [
    'docs/x.md',
    'apps/mobile/x.ts',
    'tools/other.mjs',
    '.claude/x.json',
  ]) {
    const r = sel(dir, [p]);
    assert.equal(r.mode, 'affected', p);
    assert.deepEqual(r.specs, [], p);
    assert.deepEqual(r.areas, [], p);
  }
});

test('E-9 a test file and an unreached packages/core file select nothing', () => {
  const dir = mini({
    [`${WEB}/components/timetable/Cell.test.tsx`]: 'x\n',
    [`${WEB}/e2e/sign-in.test.ts`]: 'x\n',
  });
  const r = sel(dir, [
    `${WEB}/components/timetable/Cell.test.tsx`,
    `${WEB}/e2e/sign-in.test.ts`,
    `${CORE}/domain/unreached.ts`,
  ]);
  assert.equal(r.mode, 'affected');
  assert.deepEqual(r.specs, []);
  assert.deepEqual(r.areas, []);
});

test("E-12 an amber nightly's flaky spec joins an affected selection", () => {
  const dir = mini();
  const changed = [`${WEB}/components/timetable/Cell.tsx`];
  const amber = sel(dir, changed, {
    nightly: { status: 'amber', flakySpecs: ['family.spec.ts'] },
  });
  assert.equal(amber.mode, 'affected');
  assert.deepEqual(amber.specs, ['family.spec.ts', 'timetable.spec.ts']);
  const green = sel(dir, changed, {
    nightly: { status: 'green', flakySpecs: ['family.spec.ts'] },
  });
  assert.deepEqual(green.specs, ['timetable.spec.ts']);
  const none = sel(dir, changed, { nightly: null });
  assert.deepEqual(none.specs, ['timetable.spec.ts']);
  assert.ok(SPECS_ALL.includes('family.spec.ts'));
});

test('E-13 a tools/ file on an import edge selects its importers; one playwright.config imports gives full with rule shell', () => {
  const dir = mini({
    [`${WEB}/e2e/calendar.spec.ts`]: `// e2e-areas: calendar\nimport { x } from '../../../tools/x.ts';\n`,
    [`${WEB}/playwright.config.ts`]: `import { lock } from '../../tools/lock.mjs';\nexport default lock;\n`,
    'tools/x.ts': `export const x = 1;\n`,
    'tools/lock.mjs': `export const lock = 1;\n`,
  });
  const helper = sel(dir, ['tools/x.ts']);
  assert.equal(helper.mode, 'affected');
  assert.deepEqual(helper.specs, ['calendar.spec.ts']);
  const lock = sel(dir, ['tools/lock.mjs']);
  assert.equal(lock.mode, 'full');
  assert.equal(lock.why, 'tools/lock.mjs: shell');
  assert.equal(sel(dir, ['tools/other.mjs']).specs.length, 0);
});
