import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gateLock } from './lock.mjs';
import {
  HISTORY,
  LEDGER,
  SPEC_LEDGER,
  appendHistory,
  appendLedger,
  appendSpecLedger,
  fullMedianLine,
  ledgerLines,
  readLedger,
  seedHistory,
  specLedgerLines,
} from './ledger.mjs';
import { RECEIPT, buildReceipt, receiptOk } from './receipt.mjs';
import { renderSummary } from './summary.mjs';
import {
  reviewMap,
  renderMarkdown,
  renderSizeLine,
  writeMap,
} from './review-map.mjs';
import { FAILURES_REL, writeFailures } from './failures.mjs';
import { moveProof as moveProofOf } from './move-proof.mjs';
import { inputState, specDigest, stepDigest } from './digest.mjs';
import { ROOT } from './root.mjs';
import { baseRef, changedPaths, treeHash } from './tree.mjs';
import { STEP_IDS, STEP_LIMITS, buildResults, runInShell } from './run.mjs';
import { commandsOf } from './config.mjs';
import { GATE } from './project.mjs';
import { planCtx, planSteps, selectUnits } from './plan.mjs';
import { packHook, packHookAsync } from './pack-hooks.mjs';
import { runPrecheck } from './precheck.mjs';

const FAILURES = join(ROOT, FAILURES_REL);

/** `--timeout=<id>:<sec>` (repeatable). `limits` is STEP_LIMITS with the overrides applied. */
export function parseTimeouts(args) {
  const limits = { ...STEP_LIMITS };
  const overridden = new Set();
  for (const arg of args.filter((a) => a.startsWith('--timeout='))) {
    const value = arg.slice('--timeout='.length);
    const at = value.indexOf(':');
    const id = at < 0 ? value : value.slice(0, at);
    const sec = at < 0 ? '' : value.slice(at + 1);
    if (!(id in STEP_LIMITS))
      return {
        limits,
        overridden,
        error: `unknown step id "${id}" in ${arg}. Valid ids: ${Object.keys(STEP_LIMITS).join(', ')}.`,
      };
    if (!/^[1-9]\d*$/.test(sec))
      return {
        limits,
        overridden,
        error: `"${sec}" in ${arg} is not a whole number of seconds. Use --timeout=<id>:<sec>, for example --timeout=e2e:2400.`,
      };
    limits[id] = Number(sec);
    overridden.add(id);
  }
  return { limits, overridden, error: null };
}

// ---------------------------------------------------------------- e2e

