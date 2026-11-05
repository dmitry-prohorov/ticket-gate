// The tree hash and the line blame, against a throwaway git project. The module fixes its root
// from the working directory at import, so one project serves the whole file and each case
// starts by moving the branch to a fresh commit state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "tree-hash-")));
after(() => {
  process.chdir(tmpdir());
  rmSync(dir, { recursive: true, force: true });
});
const git = (...a) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd: dir,
    stdio: "pipe",
  });
const put = (f, body) => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), body);
};
const commitAll = (msg) => {
  git("add", "-A");
  git("commit", "-qm", msg);
};

git("init", "-q", "-b", "main");
put("gate.config.mjs", "export default {};\n");
put("base.txt", "base\n");
put("notes/x.md", "x\n");
put(".ticket-gate/tree.json", JSON.stringify({ exclude: ["notes"] }));
commitAll("base");
git("checkout", "-qb", "feat");
process.chdir(dir);
const m = await import("../tree.mjs");

test("TH-3 a commit touching only an excluded directory leaves treeHashAt unchanged", () => {
  put("src/a.txt", "one\n");
  commitAll("code");
  const before = m.treeHashAt("HEAD");
  put("notes/phase.md", "- [x] done\n");
  commitAll("tick");
  assert.equal(m.treeHashAt("HEAD"), before);
  assert.equal(
    m.treeEntriesAt("HEAD").find(([p]) => p.startsWith("notes/")),
    undefined,
  );
  put("src/a.txt", "two\n");
  commitAll("code again");
  assert.notEqual(m.treeHashAt("HEAD"), before);
});

test("TH-5 lineCommit: a committed line gives its commit; uncommitted, staged and untracked give null", () => {
  put("src/b.txt", "one\ntwo\n");
  commitAll("b");
  const sha = git("rev-parse", "HEAD").toString().trim();
  assert.equal(m.lineCommit("src/b.txt", 1), sha);
  put("src/b.txt", "ONE\ntwo\n");
  assert.equal(m.lineCommit("src/b.txt", 1), null);
  assert.equal(m.lineCommit("src/b.txt", 2), sha);
  git("add", "src/b.txt");
  assert.equal(m.lineCommit("src/b.txt", 1), null);
  put("src/untracked.txt", "u\n");
  assert.equal(m.lineCommit("src/untracked.txt", 1), null);
});

test("TH-R1 treeHash({ exclude }) ignores a change under an excluded prefix and moves on any other; the default is unchanged", () => {
  put("src/new.txt", "hello\n");
  put("x/a.txt", "one\n");
  const ex = { exclude: ["x/"] };
  const before = m.treeHash(ex);
  const plain = m.treeHash();
  put("x/a.txt", "two\n");
  put("x/b/new.txt", "nested\n");
  assert.equal(m.treeHash(ex), before, "a change under x/ is excluded");
  assert.notEqual(m.treeHash(), plain, "the default still sees x/");
  assert.notEqual(m.treeHash(ex), m.treeHash());
  assert.equal(
    m.treeEntries(m.baseRef(), ex).some(([p]) => p.startsWith("x/")),
    false,
  );
  // The prefix ends with a slash: a sibling directory sharing the name is not excluded.
  put("xy/c.txt", "sibling\n");
  assert.notEqual(m.treeHash(ex), before);
  rmSync(join(dir, "xy"), { recursive: true });
  assert.equal(m.treeHash(ex), before);
});
