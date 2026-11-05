import assert from "node:assert/strict";
import { test } from "node:test";

import { pnpmFilterInstall } from "../score.mjs";

test("PF-1 pnpmFilterInstall builds the filtered install, hint and marker", () => {
  assert.deepEqual(pnpmFilterInstall("@demo/core"), {
    cmd: "pnpm",
    args: [
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--filter",
      "@demo/core...",
    ],
    label: "pnpm install",
    hint: "pnpm install --frozen-lockfile --filter '@demo/core...'",
    marker: ".ticket-gate-install-done",
  });
});

test("PF-2 an empty filter or one with a space or quote throws", () => {
  const msg = /pnpmFilterInstall: filter must be a package name or pattern$/;
  for (const bad of ["", "a b", "a'b", 'a"b', " x", undefined])
    assert.throws(() => pnpmFilterInstall(bad), msg, JSON.stringify(bad));
});
