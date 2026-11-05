// The move proof: which added lines no removed line pays for, which lines are import or
// re-export statements (exempt), and the receipt field that carries the result to the Stop hook.
// move-proof.mjs and receipt.mjs read the project root at import, so they load after
// the scratch project is entered.
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { enterScratchProject } from "./scratch-project.mjs";

const leave = enterScratchProject();
const { importLineNumbers, matchMoves } = await import("../move-proof.mjs");
const { buildReceipt } = await import("../receipt.mjs");
after(leave);

const add = (text, line = 1, path = "a.mjs") => ({ path, line, text });

test("MP-1 an added line with no removed twin is listed", () => {
  const a = add("const x = 2;", 4);
  assert.deepEqual(matchMoves([a], ["const x = 1;"]), [a]);
});

test("MP-3 only an import or re-export statement is exempt", () => {
  const lines = [
    "export function fresh() {", // 1
    "importer();", // 2
    "import { a,", // 3
    "  b,", // 4
    "} from './x.mjs';", // 5
    "export * from './y.mjs';", // 6
    "import './z.mjs';", // 7
    "const q = 1;", // 8
  ];
  assert.deepEqual([...importLineNumbers(lines)], [3, 4, 5, 6, 7]);
  const unmatched = matchMoves([add(lines[0], 1), add(lines[1], 2)], []);
  assert.deepEqual(
    unmatched.map((u) => u.text),
    ["export function fresh() {", "importer();"],
  );
});

test("MP-4 each removed line matches one added line only", () => {
  const unmatched = matchMoves(
    [add("const x = 1;", 1), add("const x = 1;", 9)],
    ["const x = 1;"],
  );
  assert.deepEqual(unmatched, [add("const x = 1;", 9)]);
});

test("MP-R1 the receipt carries moveProof, last, for the stop hook", () => {
  const proof = { unmatched: 0, base: "b" };
  const r = buildReceipt({
    treeHash: "t",
    ranAt: "now",
    ok: true,
    results: [],
    size: { lines: 1, level: "ok" },
    base: "b",
    moveProof: proof,
  });
  assert.deepEqual(r.moveProof, proof);
  assert.equal(Object.keys(r).at(-1), "moveProof");
});
