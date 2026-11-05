// Entry kinds and the setup a project hands the engine.
//
// @typedef {object} Kind
//   name, runs: boolean, fields: string[], shape(entry, readFile) -> string[],
//   stale?(entry, readFile) -> string[], area?(entry, dir) -> string,
//   runFields?: string[], selectRules?: [name, (ctx, key, rec) -> boolean][],
//   repair?(entry, diff) -> { entry, notes? } | { left: string },
//   planNote?(entry) -> string | null, session?: Session,
//   validate?(entry, readFile) -> string[]   (what validateSpec adds for a runnable entry),
//   paths?(entry) -> string[]                (files the entry guards, for `affected`),
//   strays?(entry) -> string[]               (a field this kind owns, checked on an entry of any kind)
// readFile(rel) returns the text of a repo file and throws when it is missing.
// @typedef {object} Setup
//   dir, receipts: { ticket, registry }, area(entry), fieldOrder, legacy | null,
//   rebuild: Rule[], childEnv: { drop }, commands, kinds: Map<name, Kind & { by }>,
//   harnesses: Harness[], reuseEnv
import { dirname } from 'node:path';

import { localHarness } from './harness.mjs';

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

const defaultArea = (entry, dir) => {
  const d = dirname(entry.file);
  return d === '.' ? `${dir}/_root.json` : `${dir}/${d}.json`;
};

export const ENGINE_DEFAULTS = Object.freeze({
  dir: 'mutation-registry',
  receipts: Object.freeze({
    ticket: '.turbo/mutation-check.json',
    registry: '.turbo/mutation-registry.json',
  }),
  area: (entry) => defaultArea(entry, 'mutation-registry'),
  fieldOrder: Object.freeze([
    'kind',
    'protects',
    'file',
    'within',
    'find',
    'replace',
    'test',
    'testFile',
    'testName',
    'why',
    'retired',
    'reaimed',
  ]),
  legacy: null,
  rebuild: Object.freeze([]),
  childEnv: Object.freeze({ drop: Object.freeze([]) }),
  commands: Object.freeze({
    mutate: 'ticket-gate mutate',
    checkMutations: 'ticket-gate mutations check',
    checkMutationsScript: 'ticket-gate mutations check',
    afterFatal: 'restore the tree, then re-run',
    restoreHint: 'git checkout on the file',
  }),
  reuseEnv: Object.freeze({}),
});

/** A patch: replace `find` by `replace` in `file`; the harness that claims it runs `test`. */
export const patchKind = {
  name: 'patch',
  runs: true,
  fields: [
    'protects',
    'file',
    'within',
    'find',
    'replace',
    'test',
    'testFile',
    'testName',
  ],
  runFields: [
    'file',
    'within',
    'find',
    'replace',
    'apply',
    'restore',
    'test',
    'object',
    'also',
  ],
  shape(entry) {
    const out = [];
    for (const f of ['protects', 'file', 'find', 'test', 'testFile'])
      if (!isStr(entry[f])) out.push(`${f} must be a non-empty string`);
    if (typeof entry.replace !== 'string') out.push('replace must be a string');
    if (entry.within !== undefined && !isStr(entry.within))
      out.push('within must be a non-empty string');
    return out;
  },
};

const kindTwice = (name, a, b) =>
  new Error(`mutations config: kind "${name}" is named by both ${a} and ${b}`);

/**
 * Merges a project config over the engine defaults. Kinds resolve in order
 * engine (`patch`), each pack's `mutationKinds`, then `config.kinds`; harnesses
 * are every pack's `mutationHarnesses` in pack order, then `localHarness` last.
 */
export function resolveSetup(config = {}) {
  const packs = config.packs ?? [];
  const kinds = new Map();
  const add = (name, kind, by) => {
    if (kinds.has(name)) throw kindTwice(name, kinds.get(name).by, by);
    kinds.set(name, { ...kind, by });
  };
  add('patch', patchKind, 'engine');
  for (const p of packs)
    for (const [name, kind] of Object.entries(p.mutationKinds ?? {}))
      add(name, kind, p.name);
  for (const [name, kind] of Object.entries(config.kinds ?? {}))
    add(name, kind, 'config');
  const dir = config.dir ?? ENGINE_DEFAULTS.dir;
  return {
    dir,
    receipts: config.receipts ?? ENGINE_DEFAULTS.receipts,
    area: config.area ?? ((entry) => defaultArea(entry, dir)),
    fieldOrder: config.fieldOrder ?? ENGINE_DEFAULTS.fieldOrder,
    legacy: config.legacy ?? ENGINE_DEFAULTS.legacy,
    rebuild: config.rebuild ?? ENGINE_DEFAULTS.rebuild,
    childEnv: config.childEnv ?? ENGINE_DEFAULTS.childEnv,
    commands: { ...ENGINE_DEFAULTS.commands, ...config.commands },
    reuseEnv: config.reuseEnv ?? ENGINE_DEFAULTS.reuseEnv,
    kinds,
    harnesses: [
      ...packs.flatMap((p) => p.mutationHarnesses ?? []),
      localHarness,
    ],
  };
}

const isRef = (w) => /\d/.test(w) || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(w);

/** Why a `protects` is too thin (null when fine): 4+ words, at least one a row or spec id. */
export function checkProtects(protects) {
  if (typeof protects !== 'string') return 'protects must be a string';
  const words = protects.split(/\s+/).filter(Boolean);
  if (words.length < 4)
    return `protects has ${words.length} words, needs 4 or more`;
  if (!words.some(isRef)) return 'protects names no contract row or spec id';
  return null;
}
