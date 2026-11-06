// The nightly-backed units step: plans a partial (affected) run of a test suite from the selection
// engine, the newest nightly record and the spec ledger, and judges its result. `nightlyUnits`
// is the `units` slot of the step that runs the suite. gate.config.mjs imports this file, and the
// digest, the ledger and the pack hooks all reach gate.config.mjs, so they load lazily inside the
// async planner and never at import.
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AFFECTED_NIGHTLY, NIGHTLY_MAX_AGE_MS } from '../nightly-window.mjs';
import { ROOT } from '../root.mjs';
import { shadowOf, walkReport } from '../runners/playwright.mjs';

// The suite's Playwright JSON, read only by the shadow.
export const E2E_REPORT = join(ROOT, '.turbo', 'e2e-report.json');

// Written by the step's `prepare`, after the stack lock is held.
export const E2E_LIST = join(ROOT, '.turbo', 'e2e-selection.txt');

export const E2E_KNOWN_RED = join(ROOT, '.turbo', 'e2e-known-red.txt');

// A nightly record counts for known red only when its run reached the browser tests.
const REACHED = (r) => r.reachedPlaywright === true;
const byRanAtDesc = (a, b) => Date.parse(b.ranAt) - Date.parse(a.ranAt);

// An affected run always also runs the smoke tests and the setup specs (affectedListLines), so it
// never has zero units.
const SMOKE = { id: '@smoke+setup', inputs: [] };

/**
 * One nightly record for one suite: a v2 record keeps each suite's result under `suites[suite]`
 * (the run's sha and ranAt apply to every suite); a v1 record is the suite itself.
 */
export const recordOf = (run, suite) =>
  run.suites?.[suite]
    ? { sha: run.sha, ranAt: run.ranAt, ...run.suites[suite] }
    : run;

/** `--e2e=full` is the only value; no flag is `auto`. */
export function parseE2eFlag(args) {
  const arg = args.find((a) => a === '--e2e' || a.startsWith('--e2e='));
  if (arg === undefined) return { flag: 'auto' };
  const value = arg.slice('--e2e='.length);
  if (arg.startsWith('--e2e=') && value === 'full') return { flag: 'full' };
  return {
    error: `unknown --e2e value "${arg.startsWith('--e2e=') ? value : ''}". Only --e2e=full is valid.`,
  };
}

/**
 * G4: `affected` only for an affected selection with a fresh green or amber
 * nightly. Every other input gives `full` with the reason; nothing here fails.
 */
export function chooseE2eMode({ selection, nightly, flag, nowMs }) {
  if (flag === 'full') return { mode: 'full', why: '--e2e=full' };
  // prettier-ignore
  if (selection.mode !== 'affected') return { mode: 'full', why: selection.why };
  // prettier-ignore
  if (!AFFECTED_NIGHTLY.includes(nightly?.status)) return { mode: 'full', why: `nightly ${nightly?.status ?? 'missing'}` };
  // prettier-ignore
  if (!(nowMs - Date.parse(nightly.ranAt) <= NIGHTLY_MAX_AGE_MS)) return { mode: 'full', why: 'nightly stale' };
  return { mode: 'affected', why: selection.why };
}

/**
 * G5, R5: the specs the newest nightly (at the base or an ancestor of it) saw
 * red, minus this branch's own selection. `runs` is every nightly record;
 * `isAncestor(sha)` says whether sha is an ancestor of the base.
 */
export function knownRedOf({ runs, baseSha, isAncestor, branch, selected }) {
  if (/^fix\/nightly-/.test(branch)) return [];
  const newest = runs
    .filter((r) => REACHED(r) && typeof r.sha === 'string' && r.sha !== '')
    .sort(byRanAtDesc)
    .find((r) => r.sha === baseSha || isAncestor(r.sha));
  if (newest?.status !== 'red') return [];
  return [...(newest.redSpecs ?? [])]
    .filter((f) => !selected.includes(f))
    .sort();
}

/**
 * R2: spec file -> the changed paths that select it. A path whose own
 * selection is `full` (a trigger) is an input of every spec.
 */
