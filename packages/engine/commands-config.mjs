// Validation of the two config keys that add commands to the engine CLI: packs' packCommands
// (a name -> function map each pack contributes) and docs (the pages `docs-stale` reads). Imports
// the collection half of the pack hooks only, so config.mjs may import this file.
import { packHooksAll } from './pack-hooks-all.mjs';

/** Every command the engine CLI itself answers to; a pack may not give one of these names. */
export const ENGINE_COMMANDS = Object.freeze([
  'verify',
  'hook',
  'review-map',
  'move-check',
  'fu',
  'ratchet',
  'mutate',
  'mutations',
  'select',
  'score',
  'cache-report',
  'docs-stale',
]);

const NAME = /^[a-z][a-z0-9-]*$/;

/** The pack commands of a config as `{ [name]: { by, run } }`; `{}` with no pack. */
export function packCommandsOf(config, fail) {
  const out = {};
  for (const { by, value } of packHooksAll('packCommands', config)) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('packs', `${by}: packCommands must be an object of name -> function`);
    for (const [name, run] of Object.entries(value)) {
      if (!NAME.test(name) || typeof run !== 'function')
        fail('packs', `${by}: packCommands.${name} must be a function named /^[a-z][a-z0-9-]*$/`);
      if (ENGINE_COMMANDS.includes(name)) fail('packs', `${by} names the engine command "${name}"`);
      if (out[name]) fail('packs', `command "${name}" is given by ${out[name].by} and ${by}`);
      out[name] = { by, run };
    }
  }
  return out;
}

/** The validated `docs` key: `{ stamped, ext?, exclude? }`. */
export function docsOf(docs, fail) {
  if (!docs || typeof docs !== 'object' || Array.isArray(docs))
    fail('docs', 'must be an object { stamped, ext?, exclude? }');
  for (const key of Object.keys(docs))
    if (!['stamped', 'ext', 'exclude'].includes(key))
      fail('docs', `unknown key "${key}"; allowed: stamped, ext, exclude`);
  if (!Array.isArray(docs.stamped) || docs.stamped.length === 0 || !docs.stamped.every((d) => typeof d === 'string' && d))
    fail('docs.stamped', 'must be a non-empty array of directory paths');
  if (docs.ext !== undefined && typeof docs.ext !== 'string') fail('docs.ext', 'must be a string');
  if (docs.exclude !== undefined && !(Array.isArray(docs.exclude) && docs.exclude.every((d) => typeof d === 'string')))
    fail('docs.exclude', 'must be an array of file names');
  return { ...docs };
}
