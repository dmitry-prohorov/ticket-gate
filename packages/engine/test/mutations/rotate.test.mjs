import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { bin, entries, gateProject } from "./__tests__/gate-project.mjs";
import {
  compactLedger,
  readLedger,
  rotationOrder,
  runRotation,
} from "../../mutations/rotate.mjs";

const made = [];
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const H = 3_600_000;
const MIN = 60_000;
const NOW = Date.parse("2026-01-15T01:00:00.000Z");
const SHA = "a1b2c3d4e5f6".padEnd(40, "0");
const iso = (ms) => new Date(ms).toISOString();

const reg = (...specs) =>
  new Map(
    specs.map((x) => {
      const [key, extra = {}] = Array.isArray(x) ? x : [x];
      return [
        key,
        {
          path: "registry/x.json",
          line: 1,
          entry: {
            kind: "patch",
            file: `src/${key.replace("/", "-")}.mjs`,
            testFile: `src/${key.replace("/", "-")}.test.mjs`,
            ...extra,
          },
        },
      ];
    }),
  );
const ledgerLine = (key, status, daysAgo, sha = "c".repeat(40)) => ({
  key,
  sha,
  status,
  ranAt: iso(NOW - daysAgo * 24 * H),
});
const allKilled = (ids) => ids.map((id) => ({ id, status: "killed" }));

