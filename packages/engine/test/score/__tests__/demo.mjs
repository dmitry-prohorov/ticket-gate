// The demo score config the ported score tests run against, and the binding they import: the
// engine functions with the demo config applied, plus the names re-exported as they are.
import { defineGate } from '../../../config.mjs';
import { stryker } from '../../../score/adapters/stryker.mjs';
import {
  ensureBaseInstall as engineEnsure,
  installWith,
} from '../../../score/base.mjs';
import { judge as engineJudge } from '../../../score/judge.mjs';
import { mutationTargets as engineTargets } from '../../../score/targets.mjs';
import {
  renderSurvivors as engineRender,
  repoKey as engineRepoKey,
  reportFiles as engineReportFiles,
} from '../../../score/survivors.mjs';

export { baseToHeadLines, parseChangedLines } from '../../../score/lines.mjs';
export {
  needsForcedRerun,
  regressedMutants,
  scoreFile,
  summaryLine,
  warnings,
} from '../../../score/judge.mjs';
export { disablesWithoutReason } from '../../../score/adapters/stryker.mjs';
export { testedModule } from '../../../score/targets.mjs';

/** Written only after a successful install, so an interrupted install is redone. */
export const INSTALL_MARKER = '.install-done';

export const DEMO_SCORE = {
  scope: /^packages\/core\/src\/domain\//,
  excluded: /(\.test\.ts|\.fixture\.ts|\/index\.ts|\/constants\.ts)$/,
  packageDir: 'packages/core',
  noTargets: 'no core logic file changed',
  handoff: 'give that file to the test writer',
  baseInstall: {
    cmd: 'true',
    args: [],
    label: 'install',
    hint: 'npm ci',
    marker: INSTALL_MARKER,
  },
  adapter: stryker({
    branchCmd: ['npx', 'stryker', 'run'],
    packageDir: 'packages/core',
    config: 'stryker.config.mjs',
    reportPath: '.turbo/mutation/report.json',
  }),
};

export const cfg = defineGate({ score: DEMO_SCORE }).score;

export const mutationTargets = (paths, exists) =>
  engineTargets(paths, exists, cfg);
export const judge = (v) => engineJudge(v, cfg);
export const repoKey = (key) => engineRepoKey(key, cfg.packageDir);
export const reportFiles = (report) =>
  engineReportFiles(report, cfg.packageDir);
export const renderSurvivors = (args) =>
  engineRender({ ...args, packageDir: cfg.packageDir });
export const ensureBaseInstall = (
  dir,
  sha,
  install = installWith(cfg.baseInstall),
) => engineEnsure(dir, sha, install, cfg);
