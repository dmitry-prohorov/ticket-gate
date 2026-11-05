// Invariants of the engine's step inputs, proved against a synthetic two-step project:
// a path no deny-list names is an input, an engine or tooling path is an input of every step,
// the Stop hook re-proves reused digests and writes nothing, and a skipped selected step
// leaves the receipt unverified.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { bin, gateProject } from "./mutations/__tests__/gate-project.mjs";
import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";
import { stopHookProject } from "./stop-hook-project.mjs";

const SYN = `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [
    step({ id: 'a', when: true, cmd: 'run a', reuse: { deny: ['docs/'] } }),
    step({ id: 'b', when: true, cmd: 'run b', reuse: { deny: ['tools/'] } }),
  ],
  toolPrefixes: ['tools/'],
});
`;

// digest.mjs reads the config at import, so it loads after the chdir.
enterScratchProject(SYN);
const { isDenied, stepDigest } = await import("../digest.mjs");

const state = (entries) => ({
  base: "b".repeat(40),
  versions: { node: "v0", deno: "-" },
  packs: [],
  env: [],
  entries,
});
const digest = (id, entries) =>
  stepDigest(id, `run ${id}`, { state: state(entries) });

test("EI-1 a path no deny-list names is an input of every step", () => {
  assert.equal(isDenied("a", "other/y.txt"), false);
  assert.equal(isDenied("b", "other/y.txt"), false);
  const none = digest("a", []);
  assert.notEqual(digest("a", [["other/y.txt", "A"]]), none);
  assert.notEqual(digest("b", [["other/y.txt", "A"]]), digest("b", []));
  // Control: the deny-list is live. docs/ is denied for a, an input of b.
  assert.equal(isDenied("a", "docs/x.md"), true);
  assert.equal(digest("a", [["docs/x.md", "A"]]), none);
  assert.notEqual(digest("b", [["docs/x.md", "A"]]), digest("b", []));
});

test("EI-2 a tooling path change re-runs every step, even one whose deny-list names tools/", () => {
  assert.equal(isDenied("b", "tools/gate-step.mjs"), false);
  assert.notEqual(digest("b", [["tools/gate-step.mjs", "A"]]), digest("b", []));
  // Control: a step that denies docs/ still ignores a docs path.
  assert.equal(isDenied("a", "docs/x.md"), true);
});

/** Everything under .turbo, by path and content. */
function turboFiles(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p.slice(dir.length)] = readFileSync(p, "utf8");
    }
  };
  walk(join(dir, ".turbo"));
  return out;
}

test("EI-3 the Stop hook recomputes every reused digest and writes nothing", () => {
  const p = stopHookProject();
  const base = p.git("rev-parse", "main").toString().trim();
  p.receipt({
    base,
    results: [
      { id: "check", cmd: "run check", status: "pass" },
      {
        id: "coverage",
        cmd: "run coverage",
        status: "reused",
        digest: p.digestOf("coverage", "run coverage", base),
      },
    ],
  });
  assert.equal(p.gate(), null, "control: an unchanged tree approves");
  p.put(".env.local", "SECRET_CHANGED=1\n");
  const before = turboFiles(p.dir);
  const out = p.gate();
  assert.equal(out?.decision, "block");
  assert.match(out.reason, /reused step coverage/);
  assert.deepEqual(turboFiles(p.dir), before, "the hook wrote something");
});

const verifyProject = (files) =>
  gateProject({
    config: SYN.replace(
      "step({ id: 'b', when: true,",
      "step({ id: 'b', when: (ctx) => ctx.touched('src/'),",
    ).replaceAll("cmd: 'run ", 'cmd: \'node -e "" # '),
    registry: null,
    files: { ".gitignore": ".turbo/\n", ...files },
  });
const receiptOf = (dir) =>
  JSON.parse(readFileSync(join(dir, ".turbo", "ticket-verify.json"), "utf8"));

test("EI-4 a skipped selected step is not verified; skipping an unselected step is a no-op", () => {
  const selected = verifyProject();
  selected.put("src/one.txt", "x\n");
  const red = bin(selected.dir, ["verify", "--skip=b"]);
  assert.notEqual(red.status, 0, red.out);
  const receipt = receiptOf(selected.dir);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.results.find((r) => r.id === "b").status, "skipped");

  const unselected = verifyProject();
  unselected.put("docs/x.md", "x\n");
  const green = bin(unselected.dir, ["verify", "--skip=b"]);
  assert.equal(green.status, 0, green.out);
  assert.equal(receiptOf(unselected.dir).ok, true);
});
