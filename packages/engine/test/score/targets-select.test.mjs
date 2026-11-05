import assert from "node:assert/strict";
import { test } from "node:test";

import { mutationTargets } from "./__tests__/demo.mjs";

const D = "packages/core/src/domain/";
const has =
  (...f) =>
  (p) =>
    f.map((x) => D + x).includes(p);

test("ST-1 an excluded path changed directly is never a target", () => {
  const exists = has("index.ts", "constants.ts", "calendar.ts");
  assert.deepEqual(
    mutationTargets([`${D}index.ts`, `${D}constants.ts`], exists),
    [],
  );
  assert.deepEqual(
    mutationTargets([`${D}index.ts`, `${D}calendar.ts`], exists),
    [`${D}calendar.ts`],
  );
});

test("ST-2 a file deleted on the branch is not a target", () => {
  const exists = has("calendar.ts");
  assert.deepEqual(
    mutationTargets([`${D}gone.ts`, `${D}calendar.ts`], exists),
    [`${D}calendar.ts`],
  );
  assert.deepEqual(mutationTargets([`${D}gone.ts`], exists), []);
});

test("ST-3 a changed test file selects the module beside it, not itself", () => {
  const exists = has("calendar.ts", "calendar.test.ts");
  assert.deepEqual(mutationTargets([`${D}calendar.test.ts`], exists), [
    `${D}calendar.ts`,
  ]);
});
