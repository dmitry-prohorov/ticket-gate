// The module-size ratchet (`createModuleSize`) against throwaway git trees under os.tmpdir():
// an unlisted module over its limit fails, a baselined file may not grow, a shrunk or untracked
// entry is a note, only tracked files count, and --update refuses growth and new entries
// without a reason. Only `git add` is needed (ls-files reads the index).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { createModuleSize } from "../ratchet.mjs";

const size = createModuleSize({
  limits: { module: 600, test: 900 },
  testRe: /\.test\.mjs$/,
  roots: ["lib", "web"],
  baselineRel: "baseline.json",
  comment: "sizes",
  name: "check:size",
  cmd: "gate size",
  fixNew: "Fix: split the new module.",
  fixGrew: "Fix: shrink the file.",
  usage: "Usage: gate size [--update]",
});

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const lines = (n) => "x\n".repeat(n);

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const git = (dir, ...args) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};

/** files: { rel: lineCount }; `untracked` leaves a file out of the index. */
function repo(files, { untracked = [], baseline } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "size-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  for (const [rel, n] of Object.entries(files)) {
    put(dir, rel, lines(n));
    if (!untracked.includes(rel)) git(dir, "add", rel);
  }
  const baselinePath = join(dir, "baseline.json");
  if (baseline)
    writeFileSync(baselinePath, JSON.stringify({ files: baseline }));
  return { dir, baselinePath };
}

const run = (r, opts = {}) =>
  size.checkModuleSize(r.dir, { baselinePath: r.baselinePath, ...opts });
const readBaseline = (r) => JSON.parse(readFileSync(r.baselinePath, "utf8"));

test("MZ-1a a new 601-line module not in the baseline fails", () => {
  const over = run(repo({ "lib/x.mjs": 601 }, { baseline: {} }));
  assert.equal(over.code, 1);
  assert.ok(
    over.lines.some((l) => l.startsWith("NEW lib/x.mjs 601 lines (limit 600)")),
    over.lines.join("\n"),
  );
});

test("MZ-1b a 600-line module passes: the count is physical lines", () => {
  const at = run(repo({ "lib/x.mjs": 600 }, { baseline: {} }));
  assert.equal(at.code, 0, at.lines.join("\n"));
});

test("MZ-2 a baselined file that grew fails, an unchanged one passes", () => {
  const r = run(
    repo(
      { "lib/big.mjs": 701 },
      { baseline: { "lib/big.mjs": { lines: 700 } } },
    ),
  );
  assert.equal(r.code, 1);
  assert.ok(
    r.lines.some((l) => l.startsWith("GREW lib/big.mjs was 700, now 701")),
    r.lines.join("\n"),
  );
  const same = run(
    repo(
      { "lib/big.mjs": 700 },
      { baseline: { "lib/big.mjs": { lines: 700 } } },
    ),
  );
  assert.equal(same.code, 0, same.lines.join("\n"));
});

test("MZ-3 a shrunk or untracked baseline entry is a SHRUNK note with code 0", () => {
  const entry = { "lib/big.mjs": { lines: 700 } };
  const shrunk = run(repo({ "lib/big.mjs": 650 }, { baseline: entry }));
  assert.equal(shrunk.code, 0, shrunk.lines.join("\n"));
  assert.ok(
    shrunk.lines.some((l) =>
      l.startsWith("SHRUNK lib/big.mjs was 700, now 650"),
    ),
    shrunk.lines.join("\n"),
  );
  const gone = run(
    repo(
      { "lib/big.mjs": 700 },
      { baseline: entry, untracked: ["lib/big.mjs"] },
    ),
  );
  assert.equal(gone.code, 0, gone.lines.join("\n"));
  assert.ok(
    gone.lines.some((l) => l.startsWith("SHRUNK lib/big.mjs was 700, now 0")),
    gone.lines.join("\n"),
  );
});

test("MZ-6 untracked files are not measured", () => {
  const r = run(
    repo(
      { "lib/u.mjs": 700, "lib/ok.mjs": 10 },
      { baseline: {}, untracked: ["lib/u.mjs"] },
    ),
  );
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.match(
    r.lines.at(-1),
    /^check:size: 1 files measured, 0 baselined, none grew$/,
  );
});

test("MZ-7 --update lowers a shrunk entry and refuses a grown one without a reason", () => {
  const r = repo(
    { "lib/a.mjs": 650, "lib/b.mjs": 500 },
    {
      baseline: {
        "lib/a.mjs": { lines: 700 },
        "lib/b.mjs": { lines: 700 },
      },
    },
  );
  const u = run(r, { update: true });
  assert.equal(u.code, 0, u.lines.join("\n"));
  const next = readBaseline(r);
  assert.deepEqual(Object.keys(next.files), ["lib/a.mjs"]);
  assert.equal(next.files["lib/a.mjs"].lines, 650);

  const g = repo(
    { "lib/a.mjs": 701 },
    { baseline: { "lib/a.mjs": { lines: 700 } } },
  );
  const before = readFileSync(g.baselinePath, "utf8");
  const refused = run(g, { update: true });
  assert.equal(refused.code, 1);
  assert.ok(
    refused.lines.some((l) => l.startsWith("GREW lib/a.mjs was 700, now 701")),
    refused.lines.join("\n"),
  );
  assert.equal(readFileSync(g.baselinePath, "utf8"), before);
  const raised = run(g, { update: true, allow: { "lib/a.mjs": "r" } });
  assert.equal(raised.code, 0, raised.lines.join("\n"));
  assert.deepEqual(readBaseline(g).files["lib/a.mjs"], {
    lines: 701,
    allow: "r",
  });
});

test("MZ-8 --update refuses a new entry without a reason and records one with it", () => {
  const r = repo({ "lib/n.mjs": 650 }, { baseline: {} });
  const before = readFileSync(r.baselinePath, "utf8");
  const refused = run(r, { update: true });
  assert.equal(refused.code, 1);
  assert.ok(
    refused.lines.some((l) => l.startsWith("NO REASON lib/n.mjs 650 lines")),
    refused.lines.join("\n"),
  );
  assert.equal(readFileSync(r.baselinePath, "utf8"), before);

  const ok = run(r, { update: true, allow: { "lib/n.mjs": "r" } });
  assert.equal(ok.code, 0, ok.lines.join("\n"));
  assert.deepEqual(readBaseline(r).files["lib/n.mjs"], {
    lines: 650,
    allow: "r",
  });

  const s = repo({ "lib/n.mjs": 650 });
  const seeded = run(s, { update: true, seed: true });
  assert.equal(seeded.code, 0, seeded.lines.join("\n"));
  assert.deepEqual(readBaseline(s).files["lib/n.mjs"], { lines: 650 });
});
