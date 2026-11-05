// e2e units are ledgered per unit and reused only on an identical unit digest.
import assert from "node:assert/strict";
import { test } from "node:test";

import { enterScratchProject } from "../../engine/test/scratch-project.mjs";

// the pack reads the project root through the engine at import
enterScratchProject();
const { planSpecs } = await import("../e2e-units.mjs");

test("EI-5 units are reused only on an identical unit digest", () => {
  const line = (file, digest) => ({
    id: "e2e-spec",
    file,
    digest,
    status: "pass",
    ranAt: "T",
  });
  const plan = planSpecs({
    selected: ["u1", "u2"],
    inputs: new Map(),
    digestOf: (f) => `now:${f}`,
    specLedger: [line("u1", "now:u1"), line("u2", "older:u2")],
    fresh: false,
    alwaysRun: new Set(),
  });
  assert.deepEqual(
    plan.reused.map((r) => r.file),
    ["u1"],
  );
  assert.deepEqual(plan.run, ["u2"]);
});