export function specInputs({ changed, specs, selectOne }) {
  const out = new Map(specs.map((f) => [f, []]));
  for (const p of changed) {
    const s = selectOne(p);
    for (const f of s.mode === 'full' ? specs : s.specs) {
      if (!out.has(f)) out.set(f, []);
      out.get(f).push(p);
    }
  }
  return out;
}

/**
 * R1, R3: which selected specs run and which are reused. A spec is reused only
 * when its newest spec-ledger line on the same digest is a pass; an amber
 * flaky spec (`alwaysRun`) and `--fresh` never reuse.
 */
export function planSpecs({
  selected,
  inputs,
  digestOf,
  specLedger,
  fresh,
  alwaysRun,
}) {
  const digests = new Map();
  for (const f of new Set([...inputs.keys(), ...selected]))
    digests.set(f, digestOf(f, inputs.get(f) ?? []));
  const run = [];
  const reused = [];
  for (const file of selected) {
    const digest = digests.get(file);
    const line = specLedger.findLast(
      (l) => l.id === 'e2e-spec' && l.file === file && l.digest === digest,
    );
    if (!fresh && !alwaysRun.has(file) && line?.status === 'pass') {
      reused.push({
        file,
        digest,
        inputs: inputs.get(file) ?? [],
        reusedFrom: line.ranAt,
      });
    } else run.push(file);
  }
  return { run, reused, digests };
}

const isSmoke = (spec, t) =>
  [...(spec.tags ?? []), ...(t.tags ?? [])].some(
    (x) => String(x).replace(/^@/, '') === 'smoke',
  ) || /@smoke\b/.test(spec.title ?? '');

/** Every test of `playwright test --list --reporter=json`: { file, line, smoke }, `line` as --test-list spells it. */
function listedTests(listJson) {
  const out = [];
  const visit = (suites, titles) => {
    for (const s of suites ?? []) {
      const own = titles.length === 0 && s.title === s.file ? [] : [s.title];
      const path = [...titles, ...own.filter(Boolean)];
      for (const spec of s.specs ?? []) {
        const file = spec.file ?? s.file ?? '';
        for (const t of spec.tests ?? [])
          out.push({
            file,
            line: `${file} › ${[...path, spec.title].join(' › ')}`,
            smoke: isSmoke(spec, t),
          });
      }
      visit(s.suites, path);
    }
  };
  visit(listJson?.suites, []);
  return out;
}

const unique = (lines) => [...new Set(lines)];

/** `--test-list` lines for an affected run: the run specs, smoke tests and the `setup` files, never a knownRed file. */
export function affectedListLines(listJson, { run, knownRed, setup }) {
  return unique(
    listedTests(listJson)
      .filter((t) => !knownRed.includes(t.file))
      .filter((t) => run.includes(t.file) || t.smoke || setup.has(t.file))
      .map((t) => t.line),
  );
}

/** `--test-list-invert` lines: every test of a knownRed file. */
export function knownRedLines(listJson, knownRed) {
  return unique(
    listedTests(listJson)
      .filter((t) => knownRed.includes(t.file))
      .map((t) => t.line),
  );
}

/** Fallback when playwright has no --test-list-invert: every test outside knownRed. */
export function fullListLines(listJson, knownRed) {
  return unique(
    listedTests(listJson)
      .filter((t) => !knownRed.includes(t.file))
      .map((t) => t.line),
  );
}

/**
 * G2: one entry per spec. `unexpected` is a fail; `expected`, `flaky` and
 * `skipped` pass. A run spec absent from the report fails. In `full` every
 * spec file of the report is an entry (`setup` files are not).
 */
