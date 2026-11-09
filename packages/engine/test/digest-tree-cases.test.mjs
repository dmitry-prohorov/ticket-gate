// Ported cases of the step digest (digest.mjs) and the tree hash (tree.mjs): what a digest
// depends on, and what the hash of a branch's changes does and does not see. Each test keeps the id
// of the case it was ported from. digest.mjs and tree.mjs fix their root from the working
// directory at import, so one private throwaway git project (made by enterScratchProject, a
// mkdtemp dir of its own) serves the whole file; every test starts by moving a fresh branch off
// `main` and sweeping the tree. Nothing here names a consumer: the steps are synthetic, and the
// two step ids `deno-check` and `functions` are the ones the engine itself gives the deno version.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";

const SYN = `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [
    step({ id: 'a', when: true, cmd: 'run a', reuse: { deny: ['docs/', '*.md'] } }),
    step({ id: 'b', when: true, cmd: 'run b', reuse: { deny: [] } }),
    step({ id: 'deno-check', when: true, cmd: 'run deno-check', reuse: { deny: [] } }),
    step({ id: 'functions', when: true, cmd: 'run functions', reuse: { deny: [] } }),
  ],
  toolPrefixes: [],
  dataPaths: {},
});
`;

const leave = enterScratchProject(SYN);
after(leave);
const dir = process.cwd();
const git = (...a) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd: dir,
    stdio: "pipe",
  })
    .toString()
    .trim();
const put = (f, body = "x\n") => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), body);
};
const commitAll = (msg) => {
  git("add", "-A");
  git("commit", "-qm", msg);
};

git("init", "-q", "-b", "main");
put(".gitignore", ".env*\n");
put("base.txt", "base\n");
put("notes/x.md", "x\n");
put("docs/x.md", "x\n");
put(".ticket-gate/tree.json", JSON.stringify({ exclude: ["notes"] }));
commitAll("base");

const { VERIFIED_STATUSES, inputState, isDenied, stepDigest, STEP_INPUTS } =
  await import("../digest.mjs");
const tree = await import("../tree.mjs");

let n = 0;
/**
 * A clean tree on a new branch `feat` cut from `main`. `extra` files are committed to `main`
 * first (the branch's base), under names no other test uses.
 */
function fresh(extra = {}) {
  git("checkout", "-qf", "main");
  git("clean", "-fdxq");
  if (Object.keys(extra).length) {
    for (const [f, body] of Object.entries(extra)) put(f, body);
    commitAll(`base ${n++}`);
  }
  git("checkout", "-qf", "-B", "feat", "main");
}

const V = { node: "v22.0.0", deno: "deno 2.0.0" };
const IDS = Object.keys(STEP_INPUTS);
const digest = (id, over = {}) =>
  stepDigest(id, `run ${id}`, { base: "main", versions: V, ...over });
const all = (over) =>
  Object.fromEntries(IDS.map((id) => [id, digest(id, over)]));

test("P81 SI-1 the digest is stable across commit, stage and untracked for the same bytes", () => {
  fresh();
  assert.deepEqual(IDS, ["a", "b", "deno-check", "functions"]);
  put("src/one.txt", "one\n");
  const untracked = all();
  git("add", "-A");
  assert.deepEqual(all(), untracked, "staged");
  git("commit", "-qm", "one");
  assert.deepEqual(all(), untracked, "committed");
  put("src/one.txt", "two\n");
  for (const id of IDS)
    assert.notEqual(digest(id), untracked[id], `${id} moves on a changed byte`);
});

test("P81 SI-3 another base sha moves the digest", () => {
  fresh();
  const state = inputState({ base: "main", versions: V });
  const other = { ...state, base: "f".repeat(40) };
  for (const id of IDS)
    assert.notEqual(
      stepDigest(id, "run", { state }),
      stepDigest(id, "run", { state: other }),
      id,
    );
});

test("P81 SI-4 another cmd moves the digest", () => {
  fresh();
  for (const id of IDS)
    assert.notEqual(
      stepDigest(id, "one", { base: "main", versions: V }),
      stepDigest(id, "two", { base: "main", versions: V }),
      id,
    );
});

test("P81 SI-5 the node version moves every digest; the deno version only its steps", () => {
  fresh();
  for (const id of IDS)
    assert.notEqual(
      digest(id),
      digest(id, { versions: { ...V, node: "v99.0.0" } }),
      id,
    );
  const deno2 = { ...V, deno: "deno 9.9.9" };
  for (const id of IDS)
    assert.equal(
      digest(id) !== digest(id, { versions: deno2 }),
      id === "deno-check" || id === "functions",
      id,
    );
});

