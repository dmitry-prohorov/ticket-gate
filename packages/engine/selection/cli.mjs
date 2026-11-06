import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { buildGraph, readText } from '../graph/js.mjs';
import { loadTimeUnits } from '../graph/load-time.mjs';
import { SelectionConfigError } from './define.mjs';
import { projectSelection } from './project.mjs';
import { select, specHeaders } from './select.mjs';
import { summarizeReport, testListLines } from '../runners/playwright.mjs';
import { forFiles, forLines, testCounts } from './for.mjs';

// ---------------------------------------------------------------- drift

/** Pages a spec visited outside its header's areas, mapped by the config's `drift.map`. */
export async function driftOf(report, headers, cfg = projectSelection()) {
  if (!cfg.drift)
    throw new SelectionConfigError('selection.drift is required for --drift');
  return cfg.drift.map(summarizeReport(report).navigation, headers);
}

// ---------------------------------------------------------------- CLI

/** `quiet` drops git's stderr (a `git show` of a path the base lacks prints a fatal line). */
function git(root, args, quiet = false) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    ...(quiet ? { stdio: ['ignore', 'pipe', 'ignore'] } : {}),
  });
}

async function driftCli(file, cfg) {
  let report;
  try {
    report = JSON.parse(readFileSync(resolve(cfg.root, file), 'utf8'));
  } catch (e) {
    console.error(
      `${cfg.label}: cannot read ${file} (${e.message}). Run ${cfg.commands.verify} (it writes .turbo/e2e-report.json) or pass a Playwright JSON report.`,
    );
    return 2;
  }
  let drift;
  try {
    drift = await driftOf(report, specHeaders(cfg.root, cfg), cfg);
  } catch (e) {
    if (!(e instanceof SelectionConfigError)) throw e;
    console.error(`${cfg.label}: ${e.message}`);
    return 2;
  }
  for (const d of drift)
    console.log(
      `drift: ${d.file} visited ${d.pathname} (${d.area}) not in its header`,
    );
  console.log(
    drift.length === 0
      ? 'drift: none'
      : `drift: ${drift.length}. Add the area to that spec's // e2e-areas: header, then rerun the gate.`,
  );
  return drift.length === 0 ? 0 : 1;
}

/** Files every shell page evaluates that hold load-time code. */
function loadTimeCli(cfg) {
  const root = cfg.root;
  const g = buildGraph(root, cfg);
  const rows = [];
  let outside = 0;
  for (const f of g.evaluationSet()) {
    const text = readText(root, f);
    if (text === null) continue;
    const n = loadTimeUnits(text, f).filter((u) => u.loadTime).length;
    if (n === 0) continue;
    const shell = g.reach(f).areas.has('*');
    if (!shell) outside += 1;
    rows.push(`${f} ${n}${shell ? ' shell' : ''}`);
  }
  for (const r of rows) console.log(r);
  console.log(
    `load-time: ${rows.length} files in E (${outside} outside the shell closure)`,
  );
  return 0;
}

