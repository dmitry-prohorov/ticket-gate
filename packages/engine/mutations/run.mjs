import { patchKey } from './served.mjs';
import { localHarness, sessionOf } from './harness.mjs';
import { projectSetup } from './project.mjs';
import { tail, zeroResult, zeroTestRun } from './verdict.mjs';

// A rebuild rule matches a patch under its files whose test does not already build.
export const ruleMatches = (rule, m) =>
  m.kind === 'patch' &&
  m.file.startsWith(rule.files) &&
  !rule.unlessTest.test(m.test);

/**
 * A patch a rebuild rule covers (today: packages/core/src whose test is not a
 * core-package command). Other packages resolve it through its build output,
 * so they never see the patched source until it is rebuilt.
 */
export const needsCoreBuild = (m, setup = projectSetup()) =>
  setup.rebuild.some((rule) => ruleMatches(rule, m));

/** The first deferral the setup's harnesses declare. */
const deferOf = (setup) => setup.harnesses.find((h) => h.defer)?.defer;

const redText = (base) =>
  `test red before mutation: fix the test or its command first (${tail(base.out)})`;

/**
 * Runs the mutations. `io` is injected so tests need no shell, pnpm or stack.
 * `io.only` (array of ids) restricts the run; `io.state` (optional object) is
 * kept current so a signal handler can restore the in-flight mutation.
 * Every entry runs in the session of the kind or harness that claims it:
 * refuse -> inline open -> rebuild -> inline baselines and loop -> settle ->
 * close -> grouped sessions by order (precheck, open, group, run, close). A
 * reset that cannot reproduce the baseline is fatal (`report.fatal`).
 */
export async function runMutations(spec, io, setup = projectSetup()) {
  const state = io.state ?? {};
  const todo = io.only
    ? spec.mutations.filter((m) => io.only.includes(m.id))
    : spec.mutations;
  const partial = todo.length !== spec.mutations.length;
  const sessionFor = new Map(todo.map((m) => [m, sessionOf(m, setup)]));
  const entriesOf = new Map();
  for (const m of todo) {
    const s = sessionFor.get(m);
    if (!s) throw new Error(`mutations config: ${m.id} has no session`);
    if (!entriesOf.has(s)) entriesOf.set(s, []);
    entriesOf.get(s).push(m);
  }
  const sessions = [...entriesOf.keys()].sort((a, b) => a.order - b.order);
  const stop = (extra) => ({
    results: [],
    ok: false,
    partial,
    rerun: 0,
    ...extra,
  });
  for (const s of sessions) {
    const refused = await s.refuse?.(entriesOf.get(s), io);
    if (refused) return stop({ refused });
  }
  const inline = sessions.filter((s) => s.inline);
  for (const s of inline) {
    const o = await s.open?.(entriesOf.get(s), io, state);
    if (o?.fatal) return stop({ fatal: o.fatal });
  }
  for (const rule of setup.rebuild) {
    if (!todo.some((m) => ruleMatches(rule, m))) continue;
    // A signal mid-build leaves the output half-written; interruptHandler rebuilds while set.
    state[rule.flag] = true;
    const b = await io[rule.io]();
    if (b.code !== 0)
      return stop({
        fatal: `${rule.cmd} failed before the baselines: ${tail(b.out)}`,
      });
    state[rule.flag] = false;
  }
  // The engine baselines the inline sessions it owns (local, and kind sessions such as
  // sql); an inline harness a pack adds measures its own baseline inside runOne.
  const ownBaseline = (s) => s === localHarness || !setup.harnesses.includes(s);
  const plain = todo.filter((m) => sessionFor.get(m).inline);
  const extra = inline.flatMap((s) => (s.zeroTests ? [s.zeroTests] : []));
  const baseline = new Map();
  for (const m of plain) {
    if (!ownBaseline(sessionFor.get(m)) || baseline.has(m.test)) continue;
    let r;
    try {
      r = await io.run(m.test);
    } catch (err) {
      r = { code: 1, out: String(err) };
    }
    baseline.set(m.test, { ...r, zero: zeroTestRun(m.test, r.out, extra) });
  }

  const ctx = {
    fatal: null,
    setup,
    // Re-runs one entry through its own session (the pollution re-run of a killed patch).
    runOne: (m) => sessionFor.get(m).runOne(m, io, state, ctx),
    rulesFor: (m) => setup.rebuild.filter((rule) => ruleMatches(rule, m)),
  };
  let results = [];
  for (const m of plain) {
    const base = baseline.get(m.test);
    if (!ownBaseline(sessionFor.get(m))) {
      results.push(await sessionFor.get(m).runOne(m, io, state, ctx));
      if (ctx.fatal) break;
      continue;
    }
    if (base.zero) {
      results.push(zeroResult(m, base.zero, 'before the mutation'));
      continue;
    }
    if (base.code !== 0) {
      results.push({ id: m.id, status: 'error', detail: redText(base) });
      continue;
    }
    results.push(await sessionFor.get(m).runOne(m, io, state, ctx));
    if (ctx.fatal) break;
  }
  let rerun = 0;
  const inlineEntries = inline.flatMap((x) => entriesOf.get(x));
  for (const s of inline) {
    if (ctx.fatal) break;
    if (s.settle) {
      const r = await s.settle(results, inlineEntries, io, state, ctx);
      results = r.results;
      rerun += r.rerun;
    }
    if (!ctx.fatal && s.close)
      ctx.fatal = (await s.close(io, state, ctx)).fatal ?? null;
  }
  let groups;
  let builds;
  let serveFatal;
  const tally = (r) => {
    if (r.groups) groups = [...(groups ?? []), ...r.groups];
    if (r.builds !== undefined) builds = (builds ?? 0) + r.builds;
  };
  const emit = (r, group) =>
    results.push(group === undefined ? r : { ...r, group });
  for (const session of sessions.filter((x) => !x.inline)) {
    if (ctx.fatal || serveFatal) break;
    let entries = entriesOf.get(session);
    // A patch that cannot compile can never pass the build: report it before the clean build.
    if (session.precheck) {
      const tc = await session.precheck(entries, io);
      const compiles = (m) => tc.get(patchKey(m))?.ok !== false;
      for (const m of entries.filter((x) => !compiles(x)))
        results.push({
          id: m.id,
          status: 'error',
          detail: `typecheck: ${tc.get(patchKey(m)).line}`,
        });
      entries = entries.filter(compiles);
    }
    const opened = (await session.open?.(entries, io, state)) ?? {};
    tally(opened);
    if (opened.fatal) {
      serveFatal = opened.fatal;
      break;
    }
    const zeros = session.zeroTests ? [session.zeroTests] : [];
    const ready = [];
    for (const m of entries) {
      const base = opened.baselines?.get(m.test);
      const zero = base && zeroTestRun(m.test, base.out, zeros);
      if (zero) results.push(zeroResult(m, zero, 'before the mutation'));
      else if (base && base.code !== 0)
        results.push({ id: m.id, status: 'error', detail: redText(base) });
      else ready.push(m);
    }
    if (ready.length > 0) {
      const grouped = session.group(ready, opened);
      const ran = await session.run(grouped, io, emit, state, ctx);
      tally(ran);
      if (ran.fatal) ctx.fatal = ran.fatal;
    }
    if (session.close) {
      const closed = await session.close(io, state, ctx);
      if (closed?.fatal) ctx.fatal = closed.fatal;
    }
  }
  state.restore = null;
  state.sqlApplied = false;
  const ok =
    !ctx.fatal &&
    !serveFatal &&
    !partial &&
    results.length > 0 &&
    results.every((r) => r.status === 'killed');
  const report = { results, ok, partial, rerun };
  if (groups) Object.assign(report, { groups, builds });
  if (serveFatal)
    Object.assign(report, { fatal: serveFatal, ok: false, serveFatal: true });
  if (ctx.fatal) report.fatal = ctx.fatal;
  return report;
}

