// The project's gate config, loaded once from the project root. Top-level await: no module in
// gate.config.mjs's own static import graph (config.mjs, root.mjs, tree.mjs, the pack's index,
// units, steps and stack modules, the project tools the config imports) may import this file.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ROOT } from './root.mjs';

const load = (root) =>
  import(pathToFileURL(join(root, 'gate.config.mjs')).href);

// TICKET_GATE_CONFIG_DIR, when set, names the directory whose gate.config.mjs is loaded instead
// of the project root's (resolved against the working directory). ROOT itself is unchanged.
const CONFIG_DIR = process.env.TICKET_GATE_CONFIG_DIR
  ? resolve(process.cwd(), process.env.TICKET_GATE_CONFIG_DIR)
  : ROOT;

export { ROOT };
/** The config module's namespace: its default export and any extra named exports. */
export const CONFIG_EXPORTS = await load(CONFIG_DIR);
export const GATE = CONFIG_EXPORTS.default;
