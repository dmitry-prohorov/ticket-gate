// Mutation rotation: run the registry's guards in batches, oldest proof first, inside a time
// budget, and keep a ledger of what each run did. The caller supplies `io` (clock, registry,
// process runner, files) so a project's own runner and `ticket-gate mutate --rotate` share this core.
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeKillGroup } from "../kill-group.mjs";
import { takeOrExit } from "../lock.mjs";
import { ROOT } from "../root.mjs";
import { compareKeys, loadRegistry } from "./registry.mjs";

export const ROTATE_DEFAULTS = Object.freeze({
  budgetMs: 3_600_000,
  batch: 10,
  graceS: 120,
  receipt: ".turbo/mutation-registry.json",
});

const DAY_MS = 86_400_000;
const LEDGER_STATUS = new Set(["killed", "survived", "error"]);
const ledgerFile = (dir) => join(dir, "mutations.jsonl");
const ts = (l) => Date.parse(l.ranAt);

function parseLedgerLine(text) {
  try {
    const l = JSON.parse(text);
    const ok =
      typeof l?.key === "string" &&
      typeof l.sha === "string" &&
      typeof l.ranAt === "string" &&
      LEDGER_STATUS.has(l.status);
    return ok ? [l] : [];
  } catch {
    return [];
  }
}

/** <dir>/mutations.jsonl as [{ key, sha, status, ranAt }]; bad lines skipped, no file -> []. */
export function readLedger(dir) {
  const f = ledgerFile(dir);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap(parseLedgerLine);
}

/** Per key its newest line and its newest killed line, sorted by key then ranAt. */
export function compactLedger(lines) {
  const per = new Map();
  for (const l of lines) {
    const e = per.get(l.key) ?? { newest: null, killed: null };
    if (e.newest === null || ts(l) >= ts(e.newest)) e.newest = l;
    if (l.status === "killed" && (e.killed === null || ts(l) >= ts(e.killed)))
      e.killed = l;
    per.set(l.key, e);
  }
  return [...per.values()]
    .flatMap((e) =>
      e.killed === null || e.killed === e.newest
        ? [e.newest]
        : [e.newest, e.killed],
    )
    .sort((a, b) => compareKeys(a.key, b.key) || ts(a) - ts(b));
}

/** Live entries ([{ key, ... }]) -> keys: never run first, then oldest last attempt, ties by key. */
export function rotationOrder(live, ledger) {
  const newest = new Map();
  for (const l of ledger)
    if (ts(l) > (newest.get(l.key) ?? -Infinity)) newest.set(l.key, ts(l));
  const last = (k) => newest.get(k) ?? -Infinity;
  return live
    .map((e) => e.key)
    .sort((a, b) => {
      const d = last(a) < last(b) ? -1 : last(a) > last(b) ? 1 : 0;
      return d || compareKeys(a, b);
    });
}

function survivorOf(key, byKey, ledger) {
  const e = byKey.get(key);
  const kill = ledger
    .filter((l) => l.key === key && l.status === "killed")
    .sort((a, b) => ts(b) - ts(a))[0];
  return {
    key,
    file: e?.file ?? null,
    testFile: e?.testFile ?? null,
    lastKillSha: kill?.sha ?? null,
  };
}

/**
 * Runs registry keys in rotation order in batches until the budget (soft: a batch in flight
 * finishes) or the deadline (hard: the batch limit is the time left, SIGTERM then SIGKILL) is
 * reached. Appends to <dir>/mutations.jsonl after every batch. Throws on a registry error; the
 * caller records it. `command` is the batch runner as [cmd, ...args]; `--registry --ids=<keys>`
 * is appended to it.
 */
