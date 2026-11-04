import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { GATE } from './project.mjs';
import { pick } from './config.mjs';
import { stopsOf } from './plan.mjs';
import { receiptOk } from './receipt.mjs';
import { oneLine } from './summary.mjs';
import { ROOT } from './root.mjs';

export const STEP_IDS = GATE.steps.map((s) => s.id);

// Seconds a step may run before the watchdog kills its process group. A step
// that needs longer gets `--timeout=<id>:<sec>`; the limit is never removed.
export const STEP_LIMITS = Object.fromEntries(
  GATE.steps.filter((s) => !s.human).map((s) => [s.id, s.limitS]),
);

const READY_LIMIT_S = 120;

const STACK_STEPS = GATE.steps.filter((s) => s.stack).map((s) => s.id);

// Steps before any GATE.stopOnRedBefore id in step order; a red one stops the stack steps.
const preStack = (id) =>
  stopsOf(GATE).some((s) => STEP_IDS.indexOf(id) < STEP_IDS.indexOf(s));

const digestOn = (step) => (step.digest ? { digest: step.digest } : {});

/**
 * Turns a plan into receipt results. `runStep(step, { limitS })` executes one
 * `run` step and returns `{ status, out, timedOut?, streamed? }`. Steps the
 * diff did not select (`notSelected`) produce no result. Each run result gets
 * `ms`, and `limitS` when `--timeout` overrode that step's limit. A red
 * `preflight` stops the gate (D1): nothing after it runs, the receipt is red.
 */
export function buildResults(
  plan,
  runStep,
  {
    limits = STEP_LIMITS,
    overridden = new Set(),
    lock = null,
    keepGoing = false,
  } = {},
) {
  const results = [];
  const failures = [];
  // The id of the first red step before `seed`; once set, no stack
  // step (and no preflight) that has not started is run.
  let stoppedBy = null;
  try {
    for (const step of plan.steps) {
      if (step.mode === 'human') {
        console.log(`\n=== HUMAN STEP (not run): ${step.cmd}\n`);
        results.push({
          id: step.id,
          cmd: step.cmd,
          status: 'human',
          summary: step.summary(''),
        });
        continue;
      }
      if (step.mode === 'reuse') {
        console.log(`\n=== REUSED (${step.reusedFrom}): ${step.cmd}\n`);
        results.push({
          id: step.id,
          cmd: step.cmd,
          status: 'reused',
          summary: `${step.reusedSummary} (reused from ${step.reusedFrom})`,
          digest: step.digest,
          reusedFrom: step.reusedFrom,
        });
        continue;
      }
      if (step.mode === 'skip') {
        console.log(`\n=== SKIPPED (--skip=${step.id}): ${step.cmd}\n`);
        results.push({
          id: step.id,
          cmd: step.cmd,
          status: 'skipped',
          summary: 'skipped by request: NOT verified',
          ...digestOn(step),
        });
        continue;
      }
      if (
        stoppedBy !== null &&
        (STACK_STEPS.includes(step.id) ||
          step.id === 'preflight' ||
          step.health)
      ) {
        console.log(`\n=== STOPPED (${stoppedBy} red): ${step.cmd}\n`);
        results.push({
          id: step.id,
          cmd: step.cmd,
          status: 'stopped',
          summary: `not run (stopped: ${stoppedBy} red)`,
          ...digestOn(step),
        });
        continue;
      }
      console.log(`\n=== ${step.cmd}   (${step.why})\n`);
      const started = Date.now();
      if (step.id === 'preflight') {
        const got = lock ? lock.acquire() : { ok: true };
        if (!got.ok) {
          results.push({
            id: 'preflight',
            cmd: step.cmd,
            status: 'fail',
            summary: got.summary,
            ms: Date.now() - started,
          });
          failures.push({
            id: 'preflight',
            cmd: step.cmd,
            why: step.why,
            out: `${got.summary}\n`,
          });
          break;
        }
      }
      if (typeof step.prepare === 'function') {
        try {
          step.prepare();
        } catch (e) {
          const summary = `e2e list: ${e.message}`;
          results.push({
            id: step.id,
            cmd: step.cmd,
            status: 'fail',
            summary,
            ms: Date.now() - started,
            ...digestOn(step),
          });
          failures.push({
            id: step.id,
            cmd: step.cmd,
            why: step.why,
            out: `${summary}\n`,
          });
          continue;
        }
      }
      const limitS = limits[step.id] ?? step.limitS;
      const first = runStep(step, { limitS });
      if (first.streamed !== true) process.stdout.write(first.out);
      let ok = first.status === 0 && first.timedOut !== true;
      let { out } = first;
      let timedOut = first.timedOut === true;
      let timedOutLimit = limitS;
      let readyFailed = false;
      if (ok && step.ready) {
        console.log(
          `\n=== ${step.ready}   (${step.id} is up; waiting for the services later steps need)\n`,
        );
        const r = runStep(
          { id: step.id, cmd: step.ready, append: true },
          { limitS: READY_LIMIT_S },
        );
        if (r.streamed !== true) process.stdout.write(r.out);
        if (r.status !== 0 || r.timedOut === true) {
          ok = false;
          readyFailed = true;
          out = r.out;
          timedOut = r.timedOut === true;
          timedOutLimit = READY_LIMIT_S;
        }
      }
      if (!ok) {
        const hint = STACK_STEPS.includes(step.id)
          ? ` Check the stack with: ${GATE.stackHint(step.id)}`
          : ` Rerun this step alone: ${step.cmd}`;
        failures.push({
          id: step.id,
          cmd: step.cmd,
          why: step.why,
          out: timedOut
            ? `${out}\nTIMEOUT after ${timedOutLimit} s (limit ${step.id}: ${timedOutLimit} s).${hint}\n`
            : out,
        });
      }
      let summary;
      if (timedOut)
        summary = `TIMEOUT after ${timedOutLimit} s (limit ${step.id}: ${timedOutLimit} s)`;
      else if (readyFailed) summary = oneLine(out) || 'stack not ready';
      else if (ok) summary = step.summary(out) ?? 'passed';
      else
        summary =
          step.failSummary?.(out) ??
          pick(out, [/Code style issues/, /error/i, /failed/i]) ??
          'failed';
      results.push({
        id: step.id,
        cmd: step.cmd,
        status: ok ? 'pass' : 'fail',
        summary,
        ms: Date.now() - started,
        ...digestOn(step),
        ...(overridden.has(step.id) ? { limitS } : {}),
      });
      // prettier-ignore
      if (!ok && !keepGoing && stoppedBy === null && preStack(step.id)) stoppedBy = step.id;
      if (step.id === 'preflight' && !ok) break;
    }
  } finally {
    lock?.release();
  }
  // `ok` means every required step actually ran and passed. A skipped step is
  // not ok: the gate reads `results` too, but `ok` is what a human reads first.
  return { results, ok: receiptOk(results), failures, stoppedBy };
}

