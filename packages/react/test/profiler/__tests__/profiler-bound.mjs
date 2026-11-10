// The profiler bound to the values the ported cases pin (scenario ids, ports, flags).
// The cases are written against these values; the synthetic project shares none of them.
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { profiler } from '../../../profiler/cli.mjs';

const noop = async () => {};
const scenarios = Object.fromEntries(
  ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'].map((id) => [id, noop]),
);

const config = Object.freeze({
  root: tmpdir(),
  command: 'demo profile',
  lock: false,
  scenarios,
  writing: [],
  componentsFor: (s) =>
    s === 'W4' || s === 'W5'
      ? ['RoutineChip', 'RoutineFrame']
      : ['GridChip', 'DayColumn', 'EventChip'],
  usage: { maxRenders: 'W4:<n>' },
  out: join(tmpdir(), 'profile-bound'),
  tracePrefix: 'web-',
  context: {},
  open: noop,
  reset: noop,
  playwrightFrom: join(tmpdir(), 'package.json'),
  appUrl: 'http://localhost:3000',
  build: {
    command: 'next build --profile --no-mangling',
    unmangle: '--no-mangling',
    start: '',
    port: 3000,
    noBuildLabel: 'x',
  },
  messages: { expected: 'GridChip' },
  preflight: {
    portInUse: ':3000 already answers: stop that server, or drop --build.',
    noApp: 'nothing answers on :3000: run with --build.',
    noSupabase: 'nothing answers on :54321: run pnpm supabase start',
    noMailpit: 'nothing answers on :54324: run pnpm supabase start',
    noWebEnv: 'no web env: create .env.local',
  },
  services: [
    {
      url: 'http://127.0.0.1:54321/auth/v1/health',
      problem: 'nothing answers on :54321: run pnpm supabase start',
    },
    {
      url: 'http://127.0.0.1:54324/livez',
      problem: 'nothing answers on :54324: run pnpm supabase start',
    },
  ],
  probe: async () => true,
  hasEnv: () => true,
});

export default config;

export const {
  PROBLEM,
  PREFLIGHT,
  SETUP_MISSING,
  analyse,
  traceProblem,
  reduceRun,
  median,
  compare,
  setupDiff,
  parseBudgets,
  parseArgs,
  budgetFailures,
  applyBudget,
  scenarioRenders,
  preflight,
  run,
} = profiler(config);
