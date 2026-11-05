// The engine finds its project by walking up from the working directory (findRoot) and reads
// the tree exclusion from .ticket-gate/tree.json. Temp repos under os.tmpdir().
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
import { pathToFileURL } from "node:url";
import { findRoot } from "../root.mjs";

const ENGINE = (f) => pathToFileURL(join(import.meta.dirname, "..", f)).href;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const tmp = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "root-tree-")));
  dirs.push(dir);
  return dir;
};
const put = (dir, f, body) => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), body);
};
const git = (dir, ...a) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd: dir,
    stdio: "pipe",
  })
    .toString()
    .trim();

test("DR-1 the root is the nearest dir holding gate.config.mjs", () => {
  const outer = tmp();
  put(outer, "gate.config.mjs", "export default {};\n");
  put(outer, "a/b/x.txt", "x\n");
  assert.equal(findRoot(join(outer, "a", "b")), outer);
  const inner = join(outer, "a");
  put(outer, "a/gate.config.mjs", "export default {};\n");
  assert.equal(findRoot(join(inner, "b")), inner);
  assert.equal(findRoot(outer), outer);
  assert.throws(
    () => findRoot(tmp()),
    /ticket-gate: no gate\.config\.mjs at or above /,
  );
});

// An in-repo run of the engine's tree hash, with the working directory (and so the root) a temp repo.
const hashIn = (dir) =>
  execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(ENGINE("tree.mjs"))}); console.log(m.treeHash());`,
    ],
    { cwd: dir, encoding: "utf8" },
  ).trim();

test("DR-4 the tree hash excludes exactly tree.json exclude", () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  put(dir, "gate.config.mjs", "export default {};\n");
  put(dir, ".ticket-gate/tree.json", '{ "exclude": ["notes"] }\n');
  put(dir, "notes/x.md", "one\n");
  put(dir, "src/a.txt", "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-qb", "feat");
  put(dir, "src/b.txt", "b\n");
  const before = hashIn(dir);
  put(dir, "notes/x.md", "two\n");
  put(dir, "notes/new.md", "new\n");
  assert.equal(hashIn(dir), before, "notes is excluded");
  put(dir, "src/a.txt", "two\n");
  assert.notEqual(hashIn(dir), before, "src is not");
  put(dir, "src/a.txt", "one\n");
  assert.equal(hashIn(dir), before);
  rmSync(join(dir, ".ticket-gate", "tree.json"));
  const bare = hashIn(dir);
  put(dir, "notes/x.md", "three\n");
  assert.notEqual(hashIn(dir), bare, "no tree.json excludes nothing");
});