export function specResults(report, { mode, run, reused, digests, setup }) {
  const seen = new Map();
  walkReport(report?.suites, (spec, t) => {
    const file = spec.file ?? '';
    if (setup.has(file)) return;
    const cur = seen.get(file) ?? { fail: false, ms: 0 };
    if (t.status === 'unexpected') cur.fail = true;
    cur.ms += (t.results ?? []).reduce((a, r) => a + (r.duration ?? 0), 0);
    seen.set(file, cur);
  });
  const entry = (file) => {
    const got = seen.get(file);
    const digest = digests.get(file);
    return {
      file,
      ...(digest === undefined ? {} : { digest }),
      status: got !== undefined && !got.fail ? 'pass' : 'fail',
      ...(got === undefined ? {} : { ms: Math.round(got.ms) }),
    };
  };
  const files = new Set(run);
  if (mode === 'full') for (const f of seen.keys()) files.add(f);
  return [
    ...[...files].map(entry),
    ...reused.map((r) => ({
      file: r.file,
      digest: r.digest,
      status: 'reused',
      inputs: r.inputs,
      reusedFrom: r.reusedFrom,
    })),
  ].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * The suite's result of the receipt (G2): buildResults' result plus mode, why,
 * selected, specs, nightly and knownRed. A spec that failed or never ran turns
 * a passing step into a fail.
 */
export function finishE2e(result, ctx) {
  const { report, mode, why, selected, nightly, knownRed, run, reused } = ctx;
  const specs = specResults(report, { ...ctx, run, reused });
  const bad = specs.filter((s) => s.status === 'fail').map((s) => s.file);
  const status =
    result.status === 'pass' && bad.length > 0 ? 'fail' : result.status;
  const ran = specs.filter((s) => s.status !== 'reused').length;
  const tail =
    result.status === 'pass' && bad.length > 0
      ? `; spec failed or absent from the report: ${bad.join(', ')}`
      : '';
  return {
    ...result,
    status,
    summary: `${mode} (${why}): ${ran} run, ${reused.length} reused, ${knownRed.length} known red; ${result.summary}${tail}`,
    mode,
    why,
    selected,
    specs,
    nightly:
      nightly === null || nightly === undefined
        ? null
        : {
            sha: nightly.sha,
            ranAt: nightly.ranAt,
            status: nightly.status,
            checkedAt: ctx.checkedAt,
          },
    knownRed,
  };
}

let selectorMemo = null;

/**
 * The selector loads only when the suite can run (it parses TypeScript). One graph and one base
 * reader are shared by the selection and the per-path inputs; the memo is keyed on the base and
 * the selection.
 */
async function loadSelector(baseSha, selection) {
  if (selectorMemo?.baseSha === baseSha && selectorMemo.selection === selection)
    return selectorMemo;
  const { select, specHeaders } = await import('./select.mjs');
  const { buildGraph } = await import('../graph/js.mjs');
  const readBase = (p) => {
    try {
      return execFileSync('git', ['show', `${baseSha}:${p}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };
  selectorMemo = {
    baseSha,
    selection,
    select,
    readBase,
    specs: () => [...specHeaders(ROOT, selection).keys()],
    graph: buildGraph(ROOT, selection),
  };
  return selectorMemo;
}

/**
 * R4 (e): a changed path that is part of the test harness (`selection.outside.reach`, minus test
 * files) which the suite imports. A selector that cannot run counts as yes.
 */
export async function reachesHarness(paths, baseSha, { selection }) {
  const { reach, testFile } = selection.outside;
  const changed = paths.filter(
    (p) =>
      reach.some((x) => p.startsWith(x)) && !(testFile?.test(p) ?? false),
  );
  if (changed.length === 0) return false;
  try {
    const sel = await loadSelector(baseSha, selection);
    const got = sel.select({
      root: ROOT,
      changed,
      readBase: sel.readBase,
      graph: sel.graph,
      config: selection,
    });
    return got.mode === 'full' || got.specs.length > 0;
  } catch {
    return true;
  }
}

const isAncestorOf = (baseSha) => (sha) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, baseSha], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

const branchName = () => {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

const writeList = (path, lines) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
};

/** Whether the runner takes its invert flag; a runner that cannot say counts as yes. */
const supportsInvert = (runner) => {
  try {
    return execSync(`${runner.command} --help`, {
      cwd: ROOT,
      encoding: 'utf8',
    }).includes(runner.invertFlag);
  } catch {
    return true;
  }
};

/**
 * The selection keeps only specs on disk: an amber nightly's flaky spec that
 * was renamed or deleted since would otherwise be run, be absent from the
 * report, and fail the step. An empty listing (no selector) keeps it as is.
 */
export function onDisk(selected, specNames) {
  return specNames.length === 0
    ? selected
    : selected.filter((f) => specNames.includes(f));
}

/**
 * The newest nightly record and every record, read through the pack's `nightly` hook
 * (`read() -> { latest, history }`). No hook, or a hook that throws, is no record.
 */
async function nightlyRecords(suite, gate) {
  try {
    const { packHook } = await import('../pack-hooks.mjs');
    const got = await packHook('nightly', gate)?.read?.();
    if (!got) return { nightly: null, runs: [] };
    const nightly = got.latest ? recordOf(got.latest, suite) : null;
    const runs = [
      ...(got.history ?? []).map((r) => recordOf(r, suite)),
      ...(nightly ? [nightly] : []),
    ];
    return { nightly, runs };
  } catch {
    return { nightly: null, runs: [] };
  }
}

/**
 * Everything the step needs to be planned and judged. Any failure of the selector is data: the
 * mode falls back to `full` with the reason, never an error. `opts` = { selection, suite, full,
 * runFrom, gate? } (`gate` replaces the project gate when looking up the nightly hook).
 */
export async function planE2e(
  paths,
  baseSha,
  { flag, nowMs, fresh, state },
  opts,
) {
  const { selection: config, suite, full, runFrom } = opts;
  const { runner } = config;
  const setup = config.specs.setup;
  const { nightly, runs } = await nightlyRecords(suite, opts.gate);
  let selection;
  let selectorError = null;
  let sel = null;
  try {
    sel = await loadSelector(baseSha, config);
    selection = sel.select({
      root: ROOT,
      changed: paths,
      readBase: sel.readBase,
      nightly,
      graph: sel.graph,
      config,
    });
  } catch (e) {
    selectorError = `selector: ${e.message}`;
    selection = { mode: 'full', why: selectorError, specs: [], areas: [] };
  }
  const { mode, why } = chooseE2eMode({ selection, nightly, flag, nowMs });
  let specNames = [];
  let inputs = new Map();
  if (sel) {
    try {
      specNames = sel.specs();
      inputs = specInputs({
        changed: paths,
        specs: specNames,
        selectOne: (p) =>
          sel.select({
            root: ROOT,
            changed: [p],
            readBase: sel.readBase,
            graph: sel.graph,
            config,
          }),
      });
    } catch {
      specNames = [];
      inputs = new Map();
    }
  }
  const selected = onDisk(
    selection.mode === 'affected' ? [...selection.specs] : [],
    specNames,
  );
  const knownRed = knownRedOf({
    runs,
    baseSha,
    isAncestor: isAncestorOf(baseSha),
    branch: branchName(),
    selected,
  });
  const { specDigest } = await import('../digest.mjs');
  const { SPEC_LEDGER, readLedger } = await import('../ledger.mjs');
  const digestOf = (file, inp) => specDigest(file, inp, { state });
  const alwaysRun = new Set(
    nightly?.status === 'amber' ? (nightly.flakySpecs ?? []) : [],
  );
  const planned = planSpecs({
    selected: mode === 'affected' ? selected : [],
    inputs,
    digestOf,
    specLedger: readLedger(SPEC_LEDGER),
    fresh,
    alwaysRun,
  });
  const run =
    mode === 'affected'
      ? planned.run
      : specNames.filter((f) => !knownRed.includes(f));
  const reused = mode === 'affected' ? planned.reused : [];

  let cmd = full;
  let prepare;
  if (mode === 'affected') {
    cmd = `${runner.command} --test-list ${runFrom}/.turbo/e2e-selection.txt`;
    prepare = () =>
      writeList(
        E2E_LIST,
        affectedListLines(runner.list(ROOT), { run, knownRed, setup }),
      );
  } else if (knownRed.length > 0) {
    const invert = supportsInvert(runner);
    cmd = invert
      ? `${runner.command} --test-list-invert ${runFrom}/.turbo/e2e-known-red.txt`
      : `${runner.command} --test-list ${runFrom}/.turbo/e2e-selection.txt`;
    prepare = () =>
      invert
        ? writeList(E2E_KNOWN_RED, knownRedLines(runner.list(ROOT), knownRed))
        : writeList(E2E_LIST, fullListLines(runner.list(ROOT), knownRed));
  }
  return {
    mode,
    why,
    nightly,
    selection,
    selectorError,
    selected,
    knownRed,
    run,
    reused,
    digests: planned.digests,
    inputs,
    cmd,
    prepare,
    setup,
    checkedAt: new Date(nowMs).toISOString(),
  };
}

export const e2eDryLine = (p) =>
  `e2e: ${p.mode} (${p.why}); run ${p.mode === 'affected' ? p.run.length : 'all'}, reuse ${p.reused.length}, known red ${p.knownRed.length}`;

/**
 * The receipt's `shadow`: null unless the step (`opts.id`) ran, else
 * shadowOf(selection, report, opts.selection).
 */
export async function finishShadow(plan, results, opts) {
  const e2e = results.find((r) => r.id === opts.id);
  if (!plan || !e2e || !['pass', 'fail'].includes(e2e.status)) return null;
  if (plan.error)
    return {
      mode: 'unknown',
      why: plan.error,
      selected: [],
      missed: null,
      error: plan.error,
    };
  try {
    let report = null;
    try {
      report = JSON.parse(readFileSync(E2E_REPORT, 'utf8'));
    } catch {
      report = null;
    }
    return shadowOf(plan.selection, report, opts.selection);
  } catch (e) {
    return {
      mode: plan.selection.mode,
      why: plan.selection.why,
      selected: [...plan.selection.specs],
      missed: null,
      error: `selector: ${e.message}`,
    };
  }
}

export function shadowLine(sh) {
  const missed = sh.error
    ? `unknown (${sh.error})`
    : sh.missed.length === 0
      ? 'none'
      : sh.missed.join(', ');
  return `e2e shadow: ${sh.mode} (${sh.why}); selected ${sh.selected.length} specs; missed: ${missed}`;
}

/**
 * The `units` slot of the step that runs `suite`: `selection` (omitted: the gate's `selection`,
 * read at call time) says what a changed path selects; `full` is the command of a full run;
 * `runFrom` is the path from the runner's working directory to the repo root. `ctx.run` =
 * { e2eFlag, nowMs, fresh, state } is what the CLI adds to the plan ctx. Sel.plan is the full
 * plan (finishE2e, the spec ledger and the shadow read it); the engine reads mode, why, units,
 * cmd, prepare and knownRedCount.
 */
export function nightlyUnits({ selection, suite, full, runFrom = '.' } = {}) {
  if (
    typeof suite !== 'string' ||
    suite === '' ||
    typeof full !== 'string' ||
    full === ''
  )
    throw new Error('nightlyUnits: suite and full are required');
  const optsOf = async () => {
    const config =
      selection ?? (await import('../project.mjs')).GATE.selection;
    if (!config?.runner)
      throw new Error('nightlyUnits: the selection has no test runner');
    return { selection: config, suite, full, runFrom };
  };
  return {
    reaches: async (ctx) =>
      reachesHarness(ctx.paths, ctx.base, await optsOf()),
    select: async (ctx) => {
      const run = ctx.run ?? {};
      const plan = await planE2e(
        ctx.paths,
        ctx.base,
        {
          flag: run.e2eFlag,
          nowMs: run.nowMs ?? Date.now(),
          fresh: run.fresh ?? false,
          state: run.state,
        },
        await optsOf(),
      );
      return {
        mode: plan.mode,
        why: plan.why,
        units:
          plan.mode === 'affected'
            ? [
                ...plan.selected.map((id) => ({
                  id,
                  inputs: plan.inputs.get(id) ?? [],
                })),
                SMOKE,
              ]
            : [],
        cmd: plan.cmd,
        prepare: plan.prepare,
        knownRedCount: plan.knownRed.length,
        plan,
      };
    },
    cmd: (_units, sel) => sel.cmd ?? full,
    nightly: {
      suite,
      reportPath: E2E_REPORT,
      parseFlag: parseE2eFlag,
      dryLine: e2eDryLine,
      finish: finishE2e,
      finishShadow: async (plan, results, o) =>
        finishShadow(plan, results, {
          selection: (await optsOf()).selection,
          ...o,
        }),
      shadowLine,
    },
  };
}
