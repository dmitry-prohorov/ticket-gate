// A consumer-neutral stand-in for this repo's mutation config: the names the
// ported tests need (a project, two packages, an e2e report variable) without
// naming any real consumer. It mirrors the shape of config.mjs's setup.
import { resolveSetup } from '../../../mutations/kinds.mjs';

export const DEMO = {
  project: 'demo-project',
  core: '@demo/core',
  mobile: '@demo/mobile',
  dropEnv: 'DEMO_E2E_JSON',
  reuseEnv: 'DEMO_E2E_REUSE',
  serverEnv: { DEMO_E2E_FRESH: '1' },
};

export const demoRebuild = {
  files: 'packages/core/src/',
  unlessTest: /(?:-F|--filter)[ =]@demo\/core(?![\w-])|packages\/core/,
  cmd: 'pnpm -F @demo/core build',
  limitS: 300,
  io: 'buildCore',
  flag: 'coreDirty',
  drift: 'dist no longer matches src',
  note: '[rebuilds core]',
};

export const demoSetup = () => resolveSetup({ rebuild: [demoRebuild] });
