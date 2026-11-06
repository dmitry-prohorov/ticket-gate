// Validates and freezes gate.config.mjs. Dependency-free; a bad config throws
// Error('gate.config: <where>: <what>'). Fix the named key in gate.config.mjs and rerun.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { docsOf, packCommandsOf } from './commands-config.mjs';
import { ROOT } from './root.mjs';
import { scoreOf, validateScore } from './score-config.mjs';
import { selectionOf } from './selection-config.mjs';

export const GATE_KEYS = Object.freeze([
  'steps',
  'stacks',
  'stopOnRedBefore',
  'dataPaths',
  'reviewMap',
  'dod',
  'pushGuard',
  'base',
  'packs',
  'followUps',
  'precheck',
  'ratchets',
  'roles',
  'skills',
  'toolPrefixes',
  'registryFile',
  'stackHint',
  'commands',
  'mutations',
  'score',
  'selection',
  'docs',
]);

/**
 * The commands the engine's messages tell a reader to run. A project whose runner differs (a
 * package.json script, a wrapper) sets `commands` in gate.config.mjs; a key left out keeps the
 * engine's own CLI name. `fu` and `verify` are command prefixes: a message appends arguments.
 * `nightlyStatus` has no default: a project with a nightly sets it, and a message names it only then.
 */
export const DEFAULT_COMMANDS = Object.freeze({
  verify: 'ticket-gate verify',
  fu: 'ticket-gate fu',
  moveCheck: 'ticket-gate move-check',
});

/** The effective commands of a gate (a defined one, a plain object or undefined): defaults filled in. */
export const commandsOf = (gate) => ({
  ...DEFAULT_COMMANDS,
  ...(gate?.commands ?? {}),
});

/** The commands the mutation engine's messages name; they join `commands` and default in the engine. */
export const MUTATION_COMMAND_KEYS = Object.freeze([
  'mutate',
  'checkMutations',
  'checkMutationsScript',
  'afterFatal',
  'restoreHint',
]);

const COMMAND_KEYS = [
  ...Object.keys(DEFAULT_COMMANDS),
  'nightlyStatus',
  ...MUTATION_COMMAND_KEYS,
];

const DEFAULT_PROTECTED = ['main', 'master'];
const DEFAULT_OVERSIZE_WAIVER = /^(?:- )?oversize-accepted: \S/;

const TIERS = ['HUMAN', 'GATED', 'MACHINE'];
const BRANCH_NAME = /^[A-Za-z0-9._/-]+$/;

export function pick(out, patterns) {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const re of patterns) {
    const hits = lines.filter((l) => re.test(l));
    if (hits.length) return hits[hits.length - 1];
  }
  return null;
}

/** turbo prints one "Tasks:" line per sub-command; a false green hides in the ones you drop. */
export function allTasksLines(out) {
  const hits = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^Tasks:/.test(l));
  return hits.length ? hits.join(' | ') : null;
}

const lastLine = (out) => {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
};

/**
 * Build a step with the defaults a config rarely varies (4.2): why, notRun, summary
 * and limitS. Never supplies `reuse` (a step reuses only when its author says so) and
 * never a `limitS` on a human step. `summary: { pick: [RegExp] }` is sugar for pick().
 */
export function step(spec) {
  const summary = spec.summary?.pick
    ? (out) => pick(out, spec.summary.pick)
    : spec.summary;
  return {
    why: 'selected by when',
    notRun: 'not selected by when',
    summary: (out) => lastLine(out) ?? 'passed',
    ...spec,
    ...(summary ? { summary } : {}),
    limitS: spec.human ? undefined : (spec.limitS ?? 600),
  };
}

const escapeRe = (c) => c.replace(/[.+^$()|[\]\\]/g, '\\$&');

/**
 * A glob as a RegExp over the whole path: `**` crosses `/` (`**` + `/` also matches no
 * directory), `*` and `?` stay inside one segment, `{a,b}` is an alternation.
 */
