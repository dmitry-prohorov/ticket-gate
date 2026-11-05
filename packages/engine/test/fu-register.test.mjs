// The follow-up register: file format round trip, row parsing and the close command, against
// temp folders only.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { parseFile, parseRow, run, serialiseFile } from "../fu.mjs";

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const fu = (n, suffix = "") => `FU${n}${suffix}`;

const mk = (files) => {
  const root = mkdtempSync(join(tmpdir(), "fu-register-"));
  roots.push(root);
  const dir = join(root, "register");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return dir;
};

const exec = (dir, argv) => {
  const out = [];
  const err = [];
  const code = run(argv, {
    dir,
    label: "register",
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out, err };
};

const snapshot = (dir) =>
  Object.fromEntries(
    readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), "utf8")]),
  );

test("L-1 values that need quoting are written JSON-quoted, plain ones are not", () => {
  const needing = [
    "a: b",
    "has #hash",
    " ## lead",
    '"quoted"',
    "'single'",
    "`tick`",
    "ends with:",
    "true",
    "Yes",
    "null",
    "n",
    "1st",
    "tail ",
  ];
  const plain = ["plain value", "(parenthesised) start"];
  for (const v of [...needing, ...plain]) {
    const text = serialiseFile({
      id: fu(1),
      status: "open",
      owner: v,
      body: "b.",
    });
    const line = text.split("\n").find((l) => l.startsWith("owner: "));
    const raw = line.slice("owner: ".length);
    assert.equal(raw.startsWith('"'), needing.includes(v), `${v}: quoted`);
    if (needing.includes(v)) assert.equal(raw, JSON.stringify(v), v);
    else assert.equal(raw, v, v);
    assert.equal(parseFile(text).data.owner, v, `${v}: round trip`);
  }
  const text = serialiseFile({
    id: `${fu(26)} (A-01)`,
    status: "open",
    owner: "a: b",
    body: "b.",
  });
  assert.match(text, /^id: FU26 \(A-01\)$/m);
  assert.match(text, /^owner: "a: b"$/m);
});

test("L-4 an Owner or Fixed in that is not trailing is refused, naming the id", () => {
  const bad = [
    [fu(5), `- [x] **${fu(5)}** Body. Fixed in: A (b). Owner: C.`],
    [fu(6), `- [ ] **${fu(6)}** Body. Owner: A. More. Owner: B.`],
    [fu(7), `- [ ] **${fu(7)}** Body Owner: A.`],
    [fu(8), `- [x] **${fu(8)}** Body. Fixed in: A (b). Fixed in: C (d).`],
  ];
  for (const [id, row] of bad)
    assert.throws(
      () => parseRow(row),
      new RegExp(`${id}: Owner/Fixed in not trailing`),
      row,
    );
  const ok = parseRow(`- [x] **${fu(9)}** Body. Owner: A. Fixed in: B (c).`);
  assert.deepEqual([ok.owner, ok.fixedIn], ["A.", "B (c)."]);
});

test("C-5 close refuses an id that is already done and leaves every file unchanged", () => {
  const done = serialiseFile({
    id: fu(9),
    status: "done",
    fixedIn: "X-01 (abc).",
    body: "Done thing.",
  });
  const open = serialiseFile({
    id: fu(203),
    status: "open",
    owner: "someone",
    body: "Open thing.",
  });
  const dir = mk({ [`${fu(9)}.md`]: done, [`${fu(203)}.md`]: open });
  const before = snapshot(dir);
  const r = exec(dir, ["close", fu(9), "--by", "A-1", "--sha", "abc"]);
  assert.equal(r.code, 1);
  assert.match(
    r.err.join(),
    /close: FU9 is already done \(fixed-in: X-01 \(abc\)\.\)/,
  );
  assert.deepEqual(r.out, []);
  assert.deepEqual(snapshot(dir), before);
  const ok = exec(dir, ["close", fu(203), "--by", "A-1", "--sha", "abc"]);
  assert.equal(ok.code, 0);
  assert.equal(parseFile(snapshot(dir)[`${fu(203)}.md`]).data.status, "done");
});
