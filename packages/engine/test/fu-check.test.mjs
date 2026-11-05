// The follow-up check: one rule per test, fed file texts directly.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkFollowUps, fileIdOf } from "../fu.mjs";

const fu = (n, suffix = "") => `FU${n}${suffix}`;

const readmeNaming = (...ids) =>
  [
    "# Register",
    `Ids ${ids.join(", ")} were used twice early on.`,
    "",
    "## Collisions / ambiguities",
    "",
    `Ids ${fu(50)} were used twice here, which is never parsed.`,
  ].join("\n");
const README = readmeNaming(fu(1), fu(7));

const file = (id, { status = "open", extra = "", name } = {}) => ({
  name: name ?? `${fileIdOf(id)}.md`,
  text:
    `---\nid: ${id}\nstatus: ${status}\n` +
    (status === "open" ? "owner: someone\n" : "fixed-in: T (abc).\n") +
    `${extra}---\nsummary.\n`,
});
const raw = (name, text) => ({ name, text });
const check = (files, over = {}) =>
  checkFollowUps({
    files,
    readme: README,
    pointer: "# pointer\n",
    dir: "register",
    pointerPath: "POINTER.md",
    ...over,
  });

test("K-1 the file name must match the id", () => {
  assert.deepEqual(check([file(fu(12))]), []);
  const wrong = check([file(fu(13), { name: `${fu(12)}.md` })]);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0], /register\/FU12\.md: .*FU13 belongs in FU13\.md/);
  const suffixed = check([file(`${fu(13)} (X-1)`, { name: `${fu(13)}.md` })]);
  assert.equal(suffixed.length, 1);
  assert.match(suffixed[0], /FU13-X-1\.md/);
});

test("K-3 status must be open or done", () => {
  const none = check([
    raw(`${fu(12)}.md`, `---\nid: ${fu(12)}\nowner: x\n---\nsummary.\n`),
  ]);
  assert.equal(none.length, 1);
  assert.match(none[0], /status is missing/);
  const closed = check([
    raw(
      `${fu(12)}.md`,
      `---\nid: ${fu(12)}\nstatus: closed\nowner: x\n---\ns.\n`,
    ),
  ]);
  assert.equal(closed.length, 1);
  assert.match(closed[0], /status is "closed"/);
  assert.deepEqual(check([file(fu(12)), file(fu(14), { status: "done" })]), []);
});

test("K-4a an open follow-up needs an owner", () => {
  const e = check([
    raw(`${fu(12)}.md`, `---\nid: ${fu(12)}\nstatus: open\n---\nsummary.\n`),
  ]);
  assert.equal(e.length, 1);
  assert.match(e[0], /open with no "owner:"/);
});

test("K-4b a done follow-up needs fixed-in", () => {
  const e = check([
    raw(
      `${fu(12)}.md`,
      `---\nid: ${fu(12)}\nstatus: done\nowner: x\n---\nsummary.\n`,
    ),
  ]);
  assert.equal(e.length, 1);
  assert.match(e[0], /done with no "fixed-in:"/);
});

test("K-5 an unknown key fails", () => {
  const k = check([file(fu(12), { extra: "owners: x\n" })]);
  assert.equal(k.length, 1);
  assert.match(k[0], /unknown key "owners"/);
  assert.deepEqual(check([file(fu(12), { extra: "severity: LOW\n" })]), []);
});

test("K-6 a follow-up row in the pointer page fails", () => {
  const e = check([], { pointer: `# p\n\n- [ ] **${fu(1)}** x\n` });
  assert.equal(e.length, 1);
  assert.match(e[0], /POINTER\.md holds a follow-up row/);
  const upper = check([], { pointer: `# p\n\n- [X] **${fu(1)}** x\n` });
  assert.equal(upper.length, 1);
  assert.deepEqual(check([], { pointer: "# p\n\n- [x] done list\n" }), []);
  assert.deepEqual(check([], { pointer: null }), []);
});

test("K-7 numbers named in the README collision sentence are exempt from the duplicate rule", () => {
  const pair = [file(fu(7)), file(`${fu(7)} (X)`)];
  assert.deepEqual(check(pair), []);
  const e = check(pair, { readme: readmeNaming(fu(1), fu(9)) });
  assert.equal(e.length, 1);
  assert.match(e[0], /FU7 \(X\) duplicates FU7/);
  assert.deepEqual(check([file(fu(1)), file(`${fu(1)} (Y)`)]), []);
});