// A fake io over a real scratch dir: `mutate(world, ids)` is what the batch process reports.
function world({ entries = new Map(), mutate, registryThrows = null } = {}) {
  const w = {
    dir: tmp("rot-ledger-"),
    cwd: tmp("rot-cwd-"),
    clock: NOW,
    calls: [],
    batches: [],
  };
  const report = mutate ?? ((_w, ids) => ({ results: allKilled(ids) }));
  w.io = {
    now: () => w.clock,
    registry: () => {
      if (registryThrows) throw new Error(registryThrows);
      return { entries, errors: [] };
    },
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c),
    run: async (cmd, args, o) => {
      w.calls.push({ line: [cmd, ...args].join(" "), ...o });
      const ids = args
        .find((a) => a.startsWith("--ids="))
        .slice(6)
        .split(",");
      w.batches.push(ids);
      const got = report(w, ids);
      if (got.results) {
        mkdirSync(join(o.cwd, ".turbo"), { recursive: true });
        writeFileSync(
          join(o.cwd, ".turbo", "mutation-registry.json"),
          JSON.stringify({ results: got.results }),
        );
      }
      return { code: 0, timedOut: got.timedOut === true, out: "" };
    },
  };
  return w;
}
const opts = (w, over = {}) => ({
  dir: w.dir,
  cwd: w.cwd,
  sha: SHA,
  startMs: NOW,
  deadlineMs: NOW + 5 * H,
  command: ["run-batch"],
  ...over,
});
const writeLedger = (w, lines) =>
  writeFileSync(
    join(w.dir, "mutations.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
const everyBatch25 = (w, ids) => {
  w.clock += 25 * MIN;
  return { results: allKilled(ids) };
};

test("NM-1 rotationOrder runs never-run keys first, then oldest last run, ties by key", () => {
  const live = ["A/M1", "B/M1", "C/M1", "D/M1"].map((key) => ({ key }));
  const ledger = [
    ledgerLine("A/M1", "killed", 1),
    ledgerLine("C/M1", "killed", 5),
    ledgerLine("D/M1", "killed", 10),
    ledgerLine("D/M1", "survived", 9),
  ];
  assert.deepEqual(rotationOrder(live, ledger), [
    "B/M1",
    "D/M1",
    "C/M1",
    "A/M1",
  ]);
  const tie = ["Z/M1", "Y/M10", "Y/M2"].map((key) => ({ key }));
  assert.deepEqual(rotationOrder(tie, []), ["Y/M2", "Y/M10", "Z/M1"]);
});

test("NM-2a the phase starts no batch once the budget is spent", async () => {
  const w = world({
    entries: reg("A/M1", "A/M2", "A/M3", "A/M4", "A/M5"),
    mutate: everyBatch25,
  });
  const got = await runRotation(
    w.io,
    opts(w, { budgetMs: 60 * MIN, deadlineMs: NOW + 3 * H, batch: 1 }),
  );
  assert.equal(w.batches.length, 3);
  assert.equal(got.stoppedBy, "budget");
  assert.equal(got.ran, 3);
  assert.equal(got.status, "ran");
});

test("NM-2b the phase stops at the deadline before the budget, and a batch limit never passes the deadline", async () => {
  const w = world({
    entries: reg("A/M1", "A/M2", "A/M3", "A/M4", "A/M5"),
    mutate: everyBatch25,
  });
  const env = { OWNER: "night:1:1" };
  const got = await runRotation(
    w.io,
    opts(w, {
      budgetMs: 60 * MIN,
      deadlineMs: NOW + 30 * MIN,
      batch: 1,
      graceS: 77,
      env,
    }),
  );
  assert.equal(w.batches.length, 2);
  assert.equal(got.stoppedBy, "deadline");
  assert.deepEqual(
    w.calls.map((c) => c.limitS),
    [1800, 300],
    "the limit is the time left to the deadline at each start",
  );
  for (const c of w.calls) {
    assert.equal(c.killSignal, "SIGTERM");
    assert.equal(c.graceS, 77);
    assert.equal(c.cwd, w.cwd);
    assert.deepEqual(c.env, env);
    assert.match(c.line, /^run-batch --registry --ids=A\/M\d$/);
  }
});

test("NM-3 a survivor is recorded with file, testFile and its last kill sha, and the ledger gains survived", async () => {
  const w = world({
    entries: reg("X/M1", "X/M2"),
    mutate: (_w, ids) => ({
      results: ids.map((id) => ({
        id,
        status: id === "X/M2" ? "survived" : "killed",
      })),
    }),
  });
  const killSha = "d".repeat(40);
  writeLedger(w, [ledgerLine("X/M2", "killed", 3, killSha)]);
  const got = await runRotation(w.io, opts(w));
  assert.deepEqual(got.survivors, [
    {
      key: "X/M2",
      file: "src/X-M2.mjs",
      testFile: "src/X-M2.test.mjs",
      lastKillSha: killSha,
    },
  ]);
  assert.equal(got.survived, 1);
  assert.equal(got.killed, 1);
  const mine = readLedger(w.dir).filter((l) => l.key === "X/M2");
  assert.equal(mine.at(-1).status, "survived");
  assert.equal(mine.at(-1).sha, SHA);
  assert.ok(
    mine.some((l) => l.status === "killed" && l.sha === killSha),
    "the newest kill is kept",
  );
  assert.equal(got.unproven, 0);
  assert.equal(got.oldestProofDays, 3, "X/M2 keeps its kill from 3 days ago");
});

test("NM-4 a retired entry never runs and is not counted live", async () => {
  const w = world({
    entries: reg("A/M1", ["A/M2", { retired: "gone" }], "A/M3"),
  });
  const got = await runRotation(w.io, opts(w));
  assert.equal(got.live, 2);
  assert.deepEqual(w.batches, [["A/M1", "A/M3"]]);
});

test("NM-5 a ledger line that is not valid JSON or lacks a field is skipped, and compaction keeps the newest line and the newest kill per key", () => {
  const dir = tmp("rot-ledger-");
  const good = ledgerLine("A/M1", "killed", 2);
  writeFileSync(
    join(dir, "mutations.jsonl"),
    [
      JSON.stringify(good),
      "{not json",
      JSON.stringify({ key: "A/M2", sha: "x", status: "killed" }),
      JSON.stringify({ ...good, status: "weird" }),
      JSON.stringify({ ...good, key: 7 }),
      "",
    ].join("\n"),
  );
  assert.deepEqual(readLedger(dir), [good]);
  rmSync(join(dir, "mutations.jsonl"));
  assert.deepEqual(readLedger(dir), []);

  const lines = [
    ledgerLine("B/M1", "killed", 9),
    ledgerLine("B/M1", "killed", 5),
    ledgerLine("B/M1", "error", 3),
    ledgerLine("B/M1", "survived", 1),
    ledgerLine("A/M1", "survived", 4),
  ];
  assert.deepEqual(compactLedger(lines), [
    ledgerLine("A/M1", "survived", 4),
    ledgerLine("B/M1", "killed", 5),
    ledgerLine("B/M1", "survived", 1),
  ]);
});

test("NM-R a replayed scenario writes the golden ledger and summary byte for byte", async () => {
  const fx = new URL("../fixtures/rotation/", import.meta.url);
  const read = (n) => readFileSync(new URL(n, fx));
  const sc = JSON.parse(read("scenario.json"));
  const entries = new Map(
    sc.entries.map(({ key, retired, ...entry }) => [
      key,
      {
        path: "x.json",
        line: 1,
        entry: retired ? { ...entry, retired: "gone" } : entry,
      },
    ]),
  );
  const w = world({ entries });
  w.clock = sc.startMs;
  let batchNo = 0;
  w.io.run = async (_cmd, args, o) => {
    const ids = args
      .find((a) => a.startsWith("--ids="))
      .slice(6)
      .split(",");
    w.clock += sc.stepMs;
    const results = [
      ...ids.map((id) => ({ id, status: sc.outcomes[id] ?? "killed" })),
      ...(sc.extras[batchNo] ?? []),
    ];
    batchNo += 1;
    mkdirSync(join(o.cwd, ".turbo"), { recursive: true });
    writeFileSync(
      join(o.cwd, ".turbo", "mutation-registry.json"),
      JSON.stringify({ results }),
    );
    return { code: 0, timedOut: false, out: "" };
  };
  writeFileSync(join(w.dir, "mutations.jsonl"), sc.seedLedger.join("\n"));
  const got = await runRotation(w.io, {
    dir: w.dir,
    cwd: w.cwd,
    sha: sc.sha,
    startMs: sc.startMs,
    deadlineMs: sc.deadlineMs,
    budgetMs: sc.budgetMs,
    batch: sc.batch,
    command: ["run-batch"],
  });
  assert.equal(batchNo, 3);
  assert.ok(
    readFileSync(join(w.dir, "mutations.jsonl")).equals(read("expected.jsonl")),
    "ledger bytes",
  );
  assert.equal(
    JSON.stringify(got),
    read("expected-summary.json").toString("utf8"),
  );
});

const withRetired = {
  ...entries,
  "T/M3": {
    ...entries["T/M1"],
    retired: { by: "T", why: "obsolete per specs/x.md section 2" },
  },
};
const rotateProject = () =>
  gateProject({
    config: undefined,
    registry: withRetired,
  });
const ledgerOf = (dir) =>
  readFileSync(join(dir, "ledger", "mutations.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test("RT-1 mutate --rotate runs a scratch registry in batches, appends the ledger and prints the summary line", () => {
  const p = rotateProject();
  const r = bin(p.dir, ["mutate", "--rotate", "--ledger=ledger", "--batch=1", "--sha=abc123"]);
  assert.equal(r.status, 1, r.out);
  assert.match(
    r.out,
    /rotate: 2 ran \(1 killed, 1 survived, 0 error\) of 2 live; done; oldest proof 0 days; 1 unproven/,
  );
  assert.match(r.out, /T\/M2 survived {2}src\/guard\.mjs {2}src\/guard\.test\.mjs {2}last kill none/);
  const got = ledgerOf(p.dir);
  assert.deepEqual(
    got.map((l) => [l.key, l.status, l.sha]),
    [
      ["T/M1", "killed", "abc123"],
      ["T/M2", "survived", "abc123"],
    ],
  );
});

test("RT-2 mutate --rotate refuses while another owner holds the stack lock and writes no ledger", () => {
  const p = rotateProject();
  const lock = join(p.dir, ".turbo", "stack.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({
      v: 1,
      id: `verify:ticket:${process.pid}:1`,
      owner: "verify:ticket",
      pid: process.pid,
      cwd: p.dir,
      startedAt: new Date().toISOString(),
    }),
  );
  const r = bin(p.dir, ["mutate", "--rotate", "--ledger=ledger", "--sha=abc123"]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /stack lock held/);
  assert.equal(existsSync(join(p.dir, "ledger", "mutations.jsonl")), false);
});

test("RT-3 mutate --rotate without --ledger, with --budget-min=0, with --ids or a ticket id is usage, exit 2", () => {
  const p = rotateProject();
  for (const extra of [
    [],
    ["--ledger=ledger", "--budget-min=0"],
    ["--ledger=ledger", "--ids=T/M1"],
    ["--ledger=ledger", "T"],
  ]) {
    const r = bin(p.dir, ["mutate", "--rotate", ...extra]);
    assert.equal(r.status, 2, `${extra.join(" ")}: ${r.out}`);
    assert.match(r.out, /usage: /);
  }
  assert.equal(existsSync(join(p.dir, "ledger")), false);
});