test("P81 SI-6 b a nested env file under a denied prefix still moves every digest", () => {
  fresh();
  const file = "docs/sub/.env.local";
  assert.equal(isDenied("a", file), true, "the prefix is denied for step a");
  const none = all();
  put(file, "A=1\n");
  const one = all();
  put(file, "A=2\n");
  const two = all();
  rmSync(join(dir, file));
  const gone = all();
  put(file, "A=1\n");
  const again = all();
  for (const id of IDS) {
    assert.notEqual(one[id], none[id], `added ${id}`);
    assert.notEqual(two[id], one[id], `changed ${id}`);
    assert.equal(gone[id], none[id], `deleted ${id}`);
    assert.equal(again[id], one[id], `restored ${id}`);
  }
});

test("P81 SI-6b an env file inside node_modules is not an input", () => {
  fresh();
  const before = all();
  put("node_modules/x/.env", "A=1\n");
  assert.deepEqual(all(), before);
  put("pkg/.env", "A=1\n");
  for (const id of IDS)
    assert.notEqual(
      digest(id),
      before[id],
      `${id}: a control env file moves it`,
    );
});

test("P81 SI-9 b stepDigest of an unknown step throws", () => {
  fresh();
  assert.throws(
    () => stepDigest("nope", "x", { base: "main", versions: V }),
    /stepDigest: unknown step nope/,
  );
  assert.throws(
    () =>
      stepDigest("nope", "x", {
        state: inputState({ base: "main", versions: V }),
      }),
    /stepDigest: unknown step nope/,
  );
  assert.match(digest("a"), /^[0-9a-f]{64}$/);
});

test("P81 SI-10 VERIFIED_STATUSES is exactly pass, human, reused and frozen", () => {
  assert.deepEqual([...VERIFIED_STATUSES], ["pass", "human", "reused"]);
  assert.ok(Object.isFrozen(VERIFIED_STATUSES));
});

test("P81 SI-G1 the gate config file is denied for no step and an edit moves every digest", () => {
  fresh();
  for (const id of IDS)
    assert.equal(isDenied(id, "gate.config.mjs"), false, id);
  const before = all();
  put("gate.config.mjs", "// edited\n");
  for (const id of IDS)
    assert.notEqual(digest(id), before[id], `${id} after the edit`);
});

test("P81 same bytes give the same hash untracked, staged and committed", () => {
  fresh();
  put("src/new.txt", "hello\n");
  const untracked = tree.treeHash();
  git("add", "src/new.txt");
  const staged = tree.treeHash();
  git("commit", "-qm", "add");
  const committed = tree.treeHash();
  assert.equal(staged, untracked);
  assert.equal(committed, untracked);
  assert.match(untracked, /^[0-9a-f]{64}$/);
});

test("P81 untracked byte moves the hash", () => {
  fresh();
  put("src/new.txt", "hello\n");
  const before = tree.treeHash();
  put("src/new.txt", "hellp\n");
  assert.notEqual(tree.treeHash(), before);
  assert.ok(tree.untrackedFiles().includes("src/new.txt"));
});

test("P81 deleted moves the hash and lists a - entry", () => {
  fresh();
  const before = tree.treeHash();
  rmSync(join(dir, "base.txt"));
  assert.notEqual(tree.treeHash(), before);
  assert.deepEqual(
    tree.treeEntries().find(([p]) => p === "base.txt"),
    ["base.txt", "-"],
  );
});

test("P81 rename moves the hash and lists both paths", () => {
  fresh({ "mv-old.txt": "keep\n" });
  const before = tree.treeHash();
  renameSync(join(dir, "mv-old.txt"), join(dir, "mv-new.txt"));
  git("add", "-A");
  assert.notEqual(tree.treeHash(), before);
  const paths = tree.changedPaths();
  assert.ok(paths.includes("mv-old.txt"), "old path listed");
  assert.ok(paths.includes("mv-new.txt"), "new path listed");
});

test("P81 exec bit change moves the hash", () => {
  fresh({ "exec-run.sh": "#!/bin/sh\n" });
  put("exec-run.sh", "#!/bin/sh\necho changed\n"); // already in the diff
  const before = tree.treeHash();
  chmodSync(join(dir, "exec-run.sh"), 0o755);
  assert.notEqual(tree.treeHash(), before);
  assert.match(
    Object.fromEntries(tree.treeEntries())["exec-run.sh"],
    /^100755 /,
  );
});

test("P81 odd names changedPaths returns spaces and non-ASCII verbatim", () => {
  fresh();
  const odd = "sp ace/été.txt";
  put(odd, "x\n");
  assert.ok(tree.changedPaths().includes(odd), "untracked");
  commitAll("odd");
  assert.ok(tree.changedPaths().includes(odd), "committed");
});

