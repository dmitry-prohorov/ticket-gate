// The hooks the pack no longer carries: the nightly record is the gate's, not the pack's.
import assert from "node:assert/strict";
import { test } from "node:test";

import { supabaseNext } from "../index.mjs";

test("PK-1 the pack carries no nightly hook", () => {
  assert.equal("nightly" in supabaseNext({ tools: {} }), false);
  assert.equal(
    "nightly" in supabaseNext({ tools: {}, nightlyStack: { preflight: ["a"], reset: ["b"] } }),
    false,
  );
});

test("PK-2 the pack has no e2e hook and no e2eUnits", () => {
  const pack = supabaseNext({ tools: {} });
  assert.equal("e2e" in pack, false);
  assert.equal("e2eUnits" in pack, false);
});