export async function runRotation(
  io,
  {
    dir,
    cwd,
    sha,
    startMs,
    deadlineMs,
    budgetMs = ROTATE_DEFAULTS.budgetMs,
    batch = ROTATE_DEFAULTS.batch,
    graceS = ROTATE_DEFAULTS.graceS,
    command,
    env = {},
    receipt: receiptRel = ROTATE_DEFAULTS.receipt,
  },
) {
  const reg = io.registry(cwd);
  if (reg.errors.length > 0)
    throw new Error(`registry is invalid: ${reg.errors[0]}`);
  const entries = [...reg.entries].flatMap(([key, v]) =>
    v.entry.kind === "unguarded"
      ? []
      : [
          {
            key,
            file: v.entry.file ?? null,
            testFile: v.entry.testFile ?? null,
            retired: v.entry.retired,
          },
        ],
  );
  const live = entries.filter((e) => !e.retired);
  const byKey = new Map(live.map((e) => [e.key, e]));
  let ledger = readLedger(dir);
  const order = rotationOrder(live, ledger);
  const stopAt = Math.min(startMs + budgetMs, deadlineMs);
  const receipt = join(cwd, receiptRel);
  const n = { ran: 0, killed: 0, survived: 0, error: 0 };
  const survivors = [];
  let status = "ran";
  let reason = null;
  let stoppedBy = "done";
  for (let i = 0; i < order.length; ) {
    const now = io.now();
    if (now >= stopAt) {
      stoppedBy = startMs + budgetMs <= deadlineMs ? "budget" : "deadline";
      break;
    }
    const keys = order.slice(i, i + batch);
    i += keys.length;
    io.rm(receipt);
    const r = await io.run(
      command[0],
      [...command.slice(1), "--registry", `--ids=${keys.join(",")}`],
      {
        cwd,
        env,
        limitS: Math.max(1, Math.ceil((deadlineMs - now) / 1000)),
        killSignal: "SIGTERM",
        graceS,
      },
    );
    if (r.timedOut) {
      [status, reason, stoppedBy] = ["error", "cut-short", null];
      break;
    }
    let results = null;
    if (io.exists(receipt))
      try {
        const got = JSON.parse(io.readFile(receipt)).results;
        results = Array.isArray(got) ? got : null;
      } catch {
        results = null;
      }
    if (results === null) {
      [status, reason, stoppedBy] = ["error", "no-receipt", null];
      break;
    }
    const fresh = [];
    for (const x of results) {
      if (!keys.includes(x?.id) || !LEDGER_STATUS.has(x.status)) continue;
      if (x.status === "survived")
        survivors.push(survivorOf(x.id, byKey, ledger));
      n[x.status] += 1;
      n.ran += 1;
      fresh.push({
        key: x.id,
        sha,
        status: x.status,
        ranAt: new Date(io.now()).toISOString(),
      });
    }
    ledger = compactLedger([...ledger, ...fresh]);
    io.writeFile(
      ledgerFile(dir),
      `${ledger.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  }
  const kills = live
    .map(
      (e) =>
        ledger
          .filter((l) => l.key === e.key && l.status === "killed")
          .map(ts)
          .sort((a, b) => b - a)[0],
    )
    .filter((t) => t !== undefined);
  return {
    status,
    reason,
    stoppedBy,
    ms: io.now() - startMs,
    live: live.length,
    ...n,
    oldestProofDays:
      kills.length === 0
        ? null
        : Math.floor((io.now() - Math.min(...kills)) / DAY_MS),
    unproven: live.length - kills.length,
    survivors,
  };
}

/**
 * The batch runner `ticket-gate mutate --rotate` uses: the command in its own process group,
 * killed past `limitS` (`killSignal`, then SIGKILL after `graceS`), stragglers killed on exit.
 * Resolves { code, timedOut, out }; never rejects.
 */
export function runGroup(
  cmd,
  args,
  { cwd, env = {}, limitS, killSignal = "SIGTERM", graceS = 120 } = {},
) {
  return new Promise((done) => {
    let out = "";
    let timedOut = false;
    let settled = false;
    const timers = [];
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      safeKillGroup(child.pid, "SIGKILL");
      done({ code, timedOut, out });
    };
    if (limitS !== undefined)
      timers.push(
        setTimeout(() => {
          timedOut = true;
          safeKillGroup(child.pid, killSignal);
          timers.push(
            setTimeout(() => {
              safeKillGroup(child.pid, "SIGKILL");
              finish(124);
            }, graceS * 1000),
          );
        }, limitS * 1000),
      );
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => {
      out += String(err);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

const ROTATE_FLAGS = ["rotate", "ledger", "budget-min", "batch", "deadline", "sha"];

function rotateUsage(msg, setup) {
  console.error(
    `${msg}\nusage: ${setup.commands.mutate} --rotate --ledger=<dir> [--budget-min=<n>] [--batch=<n>] [--deadline=<ISO>] [--sha=<sha>]`,
  );
  return 2;
}

const positive = (text) => {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * `ticket-gate mutate --rotate`: one budgeted rotation over the live registry, ledger under
 * `--ledger`. Returns the exit code: 0 ran with no survivor, 1 a survivor or an error, 2 usage
 * or an invalid registry. The summary is printed either way.
 */
export async function rotateMain(args, setup) {
  const code = await rotate(args, setup);
  process.exitCode = code;
  return code;
}

async function rotate(args, setup) {
  const flags = new Map();
  for (const a of args) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m || !ROTATE_FLAGS.includes(m[1]))
      return rotateUsage(`unexpected argument ${a}`, setup);
    flags.set(m[1], m[2]);
  }
  if (!flags.get("ledger")) return rotateUsage("--rotate needs --ledger=<dir>", setup);
  const budgetMin = flags.has("budget-min") ? positive(flags.get("budget-min")) : 60;
  if (budgetMin === null)
    return rotateUsage("--budget-min must be a positive number", setup);
  const batch = flags.has("batch") ? positive(flags.get("batch")) : ROTATE_DEFAULTS.batch;
  if (batch === null || !Number.isInteger(batch))
    return rotateUsage("--batch must be a positive integer", setup);
  const startMs = Date.now();
  const deadlineMs = flags.has("deadline")
    ? Date.parse(flags.get("deadline"))
    : startMs + budgetMin * 60_000;
  if (!Number.isFinite(deadlineMs))
    return rotateUsage("--deadline must be an ISO date-time", setup);
  const sha =
    flags.get("sha") ||
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dir = resolve(ROOT, flags.get("ledger"));
  // One run on the local stack at a time; the batch children inherit the owner id.
  takeOrExit("mutate:check");
  mkdirSync(dir, { recursive: true });
  const io = {
    now: Date.now,
    registry: (root) => loadRegistry(root, setup),
    run: runGroup,
    rm: (p) => rmSync(p, { force: true }),
    exists: existsSync,
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, text) => writeFileSync(p, text),
  };
  let summary;
  try {
    summary = await runRotation(io, {
      dir,
      cwd: ROOT,
      sha,
      startMs,
      deadlineMs,
      budgetMs: budgetMin * 60_000,
      batch,
      command: [
        process.execPath,
        join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ticket-gate.mjs"),
        "mutate",
      ],
      receipt: setup.receipts.registry,
    });
  } catch (err) {
    console.error(`${err.message}\nRun ${setup.commands.checkMutations} for the full report.`);
    return err.message.startsWith("registry is invalid") ? 2 : 1;
  }
  const s = summary;
  console.log(
    `rotate: ${s.ran} ran (${s.killed} killed, ${s.survived} survived, ${s.error} error) of ${s.live} live; ${s.stoppedBy ?? `error ${s.reason}`}; oldest proof ${s.oldestProofDays ?? "none"} days; ${s.unproven} unproven`,
  );
  for (const v of s.survivors)
    console.log(
      `  ${v.key} survived  ${v.file ?? "-"}  ${v.testFile ?? "-"}  last kill ${v.lastKillSha ?? "none"}`,
    );
  return s.status === "ran" && s.survivors.length === 0 ? 0 : 1;
}