const PRECHECK_FLAGS = ['--precheck', '--base=', '--ticket='];

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes('--dry-run');
  const skipIds = args
    .filter((a) => a.startsWith('--skip='))
    .flatMap((a) => a.slice('--skip='.length).split(','))
    .filter(Boolean);
  const timeouts = parseTimeouts(args);
  if (timeouts.error) {
    console.error(`verify:ticket: ${timeouts.error}`);
    process.exit(2);
  }
  const mapArg = args
    .find((a) => a.startsWith('--review-map='))
    ?.slice('--review-map='.length);
  if (mapArg !== undefined && mapArg !== 'full') {
    console.error(
      `verify:ticket: unknown --review-map value "${mapArg}". Only --review-map=full is valid (omit the flag for the count line).`,
    );
    process.exit(2);
  }
  const machine = mapArg === 'full' ? 'full' : 'count';
  // Pack hooks (pack-hooks.mjs): a missing one means no pack does that.
  const e2eHook = (await packHookAsync('e2e')) ?? {};
  const registryHook = packHook('registry') ?? {};
  const nightlyHook = packHook('nightly');
  const e2eFlag = e2eHook.parseFlag?.(args) ?? {};
  if (e2eFlag.error) {
    console.error(`verify:ticket: ${e2eFlag.error}`);
    process.exit(2);
  }
  const baseArg = args
    .find((a) => a.startsWith('--base='))
    ?.slice('--base='.length);
  const base = baseArg ?? baseRef(GATE.base);
  const baseSha = execFileSync('git', ['rev-parse', base], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();

  const paths = changedPaths(base);
  if (args.includes('--precheck')) {
    const stray = args.find(
      (a) => !PRECHECK_FLAGS.some((f) => a === f || a.startsWith(f)),
    );
    if (stray) {
      console.error(
        `verify:ticket: --precheck accepts only --base= and --ticket=, not ${stray}. Run the precheck alone, or drop --precheck.`,
      );
      process.exit(2);
    }
  }
  // prettier-ignore
  if (args.includes('--precheck')) process.exit(await runPrecheck({ base: baseSha }));
  const map = reviewMap(base);
  writeMap(map);
  const state = inputState({ base: baseSha });
  const fresh = args.includes('--fresh');
  // The selector, the nightly and the spec ledger decide the e2e mode, and
  // only when an e2e input changed (G1, R4): selectUnits runs a units step's selector
  // when its `when` holds or its `reaches` says the diff gets there anyway.
  const units = await selectUnits(GATE, {
    ...planCtx(paths, { base: baseSha }),
    run: { e2eFlag: e2eFlag.flag, nowMs: Date.now(), fresh, state },
  });
  const e2ePlan = units.e2e?.plan ?? null;
  const registry = registryHook.plan?.(baseSha) ?? {
    when: false,
    keys: [],
    deferred: [],
    error: null,
  };
  const { steps, notRun, notSelected, unknown } = planSteps(paths, skipIds, {
    base: baseSha,
    registry: { when: registry.when, count: registry.keys.length },
    digestOf: (id, cmd) => stepDigest(id, cmd, { state }),
    ledger: readLedger(),
    fresh,
    units,
  });

  if (unknown.length) {
    console.error(
      `verify:ticket: unknown --skip id(s): ${unknown.join(', ')}. Valid ids: ${STEP_IDS.join(', ')}.`,
    );
    process.exit(2);
  }

  // One informational line, never a gate; a read error prints and moves on.
  const printNightly = () => {
    try {
      if (nightlyHook) console.log(`nightly: ${nightlyHook.line(Date.now())}`);
    } catch (e) {
      console.log(`nightly: unavailable (${e.message})`);
    }
  };

  const printNotSelected = () => {
    for (const id of notSelected)
      console.log(`NOT SELECTED --skip=${id} (the diff does not select it)`);
  };

  if (dryRun) {
    console.log(`Branch touches ${paths.length} path(s).\n`);
    for (const s of steps) {
      const mode =
        { human: 'HUMAN', skip: 'SKIP ', reuse: 'REUSE' }[s.mode] ?? 'RUN  ';
      const note = s.mode === 'reuse' ? `reused from ${s.reusedFrom}` : s.why;
      console.log(`  ${mode}  ${s.cmd}   (${note})`);
    }
    if (e2ePlan && e2eHook.dryLine && steps.some((s) => s.id === 'e2e'))
      console.log(e2eHook.dryLine(e2ePlan));
    if (registryHook.dryLine) console.log(registryHook.dryLine(registry));
    printNotSelected();
    printNightly();
    console.log(
      `\n${renderMarkdown(map, { machine })}\n\n${renderSizeLine(map.size)}`,
    );
    process.exit(0);
  }

  printNotSelected();
  printNightly();
  // The lock covers the stack steps; a dry run and a no-stack diff never take it.
  const lock = steps.some((s) => s.id === 'preflight' && s.mode === 'run')
    ? gateLock({ commands: commandsOf(GATE) })
    : null;
  // R1: the e2e step writes its JSON report next to the list output.
  const e2eRuns = steps.some((s) => s.id === 'e2e' && s.mode === 'run');
  if (e2eRuns && e2eHook.reportPath) {
    rmSync(e2eHook.reportPath, { force: true });
    process.env.FP_E2E_JSON = e2eHook.reportPath;
  }
  let { results, ok, failures, stoppedBy } = buildResults(
    { steps, notSelected },
    runInShell,
    { ...timeouts, lock, keepGoing: args.includes('--keep-going') },
  );
  // G2: the e2e result carries its mode, selection, per-spec results and knownRed.
  let report = null;
  const e2eAt = results.findIndex(
    (r) => r.id === 'e2e' && ['pass', 'fail'].includes(r.status),
  );
  if (e2ePlan && e2eRuns && e2eAt >= 0 && e2eHook.finish) {
    try {
      report = JSON.parse(readFileSync(e2eHook.reportPath, 'utf8'));
    } catch {
      report = null;
    }
    const done = e2eHook.finish(results[e2eAt], { ...e2ePlan, report });
    if (done.status !== results[e2eAt].status)
      failures.push({
        id: 'e2e',
        cmd: done.cmd,
        why: 'a spec failed or never ran',
        out: `${done.summary}\nRerun: ${commandsOf(GATE).verify} --e2e=full\n`,
      });
    results = results.map((r, i) => (i === e2eAt ? done : r));
    ok = receiptOk(results);
  }
  const failed = results.some((r) => r.status === 'fail');
  const hash = treeHash();
  const ranAt = new Date().toISOString();
  // R7: a partial run has no `missed`, so the shadow is kept for full runs.
  const shadow = await e2eHook.finishShadow?.(
    e2ePlan?.mode === 'full'
      ? e2ePlan.selectorError
        ? { error: e2ePlan.selectorError }
        : { selection: e2ePlan.selection }
      : null,
    results,
  );

  // A failed proof is recorded as null and never changes `ok`.
  let moveProof = null;
  let moveProofError = null;
  try {
    const p = moveProofOf(baseSha);
    moveProof = { unmatched: p.unmatched, base: baseSha };
  } catch (e) {
    moveProofError = e.message.split('\n')[0];
  }

  const receipt = buildReceipt({
    treeHash: hash,
    ranAt,
    ok,
    results,
    size: map.size,
    base: baseSha,
    moveProof,
    shadow,
  });

  mkdirSync(dirname(RECEIPT), { recursive: true });
  // Ledger: a pass or fail is filed only when the inputs are still the ones the
  // plan digested. A ledger problem is printed and never fails the gate.
  try {
    const stateNow = inputState({ base: baseSha });
    const lines = ledgerLines(results, {
      ranAt,
      digestNow: (id, cmd) => stepDigest(id, cmd, { state: stateNow }),
    });
    for (const r of results)
      if (
        ['pass', 'fail'].includes(r.status) &&
        r.digest &&
        !lines.some((l) => l.id === r.id)
      )
        console.log(
          `ledger: ${r.id} not recorded (inputs changed during the run)`,
        );
    appendLedger(LEDGER, lines);
    const e2eRes = results.find(
      (r) => r.id === 'e2e' && Array.isArray(r.specs),
    );
    if (e2ePlan && e2eRes)
      appendSpecLedger(
        SPEC_LEDGER,
        specLedgerLines(e2eRes.specs, {
          ranAt,
          mode: e2eRes.mode,
          ms: e2eRes.ms,
          digestNow: (file) =>
            specDigest(file, e2ePlan.inputs.get(file) ?? [], {
              state: stateNow,
            }),
        }),
      );
  } catch (e) {
    console.error(`verify:ticket: step ledger not written: ${e.message}`);
  }
  // The previous green receipt is still on disk here: seed before overwriting it.
  try {
    seedHistory(HISTORY, RECEIPT);
  } catch (e) {
    console.error(`verify:ticket: history not seeded: ${e.message}`);
  }
  writeFileSync(RECEIPT, JSON.stringify(receipt, null, 2));
  try {
    appendHistory(HISTORY, receipt);
  } catch (e) {
    console.error(`verify:ticket: history not written: ${e.message}`);
  }

  // The summary must never break the gate: the receipt above is already written.
  let failuresPath = null;
  try {
    // prettier-ignore
    failuresPath = writeFailures(FAILURES, { treeHash: hash, ranAt, failures, stoppedBy });
  } catch (e) {
    console.error(`verify:ticket: failures summary not written: ${e.message}`);
  }

  console.log(
    '\n\n--- paste into the PR body -------------------------------\n',
  );
  console.log('```');
  for (const line of renderSummary(results, notRun, {
    failures: failuresPath && FAILURES_REL,
  }))
    console.log(line);
  console.log('```\n');
  if (shadow && e2eHook.shadowLine) console.log(e2eHook.shadowLine(shadow));
  try {
    const median = e2ePlan
      ? fullMedianLine(readLedger(), readLedger(SPEC_LEDGER))
      : null;
    if (median) console.log(median.line);
  } catch (e) {
    console.log(`e2e full median: unavailable (${e.message})`);
  }
  console.log(renderMarkdown(map, { machine }));
  console.log('');
  console.log(renderSizeLine(map.size, { color: process.stdout.isTTY }));
  console.log(
    moveProof
      ? `move proof: unmatched ${moveProof.unmatched} (${commandsOf(GATE).moveCheck} lists them)`
      : `move proof: unavailable (${moveProofError})`,
  );
  console.log('');

  if (failed) {
    console.error(
      `verify:ticket FAILED (failures: ${FAILURES_REL}). Do not tick a DoD checkbox until this is green.`,
    );
    process.exit(1);
  }
  if (!ok) {
    const skipped = results
      .filter((r) => r.status === 'skipped')
      .map((r) => r.id);
    console.error(
      `verify:ticket incomplete: skipped ${skipped.join(', ')}. The gate will not let a DoD checkbox be ticked until these run.`,
    );
    process.exit(1);
  }
  console.log('verify:ticket OK.');
}
