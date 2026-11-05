// The failure summary the verify command writes after a red run: the fallback for output no
// recogniser reads, the per-step entry cap, and the stale-file cleanup on a green run.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { MAX_ENTRIES, renderFailures, writeFailures } from "../failures.mjs";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const TSC_PAREN = `bad.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`;

test("FV-10 an unrecognised failed output renders a tail entry with its last 15 lines", () => {
  const out = Array.from({ length: 40 }, (_, i) => `tool line ${i + 1}`).join(
    "\n",
  );
  const md = renderFailures({
    treeHash: "h",
    ranAt: "t",
    failures: [{ id: "functions", cmd: "run functions", why: "w", out }],
  });
  assert.match(md, /- \[tail\] output tail/);
  assert.ok(md.includes("tool line 40"));
  assert.ok(md.includes("tool line 26"));
  assert.ok(!md.includes("tool line 25\n"));
});

test("FV-12 a step lists at most MAX_ENTRIES entries and counts the rest", () => {
  const rows = Array.from(
    { length: MAX_ENTRIES + 5 },
    (_, i) => `  ${i + 1}:1  error  Unexpected var number ${i}  no-var`,
  ).join("\n");
  const out = `/repo/lib/a.js\n${rows}\n\n✖ 25 problems (25 errors, 0 warnings)\n`;
  const md = renderFailures({
    treeHash: "h",
    ranAt: "t",
    failures: [{ id: "check", cmd: "run check", why: "w", out }],
  });
  assert.equal(
    md.split("\n").filter((l) => l.startsWith("- [")).length,
    MAX_ENTRIES,
  );
  assert.match(
    md,
    /^- \.\.\. and 5 more \(full output: the verify:ticket log\)$/m,
  );
});

test("FV-13 a green call deletes the failures file a red call wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "failures-"));
  dirs.push(dir);
  const path = join(dir, ".turbo", "failures.md");
  const red = {
    treeHash: "h1",
    ranAt: "t1",
    failures: [{ id: "check", cmd: "run check", why: "w", out: TSC_PAREN }],
  };
  assert.equal(writeFailures(path, red), path);
  assert.match(readFileSync(path, "utf8"), /treeHash: h1 {3}ranAt: t1/);
  assert.equal(
    writeFailures(path, { treeHash: "h2", ranAt: "t2", failures: [] }),
    null,
  );
  assert.equal(existsSync(path), false);
});
