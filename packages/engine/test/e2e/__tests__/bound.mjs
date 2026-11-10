// The engine entries with the demo selection as their default config. Not a test file.
import { buildGraph as buildGraphOf } from '../../../graph/js.mjs';
import {
  shadowOf as shadowOfWith,
  testListLines,
} from '../../../runners/playwright.mjs';
import { checkE2eAreas as checkE2eAreasWith } from '../../../selection/check.mjs';
import { forFiles as forFilesWith } from '../../../selection/for.mjs';
import {
  select as selectWith,
  specHeaders as specHeadersWith,
} from '../../../selection/select.mjs';
import { DEMO } from './demo-selection.mjs';

export { DEMO, testListLines };

export const select = (options) =>
  selectWith({ ...options, config: options.config ?? DEMO });
export const forFiles = (options) =>
  forFilesWith({ ...options, config: options.config ?? DEMO });
export const buildGraph = (root, cfg = DEMO) => buildGraphOf(root, cfg);
export const specHeaders = (root, cfg = DEMO) => specHeadersWith(root, cfg);
export const checkE2eAreas = (root, cfg = DEMO) => checkE2eAreasWith(root, cfg);
export const shadowOf = (selection, report, cfg = DEMO) =>
  shadowOfWith(selection, report, cfg);
