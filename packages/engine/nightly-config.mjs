// The validated `nightly` key of gate.config.mjs: the nightly's one config object with the
// payloads the packs contribute (their `nightlyPayloads` hook) added after the project's own.
// Imports the collection half of the pack hooks only, so config.mjs may import this file.
import { packHooksAll } from './pack-hooks-all.mjs';
import { defineNightly } from './nightly/define.mjs';

/** The pack hooks that feed the nightly. */
export const NIGHTLY_HOOKS = Object.freeze(['nightlyPayloads']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The nightly of a config (`defineNightly` output); a bad one fails as `gate.config: nightly: <reason>`. */
export function nightlyOf(config, fail) {
  if (!isObject(config.nightly)) fail('nightly', 'must be an object');
  const payloads = [];
  const seen = new Map();
  const add = (by, given) => {
    for (const p of [].concat(given)) {
      if (typeof p?.name !== 'string' || p.name === '')
        fail('nightly', `payload from ${by} must be an object with a string name`);
      if (seen.has(p.name)) fail('nightly', `payload "${p.name}" is given by ${seen.get(p.name)} and ${by}`);
      seen.set(p.name, by);
      payloads.push(p);
    }
  };
  for (const p of config.nightly.payloads ?? []) add('gate.config', p);
  for (const { by, value } of packHooksAll('nightlyPayloads', config)) add(by, value);
  try {
    return defineNightly({ ...config.nightly, payloads });
  } catch (e) {
    const m = /^nightly config: (.*)$/s.exec(e.message);
    if (m) fail('nightly', m[1]);
    throw e;
  }
}