// Each step runs in its own process group under a watchdog that kills the
// group once this process is gone. Without it, a gate stopped by a signal to
// its own pid (pkill, a closed agent shell) left `supabase db reset` running
// at full CPU for over an hour, and the next gate timed out on load.
// The same watchdog enforces the step's time limit: past it the group gets
// TERM, then KILL 5 s later, and the marker file says the limit (not the step)
// ended it. $1 cmd, $2 limit in seconds (0 = none), $3 log (appended), $4 marker.
// Output reaches the terminal live through tee and is kept in the log.
const STEP_WATCHDOG = String.raw`
set -m
( set -o pipefail; bash -lc "$1" 2>&1 | tee -a "$3" ) &
child=$!
set +m
( while kill -0 "$VERIFY_TICKET_PID" 2>/dev/null; do sleep 2; done
  kill -TERM -"$child" 2>/dev/null; sleep 5; kill -KILL -"$child" 2>/dev/null ) >/dev/null 2>&1 &
watch=$!
timer=
if [ "$2" -gt 0 ]; then
  ( sleep "$2"; echo timeout > "$4"; kill -TERM -"$child" 2>/dev/null; sleep 5; kill -KILL -"$child" 2>/dev/null ) >/dev/null 2>&1 &
  timer=$!
fi
wait "$child"; status=$?
# The timer arm's sleep is its child and outlives a kill of the subshell: stop the
# subshell (it can fork no more), find its sleep, then kill both.
kids=
if [ -n "$timer" ]; then kill -STOP "$timer" 2>/dev/null; kids=$(pgrep -P "$timer" 2>/dev/null); fi
kill "$watch" 2>/dev/null
[ -n "$timer" ] && kill -KILL "$timer" $kids 2>/dev/null
exit "$status"`;

/**
 * Runs one step under the watchdog. Logs under `logDir/<id>.log` (only .turbo/
 * is ever written); `step.append` keeps the existing log and returns just the
 * new part. `timedOut` is true only when the watchdog's timer fired: a step
 * that itself exits 124 is an ordinary failure.
 */
export const runInShell = (
  step,
  { limitS, logDir = join(ROOT, '.turbo', 'verify-steps') } = {},
) => {
  mkdirSync(logDir, { recursive: true });
  const log = join(logDir, `${step.id ?? 'step'}.log`);
  const marker = `${log}.timeout`;
  rmSync(marker, { force: true });
  if (!step.append) writeFileSync(log, '');
  const before = readFileSync(log, 'utf8').length;
  const r = spawnSync(
    'bash',
    [
      '-c',
      STEP_WATCHDOG,
      'verify-step',
      step.cmd,
      String(limitS ?? 0),
      log,
      marker,
    ],
    {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, VERIFY_TICKET_PID: String(process.pid) },
    },
  );
  const timedOut = existsSync(marker);
  rmSync(marker, { force: true });
  return {
    status: r.status ?? (timedOut ? 124 : 1),
    out: readFileSync(log, 'utf8').slice(before),
    timedOut,
    streamed: true,
  };
};
