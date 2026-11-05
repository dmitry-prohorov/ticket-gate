// Planner behaviour over a synthetic stack: an option can select a step, a step that needs a fresh
// seed gets one reset before it, and the stack preflight lists the stack steps that run.
import assert from "node:assert/strict";
import { test } from "node:test";

import { enterScratchProject } from "./scratch-project.mjs";

// plan.mjs loads the project config at import.
enterScratchProject();
const { defineGate, step } = await import("../config.mjs");
const { planFor } = await import("../plan.mjs");

const MR = "mutation-registry";
const s = (id, when, extra = {}) =>
  step({ id, when, cmd: `run ${id}`, reuse: false, stack: "st", ...extra });
const config = defineGate({
  steps: [
    step({ id: "preflight", when: false, cmd: "up", reuse: false }),
    s("db", ["db/**"], { cmd: "reset" }),
    s("seed", false, { cmd: "reset" }),
    s("integration", ["db/**"]),
    s("e2e", ["web/**"]),
    s(MR, false, { option: "registry" }),
  ],
  stacks: {
    st: {
      reset: { step: "seed", before: ["e2e", MR], satisfiedBy: ["db"] },
      health: { step: "preflight", preflight: (ids) => `up ${ids.join(",")}` },
    },
  },
});
const plan = (paths, opts = {}) =>
  planFor(config, paths, { exists: () => true, base: "HEAD", ...opts });
const ids = (p) => p.steps.map((x) => x.id);
const byId = (p, id) => p.steps.find((x) => x.id === id);

test("VT-MR1 an option that says when:true plans its step; when:false leaves it unplanned", () => {
  const on = plan(["web/x"], { registry: { when: true, count: 2 } });
  assert.ok(ids(on).includes(MR), ids(on).join());
  assert.ok(ids(on).indexOf(MR) > ids(on).indexOf("e2e"));
  assert.match(byId(on, "preflight").cmd, /\bmutation-registry\b/);
  const off = plan(["web/x"], { registry: { when: false, count: 0 } });
  assert.equal(byId(off, MR), undefined);
  assert.ok(off.notRun.some((x) => x.id === MR));
  assert.equal(byId(plan(["web/x"]), MR), undefined, "no option: not selected");
});

test("VT-MR5 a registry step without e2e still gets one seed reset before it", () => {
  const reg = { registry: { when: true, count: 1 } };
  const alone = ids(plan(["tools/x.mjs"], reg));
  assert.ok(alone.includes("seed"), alone.join());
  assert.ok(alone.indexOf("seed") < alone.indexOf(MR));
  // Controls: with e2e one reset serves both; a db step satisfies it; unselected needs none.
  const both = plan(["web/x"], reg);
  assert.equal(ids(both).filter((i) => i === "seed").length, 1);
  assert.ok(ids(both).indexOf("seed") < ids(both).indexOf("e2e"));
  assert.equal(byId(plan(["db/m.sql"], reg), "seed"), undefined);
  assert.equal(
    byId(
      plan(["tools/x.mjs"], { registry: { when: false, count: 0 } }),
      "seed",
    ),
    undefined,
  );
});

test("VT-P1 the stack preflight is planned when a stack step runs and lists exactly those", () => {
  const web = plan(["web/x"]);
  assert.equal(ids(web)[0], "preflight");
  assert.equal(byId(web, "preflight").cmd, "up seed,e2e");
  assert.equal(
    byId(plan(["db/m.sql", "web/x"]), "preflight").cmd,
    "up db,integration,e2e",
  );
  // every stack step skipped or unselected: nothing to check
  assert.equal(
    byId(plan(["web/x"], { skip: ["e2e", "seed"] }), "preflight"),
    undefined,
  );
  assert.equal(byId(plan(["docs/x.md"]), "preflight"), undefined);
});

test("VT-P3a a diff that needs a fresh seed plans the seed reset immediately before e2e", () => {
  const got = plan(["web/x"]);
  const at = ids(got).indexOf("e2e");
  assert.equal(ids(got)[at - 1], "seed");
  assert.equal(byId(got, "seed").cmd, "reset");
  // Control: when the db step runs the reset, the seed step is not planned.
  assert.equal(byId(plan(["db/m.sql", "web/x"]), "seed"), undefined);
});
