import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { bothNames, envName } from '../env-name.mjs';
import { realIo } from './io.mjs';
import { install } from './launchd.mjs';
import {
  classifyRun,
  mapDrift,
  nightlyDirOf,
  readNightly,
  writeOutputs,
} from './record.mjs';
import {
  RETRY_MS,
  dayOf,
  deadlineFor,
  decide,
  triggerFor,
} from './schedule.mjs';
import {
  readLock,
  readReleased,
  reapStale,
  release,
  tryTake,
} from '../lock.mjs';
import { runRotation } from '../mutations/rotate.mjs';

export const MUTATION_BUDGET_MS = 3_600_000,
  MUTATION_BATCH = 10,
  MUTATION_GRACE_S = 120;
const UP_TO_DATE_MS = 24 * 3_600_000;

// ------------------------------------------------------------------ pure

/** The trimmed non-empty value of `NAME=` in a dotenv text, else null. */
export function envValue(envText, name) {
  const m = new RegExp(`^${name}=(.*)$`, 'm').exec(envText);
  const v = m ? m[1].trim() : '';
  return v === '' ? null : v;
}

// ------------------------------------------------- mutation phase

export {
  compactLedger,
  readLedger,
  rotationOrder,
} from '../mutations/rotate.mjs';

const noPhase = (status, reason, over = {}) => ({
  status,
  reason,
  stoppedBy: null,
  ms: 0,
  live: 0,
  ran: 0,
  killed: 0,
  survived: 0,
  error: 0,
  oldestProofDays: null,
  unproven: 0,
  survivors: [],
  ...over,
});
const phaseError = (e) =>
  noPhase('error', String(e?.message ?? e).slice(0, 200));

export function runMutationPhase(
  io,
  {
    wt,
    holderId,
    budgetMs = MUTATION_BUDGET_MS,
    batch = MUTATION_BATCH,
    command,
    ...rest
  },
) {
  return runRotation(io, {
    ...rest,
    cwd: wt,
    budgetMs,
    batch,
    graceS: MUTATION_GRACE_S,
    command,
    env: bothNames('STACK_LOCK_OWNER', holderId),
  });
}

/** The rotation budget in ms from NIGHTLY_MUTATION_MIN (minutes), or `dflt` when unset, empty or not a number. */
export function envMutationBudgetMs(env, dflt) {
  const raw = envName(env, 'NIGHTLY_MUTATION_MIN');
  return raw !== undefined && raw !== '' && Number.isFinite(Number(raw))
    ? Number(raw) * 60_000
    : dflt;
}

// ---------------------------------------------------------------- the run

const SUITE_BASE = {
  status: 'error',
  reason: null,
  reachedPlaywright: false,
  stats: null,
  redSpecs: [],
  flakySpecs: [],
  report: null,
};