test("P81 sorted treeEntries is sorted and excludes the excluded dir", () => {
  fresh();
  put("z.txt");
  put("B.txt");
  put("a/b.txt");
  put("notes/new.md");
  put("notes/x.md", "edited\n");
  assert.deepEqual(
    tree.treeEntries().map(([p]) => p),
    ["B.txt", "a/b.txt", "z.txt"],
  );
});

test("P81 2 MiB treeHash survives untracked names past 2 MiB", () => {
  fresh();
  const big = join(dir, "many");
  mkdirSync(big);
  for (let i = 0; i < 20000; i++)
    writeFileSync(
      join(big, `${String(i).padStart(5, "0")}-${"x".repeat(94)}`),
      "",
    );
  assert.match(tree.treeHash(), /^[0-9a-f]{64}$/);
  assert.equal(tree.treeEntries().length, 20000);
});

test("P81 TH-1 treeHashAt(HEAD) equals treeHash() on a clean tree across every kind of change", () => {
  fresh({ "th1-old.txt": "old\n", "th1-edit.txt": "v1\n" });
  put("src/added.txt", "added\n");
  put("th1-edit.txt", "v2\n");
  git("rm", "-q", "base.txt");
  git("mv", "th1-old.txt", "th1-renamed.txt");
  put("run.sh", "#!/bin/sh\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  symlinkSync("th1-edit.txt", join(dir, "link"));
  put("notes/phase.md", "- [x] done\n");
  commitAll("everything");
  assert.equal(tree.treeHashAt("HEAD"), tree.treeHash());
  assert.match(tree.treeHashAt("HEAD"), /^[0-9a-f]{64}$/);
  const states = Object.fromEntries(tree.treeEntriesAt("HEAD"));
  assert.equal(states["base.txt"], "-");
  assert.match(states["run.sh"], /^100755 /);
  assert.match(states.link, /^120000 /);
  assert.match(states["th1-edit.txt"], /^100644 /);
  assert.equal(states["notes/phase.md"], undefined);
});

test("P81 TH-2 a committed change moves treeHashAt and states come from the commit", () => {
  fresh();
  put("src/a.txt", "one\n");
  commitAll("one");
  const first = tree.treeHashAt("HEAD");
  put("src/a.txt", "two\n");
  commitAll("two");
  assert.notEqual(tree.treeHashAt("HEAD"), tree.treeHashAt("HEAD~1"));
  assert.equal(tree.treeHashAt("HEAD~1"), first);
  put("src/a.txt", "three\n"); // the working tree moves on; the commit's hash does not
  assert.equal(tree.treeHashAt("HEAD~1"), first);
});

test("P81 TH-4 an uncommitted edit moves treeHash, not treeHashAt", () => {
  fresh();
  put("src/a.txt", "one\n");
  commitAll("code");
  const at = tree.treeHashAt("HEAD");
  put("src/a.txt", "dirty\n");
  assert.notEqual(tree.treeHash(), at);
  assert.equal(tree.treeHashAt("HEAD"), at);
});

test("P81 TH-6 readHistory skips a missing file, bad lines and a non-string hash", () => {
  fresh();
  const path = join(dir, "h.jsonl");
  assert.deepEqual(tree.readHistory(path), []);
  writeFileSync(
    path,
    [
      JSON.stringify({ treeHash: "a", ranAt: "1" }),
      "",
      "not json",
      JSON.stringify({ ranAt: "no hash" }),
      JSON.stringify({ treeHash: 7 }),
      JSON.stringify({ treeHash: "b", ranAt: "2" }),
    ].join("\n"),
  );
  assert.deepEqual(
    tree.readHistory(path).map((e) => e.treeHash),
    ["a", "b"],
  );
});

test("P81 TH-7 treeEntriesAt rejects an empty or dash-led ref", () => {
  fresh();
  assert.throws(() => tree.treeEntriesAt("", "main"), /bad ref/);
  assert.throws(() => tree.treeEntriesAt("-x", "main"), /bad ref/);
  assert.throws(() => tree.treeEntriesAt("HEAD", "--output=x"), /bad ref/);
  assert.equal(existsSync(join(dir, "x")), false, "no option reached git");
});

test("P81 TH-B1 treeEntries(base) lists the changes since that base", () => {
  fresh();
  put("a.txt", "a\n");
  commitAll("a");
  put("b.txt", "b\n");
  const head = git("rev-parse", "HEAD");
  assert.deepEqual(tree.treeEntries(), tree.treeEntries(tree.baseRef()));
  assert.deepEqual(
    tree.treeEntries().map(([p]) => p),
    ["a.txt", "b.txt"],
  );
  assert.deepEqual(
    tree.treeEntries(head).map(([p]) => p),
    ["b.txt"],
  );
});
