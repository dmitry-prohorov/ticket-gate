// The `score` key of gate.config.mjs: the project values the mutation score gate (./score) reads.
// Validated at load time; a bad value throws Error('gate.config: score.<key>: <what>').

export const SCORE_KEYS = Object.freeze([
  'scope',
  'extra',
  'excluded',
  'newFileMin',
  'packageDir',
  'adapter',
  'baseInstall',
  'survivors',
  'worktreeDir',
  'handoff',
  'commands',
  'noTargets',
]);

/** The minimum score of a file that is new on the branch, unless `score.newFileMin` says otherwise. */
export const NEW_FILE_MIN = 80;

export const SCORE_DEFAULTS = Object.freeze({
  extra: [],
  excluded: /(?!)/,
  newFileMin: NEW_FILE_MIN,
  survivors: '.turbo/mutation-survivors.md',
  worktreeDir: 'ticket-gate-score-base',
  handoff: 'add or fix the tests that should kill them',
  commands: { score: 'ticket-gate score' },
  noTargets: 'no file in the score scope changed',
});

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v !== '';
const isLine = (v) => isStr(v) && !/[\r\n]/.test(v);
const isStrList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const segments = (p) => p.split(/[\\/]/);
const isRel = (p) =>
  isStr(p) &&
  !p.startsWith('/') &&
  !/^[A-Za-z]:/.test(p) &&
  !segments(p).includes('..');
const isSubDir = (p) => isRel(p) && p !== '.' && !segments(p).includes('.');
const isOneSegment = (p) => isStr(p) && p !== '.' && p !== '..' && !/[\\/]/.test(p);

/** Validates `score`; `fail(where, what)` throws. A key left out keeps its default (see `scoreOf`). */
export function validateScore(score, fail) {
  if (!isObject(score)) fail('score', 'must be an object');
  for (const k of Object.keys(score)) {
    if (!SCORE_KEYS.includes(k))
      fail(`score.${k}`, `unknown key (known: ${SCORE_KEYS.join(', ')})`);
  }
  for (const k of ['scope', 'excluded']) {
    if (k === 'excluded' && score[k] === undefined) continue;
    const re = score[k];
    if (!(re instanceof RegExp) || re.global || re.sticky)
      fail(`score.${k}`, 'must be a RegExp without the g or y flag');
  }
  if (score.extra !== undefined && !isStrList(score.extra))
    fail('score.extra', 'must be an array of repo paths');
  const min = score.newFileMin;
  if (min !== undefined && !(typeof min === 'number' && min >= 0 && min <= 100))
    fail('score.newFileMin', 'must be a number from 0 to 100');
  if (!isSubDir(score.packageDir) && score.packageDir !== '.')
    fail(
      'score.packageDir',
      'must be a relative sub-directory of the repo, or "." for a package at the repo root',
    );
  const a = score.adapter;
  if (
    !isObject(a) ||
    !isStr(a.name) ||
    !isStr(a.reportPath) ||
    !['runBranch', 'runBase', 'disablesWithoutReason', 'addedDisables'].every(
      (f) => typeof a[f] === 'function',
    )
  )
    fail(
      'score.adapter',
      'needs a string name, a string reportPath and the functions runBranch, runBase, disablesWithoutReason, addedDisables',
    );
  const b = score.baseInstall;
  if (
    !isObject(b) ||
    !isStr(b.cmd) ||
    !isStrList(b.args) ||
    !isStr(b.label) ||
    !isStr(b.hint) ||
    !isOneSegment(b.marker)
  )
    fail(
      'score.baseInstall',
      'needs a string cmd, a string-array args, strings label and hint, and a marker that is one file name',
    );
  if (score.survivors !== undefined && !(isRel(score.survivors) && score.survivors !== '.'))
    fail('score.survivors', 'must be a relative file path');
  if (score.worktreeDir !== undefined && !isOneSegment(score.worktreeDir))
    fail('score.worktreeDir', 'must be a single directory name');
  for (const k of ['handoff', 'noTargets']) {
    if (score[k] !== undefined && !isLine(score[k]))
      fail(`score.${k}`, 'must be a non-empty single-line string');
  }
  const c = score.commands;
  if (c !== undefined) {
    if (!isObject(c)) fail('score.commands', 'must be { score: string }');
    for (const k of Object.keys(c)) {
      if (k !== 'score') fail(`score.commands.${k}`, 'unknown key (known: score)');
    }
    if (c.score !== undefined && !isLine(c.score))
      fail('score.commands.score', 'must be a non-empty single-line command string');
  }
}

/** The effective score config: defaults filled in, given values kept. */
export const scoreOf = (score) => ({
  ...SCORE_DEFAULTS,
  ...score,
  commands: { ...SCORE_DEFAULTS.commands, ...score.commands },
});
