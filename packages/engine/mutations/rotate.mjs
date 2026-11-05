// Mutation rotation: run the registry's guards in batches, oldest proof first, inside a time
// budget, and keep a ledger of what each run did. The caller supplies `io` (clock, registry,
// process runner, files) so a project's own runner and `ticket-gate mutate --rotate` share this core.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { compareKeys } from "./registry.mjs";

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