/** SIGINT or SIGTERM: stop a server, put back every patched file, reset what a sql mutation left, rebuild what a patch built. */
export async function interruptHandler(
  state,
  io,
  exit = process.exit,
  signal = 'SIGINT',
  setup = projectSetup(),
) {
  for (const h of setup.harnesses) {
    try {
      await h.interrupt?.(state, io, setup);
    } catch {
      /* best effort */
    }
  }
  try {
    state.restore?.();
  } catch {
    /* best effort */
  }
  for (const kind of setup.kinds.values())
    await kind.session?.interrupt?.(state, io, setup);
  // A patch built into its output: rebuild so the output matches the restored source.
  for (const rule of setup.rebuild)
    if (state[rule.flag] && (await io[rule.io]()).code !== 0)
      console.error(`run ${rule.cmd}`);
  exit(signal === 'SIGTERM' ? 143 : 130);
}

/** Exit code for a finished run (tree check excluded). */
export const exitCodeFor = (report) =>
  report.results.length > 0 &&
  report.results.every((r) => r.status === 'killed') &&
  !report.partial
    ? 0
    : 1;

/** What main does after the run: exit code, and whether a receipt is written. */
export function finalOutcome(report, changedPaths) {
  if (report.fatal) return { code: 1, writeReceipt: false };
  if (changedPaths.length > 0) return { code: 1, writeReceipt: false };
  return { code: exitCodeFor(report), writeReceipt: true };
}

/** The line the ticket gate prints for the entries it left to the nightly rotation. */
export const deferredLine = (keys, defer = deferOf(projectSetup())) =>
  `mutate:check deferred: ${keys.length} ${defer.label} ${keys.length === 1 ? 'entry' : 'entries'} left to ${defer.to}: ${keys.join(', ')}`;

export function summaryLine(ticket, results, rerun = 0, builds) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const base = `mutate:check ${ticket}: ${n('killed')}/${results.length} killed, ${n('survived')} survived, ${n('error')} error`;
  const line = rerun > 0 ? `${base}, ${rerun} re-run after pollution` : base;
  return builds === undefined ? line : `${line}, ${builds} builds`;
}