/** Run once. Resolves with the record, { status: 'up-to-date' } or { status: 'aborted' }. */
export async function runNightly(
  io,
  { now: force = false, mutationBudgetMs, mutationBatch, config } = {},
) {
  if (config === undefined)
    throw new TypeError('runNightly: a nightly config is required');
  const dir = nightlyDirOf(io);
  const lock = io.lockPath;
  const startMs = io.now();
  const trigger = triggerFor(startMs, undefined, config.window);
  const deadlineMs = deadlineFor(trigger, startMs, undefined, config.window);
  const base = (over) => ({
    v: 1,
    sha: '',
    ranAt: new Date(startMs).toISOString(),
    endedAt: '',
    ms: 0,
    trigger,
    status: 'error',
    reason: null,
    reachedPlaywright: false,
    stats: null,
    redSpecs: [],
    flakySpecs: [],
    report: null,
    finalReset: null,
    mutations: null,
    ...over,
  });
  const record = (over, redTests = [], first = null, suiteReports = {}) => {
    const endMs = io.now();
    const line = base({
      ...over,
      endedAt: new Date(endMs).toISOString(),
      ms: endMs - startMs,
    });
    writeOutputs(dir, line, redTests, first, suiteReports, config.suites);
    io.log(`nightly: ${line.status}${line.reason ? ` (${line.reason})` : ''}`);
    return line;
  };

  // (1) wait for an idle stack
  for (;;) {
    reapStale(lock, { now: io.now, alive: io.alive });
    const holder = readLock(lock, { now: io.now });
    const released = readReleased(lock);
    if (force) {
      if (holder !== null) {
        io.log(
          `nightly: stack lock is held (${holder.owner}, pid ${holder.pid}); not overriding. Try again when it is free.`,
        );
        return { status: 'aborted' };
      }
    } else {
      const d = decide({ holder, released, nowMs: io.now(), deadlineMs });
      if (d === 'skipped-busy') return record({ status: 'skipped-busy' });
      if (d === 'defer') {
        await io.sleep(RETRY_MS);
        continue;
      }
    }
    // (2) take it
    const got = tryTake(lock, {
      owner: 'nightly',
      cwd: io.mainCheckout,
      now: io.now,
      alive: io.alive,
      env: {},
    });
    if (got.ok) return withLock(got.holder);
    if (force) return { status: 'aborted' };
  }

  async function withLock(holder) {
    try {
      io.caffeinate(process.pid);
      return await body(holder);
    } finally {
      release(lock, holder, { now: io.now });
    }
  }

  async function body(holder) {
    let sha = '';
    const finish = (over, ...rest) => record({ sha, ...over }, ...rest);
    const fail = (reason) => finish({ status: 'error', reason });
    const main = io.mainCheckout;
    const payloads = config.payloads;
    // (3) payload preflights: before anything is fetched or built
    for (const p of payloads) {
      const pf = await p.preflight(main, io);
      if (pf.reason) return fail(pf.reason);
    }
    // (4)
    const { name: remote, branch } = config.remote;
    const fetched = await io.run('git', ['fetch', remote, branch], {
      cwd: main,
      limitS: 300,
    });
    if (fetched.code !== 0) return fail('fetch-failed');
    const rev = await io.run('git', ['rev-parse', `${remote}/${branch}`], {
      cwd: main,
      limitS: 30,
    });
    sha = rev.out.trim();
    if (rev.code !== 0 || !/^[0-9a-f]{40}$/.test(sha))
      return fail('fetch-failed');
    const last = readNightly(dir).history.at(-1);
    if (
      !force &&
      last?.sha === sha &&
      last.reachedPlaywright === true &&
      startMs - Date.parse(last.ranAt) < UP_TO_DATE_MS
    ) {
      io.log(
        `nightly: ${sha.slice(0, 12)} already ran at ${last.ranAt}; up to date`,
      );
      return { status: 'up-to-date', sha };
    }

    // (5) the worktree
    const sha12 = sha.slice(0, 12);
    const day = dayOf(startMs);
    const tree = config.worktree;
    const root = join(io.tmpdir, tree.dir);
    const wt = join(root, sha12);
    const marker = join(wt, `.${tree.dir}-ready`);
    if (existsSync(root))
      for (const f of readdirSync(root))
        if (f !== sha12) {
          const old = join(root, f);
          await io.run('git', ['worktree', 'remove', '--force', old], {
            cwd: main,
            limitS: 120,
          });
          rmSync(old, { recursive: true, force: true });
        }
    if (!io.exists(marker)) {
      if (io.exists(wt)) {
        io.rm(wt);
        await io.run('git', ['worktree', 'prune'], { cwd: main, limitS: 60 });
      }
      const add = await io.run(
        'git',
        ['worktree', 'add', '--detach', wt, sha],
        { cwd: main, limitS: 300 },
      );
      if (add.code !== 0) return fail('worktree-failed');
      const install = await io.run(tree.install[0], tree.install.slice(1), {
        cwd: wt,
        limitS: 900,
      });
      if (install.code !== 0) return fail('install-failed');
      for (const argv of tree.prepare ?? []) {
        const step = await io.run(argv[0], argv.slice(1), {
          cwd: wt,
          limitS: 600,
        });
        if (step.code !== 0) return fail('install-failed');
      }
      io.writeFile(marker, `${sha}\n`);
    }

    // (6) env files: the main checkout's, copied as is; secrets in them are never logged
    for (const e of tree.env ?? []) {
      const src = join(main, e.path);
      if (!io.exists(src) && e.require === undefined) return fail(e.reason);
      const text = io.exists(src) ? io.readFile(src) : '';
      if (e.require !== undefined) {
        const value = envValue(text, e.require);
        if (value === null) return fail(e.reason);
      }
      io.writeFile(join(wt, e.path), text);
    }

    // (7) payload befores: the stack must be up (the nightly never starts it) and reset
    let over = null;
    let runAfter = true;
    for (const p of payloads) {
      if (!p.before) continue;
      const b = await p.before(wt, io);
      if (b.ok === true) continue;
      over = { status: 'error', reason: b.reason };
      runAfter = b.runAfter === true;
      break;
    }
    const runAfters = async () => {
      const withAfter = payloads.filter((p) => p.after);
      if (withAfter.length === 0) return null;
      let result = 'pass';
      for (const p of withAfter)
        if ((await p.after(main, io)) !== 'pass') result = 'fail';
      return result;
    };

    // (8) the suites, in config order, each at its own limit
    const suites = {};
    const suiteReports = {};
    let first = null;
    let firstMs = null;
    if (over === null)
      for (const [i, suite] of config.suites.entries()) {
        const out = join(
          io.tmpdir,
          i === 0
            ? `${tree.dir}-${sha12}.pw.json`
            : `${tree.dir}-${sha12}-${suite.name}.pw.json`,
        );
        const sdir = join(dir, suite.name, `${sha12}-${day}`);
        const t0 = io.now();
        const res = await suite.runner.run({
          wt,
          io,
          args: suite.args ?? [],
          limitS: suite.limitS,
          env: bothNames('STACK_LOCK_OWNER', holder.id),
          out,
          dir: sdir,
        });
        const ms = io.now() - t0;
        const summary = res.timedOut ? null : (res.summary ?? null);
        const s = summary?.stats;
        let stop = null;
        if (res.timedOut) stop = { status: 'error', reason: 'cut-short' };
        else if (!s) stop = { status: 'error', reason: 'no-report' };
        else if (s.expected + s.unexpected + s.flaky + s.skipped === 0)
          stop = { status: 'error', reason: 'zero-tests' };
        if (i === 0) {
          firstMs = ms;
          first = { summary, report: res.report ?? null };
          over = stop;
          continue;
        }
        const c =
          stop ??
          classifyRun({
            summary,
            reason: null,
            history: readNightly(dir).history,
            suite: suite.name,
          });
        const relReport = `${suite.name}/${sha12}-${day}/report.json`;
        suites[suite.name] = {
          ...SUITE_BASE,
          status: c.status,
          reason: c.reason,
          ...(stop === null
            ? {
                reachedPlaywright: true,
                stats: summary.stats,
                redSpecs: c.redSpecs,
                flakySpecs: c.flakySpecs,
                report: relReport,
              }
            : {}),
          ms,
          ...(res.extra !== undefined ? { extra: res.extra } : {}),
        };
        if (stop === null) suiteReports[suite.name] = res.report ?? null;
      }
    const suitesPart = {
      ...(Object.keys(suites).length > 0 ? { suites } : {}),
      // the first suite's own time, so a later suite does not count toward it
      ...(firstMs !== null && config.suites.length > 1 ? { firstMs } : {}),
    };

    // (8b) rotate registry mutations while the stack and lock are ours
    let mutations = null;
    if (over === null) {
      const budget =
        mutationBudgetMs ??
        envMutationBudgetMs(process.env, MUTATION_BUDGET_MS);
      if (budget <= 0 || !config.rotate)
        mutations = noPhase('skipped', 'disabled');
      else if (trigger !== 'scheduled' && !force)
        mutations = noPhase('skipped', 'catch-up');
      else {
        mutations = await runMutationPhase(io, {
          dir,
          wt,
          sha,
          holderId: holder.id,
          command: config.rotate.command,
          startMs: io.now(),
          deadlineMs,
          budgetMs: budget,
          batch: mutationBatch ?? MUTATION_BATCH,
        }).catch((e) => phaseError(e));
        // a killed mutation must not poison tomorrow's worktree
        const dirty = await io.run('git', ['status', '--porcelain'], {
          cwd: wt,
          limitS: 60,
        });
        if (dirty.code !== 0 || dirty.out.trim() !== '') io.rm(marker);
      }
    }

    // (9) payload afters: leave the stack seeded for the main checkout
    const finalReset = runAfter ? await runAfters() : null;

    // (10) record
    if (over !== null)
      return finish(
        { ...over, finalReset, ...suitesPart },
        [],
        null,
        suiteReports,
      );
    const { summary } = first;
    let drift = [];
    try {
      drift = config.drift
        ? mapDrift(summary.navigation, config.drift.headers(wt), config.drift)
        : [];
    } catch {
      drift = [];
    }
    const c = classifyRun({
      summary,
      reason: null,
      history: readNightly(dir).history,
      drift,
    });
    return record(
      {
        sha,
        status: c.status,
        reason: c.reason,
        reachedPlaywright: true,
        stats: summary.stats,
        redSpecs: c.redSpecs,
        flakySpecs: c.flakySpecs,
        ...(c.drift ? { drift: c.drift } : {}),
        report: `${sha12}-${day}.json`,
        finalReset,
        mutations,
        ...suitesPart,
      },
      summary.redTests,
      first.report,
      suiteReports,
    );
  }
}

export async function main(argv, config, io = realIo()) {
  const known = ['--now', '--install'];
  const { run, install: inst } = config.commands;
  if (argv.length > 1 || argv.some((a) => !known.includes(a))) {
    console.error(`usage: ${run} [--now]   |   ${inst}`);
    return 2;
  }
  if (argv[0] === '--install') {
    return install(io, config) ?? 0;
  }
  const r = await runNightly(io, { now: argv[0] === '--now', config });
  return r.status === 'aborted' ? 1 : 0;
}
