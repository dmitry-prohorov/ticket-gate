// Binds the assertions ratchet to the values the ported EA tests were written against.
import { assertions } from '../../../checks/assertions.mjs';
import { unguardedKind } from '../../../checks/assertions-unguarded.mjs';
import { bindSetup } from '../../../mutations/project.mjs';
import { resolveSetup } from '../../../mutations/kinds.mjs';

export const AREAS = [
  'auth',
  'onboarding',
  'invite',
  'calendar',
  'editor',
  'detail',
  'timetable',
  'family',
  'settings',
  'telegram',
  'legal',
];

const setup = bindSetup(
  resolveSetup({
    dir: 'tools/mutation-registry',
    kinds: {
      unguarded: unguardedKind({
        from: /^e2e\/.+\.spec\.ts$/,
        fromHint: 'e2e/<...>.spec.ts',
        prefix: 'apps/web/',
      }),
    },
  }),
);

export const { areaTotals, checkE2eAssertions, countSpecs } = assertions({
  name: 'check-e2e-assertions',
  specs: {
    dir: 'apps/web/e2e',
    match: /\.spec\.ts$/,
    header: /^\/\/ e2e-areas: ([a-z]+(, [a-z]+)*)$/,
  },
  areas: AREAS,
  counters: {
    expect: 'expect(',
    axe: 'expectNoSeriousAxe(',
    screenshot: 'toHaveScreenshot(',
  },
  from: 'e2e/',
  receipt: '.turbo/mutation-check.json',
  baseline: 'tools/e2e-assertions-baseline.json',
  registry: 'tools/mutation-registry/',
  comment:
    'Assertion ratchet baseline. Never edit by hand: run `pnpm check:e2e-assertions --update` (a drop needs a green mutation receipt that covers it; see tools/check-e2e-assertions.mjs).',
  commands: {
    update: 'pnpm check:e2e-assertions --update',
    mutate: 'pnpm mutate:check <ID>',
    usage: 'pnpm check:e2e-assertions',
  },
  setup,
});