/** R9: the selection for each of the last n first-parent merges touching apps/web, graph and headers from HEAD. */
function replayCli(rev, count, cfg) {
  const t0 = Date.now();
  const root = cfg.root;
  const merges = git(root, [
    'log',
    '--first-parent',
    '--merges',
    '--reverse',
    `--max-count=${count}`,
    '--format=%h%x09%s',
    `${rev}`,
    '--',
    ...cfg.replayPaths,
  ])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
  // --reverse with --max-count keeps the newest n, printed oldest first.
  const graph = buildGraph(root, cfg);
  let full = 0;
  for (const [sha, subject] of merges) {
    const changed = git(root, [
      'diff',
      '--name-only',
      '--no-renames',
      `${sha}^1`,
      sha,
    ])
      .split('\n')
      .filter(Boolean);
    const readBase = (p) => {
      try {
        return git(root, ['show', `${sha}^1:${p}`], true);
      } catch {
        return null;
      }
    };
    const sel = select({ root, changed, readBase, graph, config: cfg });
    if (sel.mode === 'full') full += 1;
    const gone =
      sel.mode === 'full' && sel.why.includes(': ')
        ? !existsSync(join(root, sel.why.split(': ')[0]))
        : false;
    const title = subject
      .replace(/^Merge pull request /, '')
      .replace(/ from [^/]+\//, ' ');
    console.log(
      `${sha} ${title} -> ${sel.mode}: ${sel.why}${gone ? ' (absent at HEAD)' : ''}`,
    );
  }
  console.log(`full: ${full} of ${merges.length}`);
  console.log(`time: ${Date.now() - t0} ms`);
  return 0;
}

function forCli(forArg, baseArg, budgetArg, base, usage, cfg) {
  const root = cfg.root;
  const files = forArg.slice('--for='.length).split(',').filter(Boolean);
  const budget = budgetArg ? Number(budgetArg.slice('--budget='.length)) : 150;
  if (files.length === 0 || !Number.isInteger(budget) || budget < 1) {
    console.error(
      `${cfg.label}: --for needs files and a positive budget. ${usage}`,
    );
    return 2;
  }
  const rev = baseArg ? baseArg.slice('--base='.length) : base;
  const read = (p) => {
    try {
      return git(root, ['show', `${rev}:${p}`]);
    } catch {
      return null;
    }
  };
  let counts;
  try {
    counts = testCounts(cfg.runner.list(root));
  } catch (e) {
    console.error(
      `${cfg.label}: cannot list tests (${e.message}). Run: ${cfg.runner.command} --list`,
    );
    return 2;
  }
  const result = forFiles({
    root,
    files,
    readBase: read,
    counts,
    budget,
    config: cfg,
  });
  for (const l of forLines(result, budget)) console.log(l);
  return 0;
}

export async function main(argv, cfg = projectSelection()) {
  const root = cfg.root;
  const { baseRef, changedPaths } = await import('../tree.mjs');
  const base = baseRef();
  const readBase = (p) => {
    try {
      return git(root, ['show', `${base}:${p}`]);
    } catch {
      return null;
    }
  };
  const testList = argv.find(
    (a) => a === '--test-list' || a.startsWith('--test-list='),
  );
  const driftArg = argv.find((a) => a.startsWith('--drift='));
  const replayArg = argv.find((a) => a.startsWith('--replay='));
  const countArg = argv.find((a) => a.startsWith('--count='));
  const loadTimeArg = argv.find((a) => a === '--load-time');
  const forArg = argv.find((a) => a.startsWith('--for='));
  const budgetArg = argv.find((a) => a.startsWith('--budget='));
  const baseArg = argv.find((a) => a.startsWith('--base='));
  const unknown = argv.filter(
    (a) =>
      a !== testList &&
      a !== driftArg &&
      a !== replayArg &&
      a !== countArg &&
      a !== loadTimeArg &&
      a !== forArg &&
      a !== budgetArg &&
      a !== baseArg,
  );
  const usage = `Usage: ${cfg.commands.self} [--test-list[=<out>] | --drift=<report.json> | --replay=<rev> --count=<n> | --load-time | --for=<files> [--budget=<tests>] [--base=<rev>]]`;
  if (unknown.length > 0 || (countArg && !replayArg)) {
    console.error(
      `${cfg.label}: unknown argument ${unknown[0] ?? countArg}. ${usage}`,
    );
    return 2;
  }
  const others = [testList, driftArg, replayArg, loadTimeArg].some(Boolean);
  if ((!forArg && (budgetArg || baseArg)) || (forArg && others)) {
    console.error(
      `${cfg.label}: --for stands alone (--budget and --base need it). ${usage}`,
    );
    return 2;
  }
  if (forArg) return forCli(forArg, baseArg, budgetArg, base, usage, cfg);
  if (loadTimeArg) return loadTimeCli(cfg);
  if (driftArg) return driftCli(driftArg.slice('--drift='.length), cfg);
  if (replayArg) {
    const count = countArg ? Number(countArg.slice('--count='.length)) : 19;
    if (!Number.isInteger(count) || count < 1) {
      console.error(
        `${cfg.label}: --count must be a positive integer. ${usage}`,
      );
      return 2;
    }
    return replayCli(replayArg.slice('--replay='.length), count, cfg);
  }
  const t0 = Date.now();
  const selection = select({
    root,
    changed: changedPaths(base),
    readBase,
    config: cfg,
  });
  if (!testList) {
    console.log(`${selection.mode}: ${selection.why} (${Date.now() - t0} ms)`);
    for (const s of selection.specs) console.log(`  ${s}`);
    return 0;
  }
  if (selection.mode === 'full') {
    console.log(`full: ${selection.why}`);
    return 0;
  }
  const out = resolve(
    root,
    testList.split('=')[1] ?? '.turbo/e2e-selection.txt',
  );
  const lines = testListLines(cfg.runner.list(root), selection) ?? [];
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${lines.join('\n')}\n`);
  console.log(
    `${selection.why}; ${lines.length} tests -> ${relative(root, out)}`,
  );
  return 0;
}