export function globRe(glob) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      depth += 1;
      out += '(?:';
    } else if (c === '}' && depth > 0) {
      depth -= 1;
      out += ')';
    } else if (c === ',' && depth > 0) out += '|';
    else out += escapeRe(c);
  }
  return new RegExp(`^${out}$`);
}

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

const isGlobList = (v) =>
  Array.isArray(v) && v.every((g) => typeof g === 'string' && g);

function fail(where, what) {
  throw new Error(`gate.config: ${where}: ${what}`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export function defineGate(config) {
  if (!config || typeof config !== 'object')
    fail('config', 'must be an object');
  for (const key of Object.keys(config)) {
    if (!GATE_KEYS.includes(key)) fail(key, 'unknown key');
  }
  const steps = config.steps ?? [];
  const stacks = config.stacks ?? {};
  if (!Array.isArray(steps)) fail('steps', 'must be an array');

  const seen = new Set();
  steps.forEach((s, i) => {
    const at = `steps[${i}]${s && s.id ? ` (${s.id})` : ''}`;
    if (!s || typeof s.id !== 'string' || !s.id)
      fail(at, 'id must be a non-empty string');
    if (seen.has(s.id)) fail(at, `duplicate step id "${s.id}"`);
    seen.add(s.id);
  });

  steps.forEach((s, i) => {
    const at = `steps[${i}] (${s.id})`;
    // prettier-ignore
    if (!(typeof s.when === 'boolean' || typeof s.when === 'function' || isGlobList(s.when))) fail(at, 'when must be a boolean, a glob list or a function');
    if (typeof s.cmd !== 'string' && typeof s.cmd !== 'function')
      fail(at, 'cmd must be a string or function');
    if (typeof s.why !== 'string') fail(at, 'why must be a string');
    if (typeof s.notRun !== 'string') fail(at, 'notRun must be a string');
    if (typeof s.summary !== 'function') fail(at, 'summary must be a function');
    if (!s.human && !(Number.isInteger(s.limitS) && s.limitS > 0))
      fail(at, 'limitS must be a positive integer');
    if (!s.human && s.reuse !== false && !Array.isArray(s.reuse?.deny))
      fail(at, 'reuse must be false or { deny: [...] }');
    if (s.human && (s.reuse !== undefined || s.limitS !== undefined))
      fail(at, 'a human step has no reuse or limitS');
    if (s.stack !== undefined && !Object.hasOwn(stacks, s.stack))
      fail(at, `unknown stack "${s.stack}"`);
    // prettier-ignore
    if (s.units !== undefined && (typeof s.units?.select !== 'function' || typeof s.units?.cmd !== 'function')) fail(at, 'units needs select(ctx) and cmd(units)');
    if (s.units?.reaches !== undefined && typeof s.units.reaches !== 'function')
      fail(at, 'units.reaches must be a function');
  });

  const nightly = steps.filter((s) => s.units?.nightly);
  if (nightly.length > 1) {
    fail('steps', `only one step may carry nightly units: ${nightly[0].id}, ${nightly[1].id}`);
  }

  const known = (where, id) => {
    if (!seen.has(id)) fail(where, `unknown step id "${id}"`);
  };
  for (const [name, stack] of Object.entries(stacks)) {
    const at = `stacks.${name}`;
    if (stack.start !== undefined && typeof stack.start !== 'string')
      fail(`${at}.start`, 'must be a command string');
    if (stack.lock !== undefined && typeof stack.lock?.path !== 'string')
      fail(`${at}.lock`, 'must be { path: string }');
    if (typeof stack.health === 'function') {
      // the 4.2 form: planned as the step `<id>:health`
    } else if (stack.health) known(`${at}.health.step`, stack.health.step);
    if (stack.reset) {
      known(`${at}.reset.step`, stack.reset.step);
      for (const id of stack.reset.satisfiedBy ?? [])
        known(`${at}.reset.satisfiedBy`, id);
      for (const id of stack.reset.before ?? [])
        known(`${at}.reset.before`, id);
      for (const id of stack.reset.note?.steps ?? [])
        known(`${at}.reset.note.steps`, id);
    }
  }
  const stops = config.stopOnRedBefore;
  if (stops !== undefined && typeof stops !== 'string' && !Array.isArray(stops))
    fail('stopOnRedBefore', 'must be a step id or an array of step ids');
  for (const id of [].concat(stops ?? [])) known('stopOnRedBefore', id);
  for (const [path, ids] of Object.entries(config.dataPaths ?? {})) {
    for (const id of ids) known(`dataPaths["${path}"]`, id);
  }

  validateServices(stacks, seen);
  if (config.reviewMap !== undefined && !isObject(config.reviewMap))
    fail('reviewMap', 'must be an object');
  const reviewMap = {
    rules: [],
    sizeExcluded: [],
    humanLines: [],
    warn: 800,
    oversize: 1500,
    ...config.reviewMap,
  };
  validateReviewMap(reviewMap);
  const dod =
    config.dod === undefined
      ? undefined
      : { human: '(human)', oversize: DEFAULT_OVERSIZE_WAIVER, ...config.dod };
  if (dod !== undefined) validateDod(dod);
  if (config.pushGuard !== undefined) validatePushGuard(config.pushGuard);
  const packs = config.packs ?? [];
  const precheck = config.precheck ?? [];
  validatePacks(packs);
  validatePrecheck(precheck);
  validateExtras(config);
  validateRatchets(config.ratchets);
  validateHooks(config);
  validateCommands(config.commands);
  if (config.mutations !== undefined) validateMutations(config.mutations);
  if (config.score !== undefined) validateScore(config.score, fail);

  return deepFreeze({
    ...config,
    steps,
    stacks,
    reviewMap,
    ...(dod ? { dod } : {}),
    pushGuard: config.pushGuard ?? { protected: [...DEFAULT_PROTECTED] },
    dataPaths: config.dataPaths ?? {},
    toolPrefixes: config.toolPrefixes ?? [],
    commands: commandsOf(config),
    packs,
    packCommands: packCommandsOf(config, fail),
    precheck,
    ...(config.docs !== undefined ? { docs: docsOf(config.docs, fail) } : {}),
    ...(config.score !== undefined ? { score: scoreOf(config.score) } : {}),
    ...(config.selection !== undefined
      ? { selection: selectionOf(config, fail) }
      : {}),
  });
}

// toolPrefixes: path prefixes whose files are an input of every step (unless dataPaths narrows them).
// registryFile(path): whether a path is mutation-registry data. stackHint(stepId): the command that
// diagnoses a stack step. splitHint (in reviewMap): the pointer printed beside a size warning.
function validateHooks(config) {
  const { toolPrefixes, registryFile, stackHint } = config;
  if (
    toolPrefixes !== undefined &&
    !(
      Array.isArray(toolPrefixes) &&
      toolPrefixes.every((p) => typeof p === 'string')
    )
  )
    fail('toolPrefixes', 'must be an array of path prefixes');
  if (registryFile !== undefined && typeof registryFile !== 'function')
    fail('registryFile', 'must be a function of a repo path');
  if (stackHint !== undefined && typeof stackHint !== 'function')
    fail('stackHint', 'must be a function of a step id');
  const hint = config.reviewMap?.splitHint;
  if (hint !== undefined && typeof hint !== 'string')
    fail('reviewMap.splitHint', 'must be a string');
}

function validateCommands(commands) {
  if (commands === undefined) return;
  if (!isObject(commands)) fail('commands', 'must be an object');
  for (const [k, v] of Object.entries(commands)) {
    if (!COMMAND_KEYS.includes(k))
      fail(`commands.${k}`, `unknown key (known: ${COMMAND_KEYS.join(', ')})`);
    if (typeof v !== 'string' || !v.trim() || /[\r\n]/.test(v))
      fail(`commands.${k}`, 'must be a non-empty single-line command string');
  }
}

export const MUTATION_KEYS = Object.freeze([
  'dir',
  'receipts',
  'area',
  'fieldOrder',
  'legacy',
  'rebuild',
  'childEnv',
  'reuseEnv',
  'kinds',
]);

const isStr = (v) => typeof v === 'string' && v !== '';
// prettier-ignore
const isRelDir = (v) => isStr(v) && !v.startsWith('/') && !/^[A-Za-z]:/.test(v) && !v.split(/[\\/]/).includes('..');

// `mutations` configures the mutation engine (kinds, rebuild rules, child env, registry folder).
// `packs` and `commands` stay top-level keys: a pack's kinds and harnesses come from the pack.
function validateMutations(m) {
  if (!isObject(m)) fail('mutations', 'must be an object');
  for (const k of Object.keys(m))
    if (!MUTATION_KEYS.includes(k)) fail(`mutations.${k}`, 'unknown key');
  if (m.dir !== undefined) {
    // prettier-ignore
    if (!isRelDir(m.dir)) fail('mutations.dir', 'must be a relative directory path');
  }
  if (m.receipts !== undefined) {
    if (!isObject(m.receipts) || !isStr(m.receipts.ticket) || !isStr(m.receipts.registry))
      fail('mutations.receipts', 'must be { ticket: string, registry: string }');
  }
  if (m.area !== undefined && typeof m.area !== 'function')
    fail('mutations.area', 'must be a function of an entry');
  if (
    m.fieldOrder !== undefined &&
    !(Array.isArray(m.fieldOrder) && m.fieldOrder.every(isStr))
  )
    fail('mutations.fieldOrder', 'must be an array of field names');
  if (m.legacy !== undefined && m.legacy !== null) {
    if (
      !isObject(m.legacy) ||
      typeof m.legacy.files !== 'function' ||
      typeof m.legacy.atRef !== 'function'
    )
      fail('mutations.legacy', 'must be null or { files(), atRef(ref, root) }');
  }
  if (m.rebuild !== undefined) {
    if (!Array.isArray(m.rebuild)) fail('mutations.rebuild', 'must be an array');
    m.rebuild.forEach((r, i) => {
      const at = `mutations.rebuild[${i}]`;
      for (const f of ['files', 'cmd', 'io', 'flag', 'drift', 'note'])
        if (!isStr(r?.[f])) fail(`${at}.${f}`, 'must be a non-empty string');
      if (r.unlessTest !== undefined && !(r.unlessTest instanceof RegExp))
        fail(`${at}.unlessTest`, 'must be a RegExp');
      if (r.limitS !== undefined && !(Number.isInteger(r.limitS) && r.limitS > 0))
        fail(`${at}.limitS`, 'must be a positive integer');
    });
  }
  if (m.childEnv !== undefined) {
    const drop = m.childEnv?.drop;
    if (!(Array.isArray(drop) && drop.every(isStr)))
      fail('mutations.childEnv.drop', 'must be an array of variable names');
  }
  if (m.reuseEnv !== undefined) {
    if (!isObject(m.reuseEnv) || !Object.values(m.reuseEnv).every((v) => typeof v === 'string'))
      fail('mutations.reuseEnv', 'must be an object of string values');
  }
  if (m.kinds !== undefined) {
    if (!isObject(m.kinds)) fail('mutations.kinds', 'must be an object');
    for (const [name, k] of Object.entries(m.kinds)) {
      // prettier-ignore
      if (typeof k?.name !== 'string' || typeof k.runs !== 'boolean' || typeof k.shape !== 'function') fail(`mutations.kinds.${name}`, 'needs name, runs and shape(entry)');
    }
  }
}

function validatePacks(packs) {
  if (!Array.isArray(packs)) fail('packs', 'must be an array');
  packs.forEach((p, i) => {
    const at = `packs[${i}]`;
    // prettier-ignore
    if (typeof p?.name !== 'string' || typeof p?.version !== 'string') fail(at, 'a pack needs a string name and version');
  });
}

function validatePrecheck(list) {
  if (!Array.isArray(list)) fail('precheck', 'must be an array');
  list.forEach((c, i) => {
    const at = `precheck[${i}]`;
    if (typeof c === 'function') return;
    if (typeof c?.id !== 'string' || !c.id)
      fail(at, 'id must be a non-empty string');
    if (typeof c.cmd !== 'string' && typeof c.cmd !== 'function')
      fail(at, 'cmd must be a string or a function of { base }');
    if (typeof c.fix !== 'string') fail(at, 'fix must be a string');
  });
}

function validateExtras(config) {
  if (config.base !== undefined && !BRANCH_NAME.test(String(config.base)))
    fail('base', 'must be a git ref ([A-Za-z0-9._/-])');
  const fu = config.followUps;
  if (fu !== undefined) {
    if (!isObject(fu) || typeof fu.dir !== 'string' || !fu.dir)
      fail('followUps', 'must be { dir: string, pointer?: string }');
    if (fu.pointer !== undefined && typeof fu.pointer !== 'string')
      fail('followUps.pointer', 'must be a string');
  }
  if (config.roles !== undefined) {
    if (!isObject(config.roles)) fail('roles', 'must be an object');
    for (const [role, r] of Object.entries(config.roles)) {
      const at = `roles.${role}`;
      if (
        !Array.isArray(r?.owns) ||
        !r.owns.every((g) => typeof g === 'string')
      )
        fail(at, 'owns must be an array of globs');
      if (r.axis !== undefined && typeof r.axis !== 'string')
        fail(at, 'axis must be a string');
    }
  }
  const sk = config.skills;
  if (sk !== undefined) {
    if (!isObject(sk)) fail('skills', 'must be an object');
    for (const k of ['lock', 'dir'])
      if (sk[k] !== undefined && typeof sk[k] !== 'string')
        fail(`skills.${k}`, 'must be a string');
  }
}

function validateRatchets(ratchets) {
  if (ratchets === undefined) return;
  if (!isObject(ratchets)) fail('ratchets', 'must be an object');
  for (const [name, entry] of Object.entries(ratchets)) {
    const at = `ratchets.${name}`;
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      fail(at, 'name must match /^[a-z][a-z0-9-]*$/');
    if (!isObject(entry)) fail(at, 'must be an object');
    if (typeof entry.check !== 'function')
      throw new Error(`gate.config: ${at}.check must be a function`);
    if (entry.group !== undefined && entry.group !== 'check')
      fail(`${at}.group`, "must be 'check'");
    if (entry.baseline !== undefined && typeof entry.baseline !== 'string')
      fail(`${at}.baseline`, 'must be a string');
  }
}

function validateServices(stacks, stepIds) {
  for (const [name, stack] of Object.entries(stacks)) {
    if (stack.services === undefined) continue;
    const at = `stacks.${name}.services`;
    if (!stack.services || typeof stack.services !== 'object')
      fail(at, 'must be an object of step id -> service names');
    for (const [id, list] of Object.entries(stack.services)) {
      if (!stepIds.has(id)) fail(`${at}.${id}`, `unknown step id "${id}"`);
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        !list.every((n) => typeof n === 'string' && n)
      )
        fail(`${at}.${id}`, 'must be a non-empty array of service names');
    }
  }
}

function validateReviewMap(rm) {
  if (!rm || typeof rm !== 'object') fail('reviewMap', 'must be an object');
  if (!Array.isArray(rm.rules)) fail('reviewMap.rules', 'must be an array');
  const ids = new Set();
  rm.rules.forEach((r, i) => {
    const at = `reviewMap.rules[${i}]${r && r.id ? ` (${r.id})` : ''}`;
    if (!r || typeof r.id !== 'string' || !r.id)
      fail(at, 'id must be a non-empty string');
    if (ids.has(r.id)) fail(at, `duplicate rule id "${r.id}"`);
    ids.add(r.id);
    if (!TIERS.includes(r.tier))
      fail(at, `tier must be one of ${TIERS.join(', ')}`);
    if (typeof r.reason !== 'string') fail(at, 'reason must be a string');
    if (typeof r.match !== 'function') fail(at, 'match must be a function');
  });
  if (!Array.isArray(rm.sizeExcluded))
    fail('reviewMap.sizeExcluded', 'must be an array of rule ids or globs');
  for (const id of rm.sizeExcluded)
    if (!/[/*]/.test(String(id)) && !ids.has(id))
      fail(
        'reviewMap.sizeExcluded',
        `"${id}" is not a rule id in reviewMap.rules`,
      );
  (rm.humanLines ?? []).forEach((h, i) => {
    const at = `reviewMap.humanLines[${i}]`;
    // prettier-ignore
    if (typeof h?.line !== 'string' || h.line === '' || !(typeof h.match === 'string' || h.match instanceof RegExp)) fail(at, 'humanLines need { match, line }');
  });
  for (const k of ['warn', 'oversize'])
    if (!Number.isInteger(rm[k]) || rm[k] <= 0)
      fail(`reviewMap.${k}`, 'must be a positive integer');
  if (rm.warn >= rm.oversize)
    fail('reviewMap.warn', 'must be below reviewMap.oversize');
}

function validateDod(dod) {
  if (!dod || typeof dod !== 'object') fail('dod', 'must be an object');
  const { files } = dod;
  if (!Array.isArray(files) || files.length === 0)
    fail('dod.files', 'must be a non-empty array of globs');
  if (!files.every((g) => typeof g === 'string' && g))
    fail('dod.files', 'every glob must be a non-empty string');
  if (typeof dod.contract !== 'string' || !dod.contract.includes('{id}'))
    fail('dod.contract', 'must be a path containing {id}');
  if (typeof dod.human !== 'string' || !dod.human)
    fail('dod.human', 'must be a non-empty string');
  if (!(dod.oversize instanceof RegExp))
    fail('dod.oversize', 'must be a RegExp');
}

function validatePushGuard(guard) {
  if (!guard || typeof guard !== 'object')
    fail('pushGuard', 'must be an object');
  const names = guard.protected;
  if (!Array.isArray(names)) fail('pushGuard.protected', 'must be an array');
  if (guard.protected.length === 0)
    fail(
      'pushGuard.protected',
      'must not be empty: an empty list allows a push to main',
    );
  for (const n of names)
    if (typeof n !== 'string' || !BRANCH_NAME.test(n))
      fail(
        'pushGuard.protected',
        `"${String(n)}" is not a branch name ([A-Za-z0-9._/-])`,
      );
}

const REQUIRED_KEYS = ['reviewMap', 'dod'];

/**
 * Import <root>/gate.config.mjs and validate its default export again, so a plain
 * object that never went through defineGate is still checked. Rejects with
 * Error('gate.config: ...') when the file is missing, throws, or is invalid; the
 * hooks that call it treat a rejection as "fail closed".
 */
export async function loadGateConfig(root = ROOT) {
  const file = join(root, 'gate.config.mjs');
  if (!existsSync(file))
    fail('gate.config.mjs', `not found at ${file}; restore it from git`);
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    fail('gate.config.mjs', `does not load: ${err?.message ?? err}`);
  }
  const exported = mod.default;
  if (!exported || typeof exported !== 'object')
    fail('gate.config.mjs', 'must default-export defineGate({...})');
  // packCommands is derived from packs by defineGate, so a frozen gate carries it back in.
  const { packCommands: _derived, ...config } = exported;
  for (const key of REQUIRED_KEYS)
    if (config[key] === undefined) fail(key, 'missing');
  if (!Array.isArray(config.steps) || config.steps.length === 0)
    fail('steps', 'missing or empty');
  return defineGate(config);
}
