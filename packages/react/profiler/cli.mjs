// The profiler run loop and its binding to one project config. Every project
// value (scenarios, urls, build command, login, reset) arrives in `cfg`; see the shim
// that calls `profiler(cfg)` for the shape.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeOrExit } from '#engine/lock.mjs';
import { serve } from '#engine/serve.mjs';
import { captureRun, openContext, resolveChromium } from './capture.mjs';
import {
  SETUP_MISSING,
  applyBudget,
  budgetFailures,
  compare,
  parseArgs,
  parseBudgets,
  scenarioRenders,
  setupDiff,
} from './stats.mjs';
import {
  analyse,
  median,
  problemHints,
  reduceRun,
  traceProblem,
} from './trace.mjs';

/** Every problem at once, [] when ready. `probe(url)` resolves to a boolean; `hasEnv()` says whether the app env exists. */
export async function preflight({ build }, cfg, probe, hasEnv) {
  const [appUp, ...up] = await Promise.all([
    probe(cfg.appUrl),
    ...cfg.services.map((s) => probe(s.url)),
  ]);
  const problems = [];
  if (build && appUp) problems.push(cfg.preflight.portInUse);
  if (!build && !appUp) problems.push(cfg.preflight.noApp);
  cfg.services.forEach((s, i) => {
    if (!up[i]) problems.push(s.problem);
  });
  if (!hasEnv()) problems.push(cfg.preflight.noWebEnv);
  return problems;
}

export function loadBaseline(path) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `--compare ${path}: cannot read it as JSON (${err.message})`,
    );
  }
  if (typeof baseline?.summary !== 'object' || baseline.summary === null)
    throw new Error(
      `--compare ${path}: not a results file (no "summary" object)`,
    );
  return baseline;
}

function gitOut(cfg, args) {
  return execSync(`git ${args}`, { cwd: cfg.root }).toString().trim();
}

export async function run(cfg, argv) {
  // Refuses at once while another run holds the stack.
  if (cfg.lock !== false) takeOrExit(cfg.lock);
  const hints = problemHints(cfg);
  const opts = parseArgs(argv, cfg);
  const baseline = opts.compare === null ? null : loadBaseline(opts.compare);
  const problems = await preflight(
    { build: opts.build },
    cfg,
    cfg.probe,
    cfg.hasEnv,
  );
  if (problems.length > 0) throw new Error(problems.join('\n'));
  mkdirSync(join(opts.out, 'traces'), { recursive: true });

  const results = {};
  let chromiumVersion = '';
  let stopServer = null;
  const onSigint = async () => {
    if (stopServer !== null) await stopServer();
    process.exit(130);
  };
  try {
    if (opts.build) {
      await serve(
        {
          build: cfg.build.command,
          start: cfg.build.start,
          port: cfg.build.port,
          env: cfg.build.env,
        },
        {
          onSpawn: (stop) => {
            stopServer = stop;
            process.once('SIGINT', onSigint);
          },
        },
      );
    }
    const chromium = resolveChromium(cfg.playwrightFrom);
    const browser = await chromium.launch({ handleSIGINT: false });
    chromiumVersion = browser.version();
    try {
      for (const sc of opts.scenarios) {
        results[sc] = [];
        for (let run = 0; run <= opts.runs; run++) {
          if (cfg.writing.includes(sc) || run === 0) await cfg.reset();
          const { context, page } = await openContext(browser, cfg.context);
          await cfg.open(page);
          const act = await cfg.scenarios[sc](page);
          const file = join(
            opts.out,
            'traces',
            `${cfg.tracePrefix}${sc}-run${run}.json`,
          );
          await captureRun(browser, page, act, file);
          await context.close();
          const r = reduceRun(
            JSON.parse(readFileSync(file, 'utf8')),
            cfg.componentsFor(sc),
            hints,
          );
          console.log(
            `${sc} ${run === 0 ? 'warm-up' : `run ${run}`} ${JSON.stringify(r)}`,
          );
          if (run > 0) results[sc].push(r);
        }
      }
    } finally {
      await browser.close();
      await cfg.reset();
    }
  } finally {
    if (stopServer !== null) {
      await stopServer();
      process.removeListener('SIGINT', onSigint);
    }
  }

  const summary = {};
  for (const [sc, list] of Object.entries(results))
    summary[sc] = Object.fromEntries(
      Object.keys(list[0]).map((k) => [k, median(list.map((r) => r[k]))]),
    );
  const meta = {
    sha: gitOut(cfg, 'rev-parse HEAD'),
    dirty: gitOut(cfg, 'status --porcelain') !== '',
    buildFlags: opts.build ? cfg.build.command : cfg.build.noBuildLabel,
    chromium: chromiumVersion,
    runs: opts.runs,
    scenarios: opts.scenarios,
    date: new Date().toISOString(),
  };
  const file = join(opts.out, `results-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ meta, results, summary }, null, 2));
  console.log(`median of ${opts.runs}:`);
  console.table(summary);
  console.log(`traces and results: ${opts.out}`);
  if (baseline !== null) {
    console.log('this run:', meta);
    console.log('baseline:', baseline.meta ?? '(no setup record)');
    for (const line of setupDiff(meta, baseline.meta))
      console.log(`setup differs: ${line}`);
    console.table(compare(summary, baseline));
  }
  const { lines, code } = applyBudget(
    summary,
    opts.maxRenders,
    cfg.componentsFor,
  );
  for (const line of lines) console.error(line);
  if (code !== 0) process.exitCode = code;
}

/** Binds the module-level functions to one config; the shim re-exports these names. */
export function profiler(cfg) {
  const firstScenario = Object.keys(cfg.scenarios)[0];
  const first = cfg.componentsFor(firstScenario);
  const hints = problemHints(cfg);
  return {
    PROBLEM: hints,
    PREFLIGHT: cfg.preflight,
    SETUP_MISSING,
    analyse: (trace, names = first) => analyse(trace, names),
    traceProblem: (r, names = first) => traceProblem(r, names, hints),
    reduceRun: (trace, scenario = firstScenario) =>
      reduceRun(trace, cfg.componentsFor(scenario), hints),
    median,
    compare,
    setupDiff,
    parseBudgets: (text) => parseBudgets(text, cfg),
    parseArgs: (argv) => parseArgs(argv, cfg),
    budgetFailures: (summary, budgets) =>
      budgetFailures(summary, budgets, cfg.componentsFor),
    applyBudget: (summary, budgets) =>
      applyBudget(summary, budgets, cfg.componentsFor),
    scenarioRenders: (row, scenario) =>
      scenarioRenders(row, scenario, cfg.componentsFor),
    preflight: ({ build }, probe = cfg.probe, hasEnv = cfg.hasEnv) =>
      preflight({ build }, cfg, probe, hasEnv),
    run: (argv) => run(cfg, argv),
  };
}
