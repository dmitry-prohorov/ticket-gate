// The pack's nightly record and the hooks it no longer carries.
import assert from "node:assert/strict";
import { test } from "node:test";

import { supabaseNext } from "../index.mjs";

test("PK-1 the pack nightly hook reads the bound nightly record", () => {
  const record = { latest: { sha: "n1", status: "green" }, history: [] };
  const seen = [];
  const pack = supabaseNext({
    tools: {
      nightly: {
        nightlyDir: () => "dir-of-nightly",
        readNightly: (dir) => {
          seen.push(dir);
          return record;
        },
      },
    },
  });
  assert.equal(pack.nightly.read(), record);
  assert.deepEqual(seen, ["dir-of-nightly"]);
});

test("PK-2 the pack has no e2e hook and no e2eUnits", () => {
  const pack = supabaseNext({ tools: {} });
  assert.equal("e2e" in pack, false);
  assert.equal("e2eUnits" in pack, false);
  assert.equal(typeof pack.nightly.line, "function");
});
