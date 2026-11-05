// What a step's digest depends on, proved against a synthetic project: a gitignored env file is
// an input of every step, a deny rule drops a path from that step's digest alone, a tooling path
// is never denied, and a data folder feeds only the steps it names (and no e2e spec digest).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";

const SYN = `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [
    step({ id: 'a', when: true, cmd: 'run a', reuse: { deny: ['docs/'] } }),
    step({ id: 'b', when: true, cmd: 'run b', reuse: { deny: ['tools/'] } }),
    step({ id: 'reg', when: true, cmd: 'run reg', reuse: { deny: [] } }),
  ],
  toolPrefixes: ['tools/'],
  dataPaths: { 'tools/data/': ['reg'] },
});
`;

// digest.mjs reads the config and the git root at import, so it loads after the chdir.
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
git("init", "-q", "-b", "main");
put(".gitignore", ".env*\nnode_modules/\n");
git("add", "-A");
git("commit", "-qm", "base");
git("checkout", "-qb", "feat");

const { DATA_PATHS, isDenied, specDigest, stepDigest } = await import(
  "../digest.mjs"
);

const V = { node: "v22.0.0", deno: "deno 2.0.0" };
const BASE = "b".repeat(40);
const state = (entries) => ({
  base: BASE,
  versions: V,
  packs: [],
  env: [],
  entries,
});
const sd = (id, entries) =>
  stepDigest(id, `run ${id}`, { state: state(entries) });
const IDS = ["a", "b", "reg"];

test("SI-6 a gitignored env file is an input of every step: adding, changing or deleting it moves the digest", () => {
  const live = (id) =>
    stepDigest(id, `run ${id}`, { base: "main", versions: V });
  const none = Object.fromEntries(IDS.map((id) => [id, live(id)]));
  put(".env.local", "A=1\n");
  const one = Object.fromEntries(IDS.map((id) => [id, live(id)]));
  put(".env.local", "A=2\n");
  const two = Object.fromEntries(IDS.map((id) => [id, live(id)]));
  rmSync(join(dir, ".env.local"));
  for (const id of IDS) {
    assert.notEqual(one[id], none[id], `added ${id}`);
    assert.notEqual(two[id], one[id], `changed ${id}`);
    assert.equal(live(id), none[id], `deleted ${id}`);
  }
});

test("SI-7 a path under a step's deny rule leaves that step's digest unchanged and moves the others", () => {
  assert.equal(isDenied("a", "docs/x.md"), true);
  assert.equal(isDenied("b", "docs/x.md"), false);
  const entries = [["docs/x.md", "100644 A"]];
  assert.equal(sd("a", entries), sd("a", []));
  assert.notEqual(sd("b", entries), sd("b", []));
  // control: a path no rule names moves every step
  for (const id of IDS)
    assert.notEqual(sd(id, [["other/y.txt", "100644 A"]]), sd(id, []), id);
});

test("SI-8 a tooling path is never denied, even for a step whose deny rule names its prefix", () => {
  assert.equal(isDenied("b", "tools/x.mjs"), false);
  assert.notEqual(sd("b", [["tools/x.mjs", "100644 A"]]), sd("b", []));
  assert.equal(isDenied("b", "tools/notes.md"), false);
});

test("SI-R1 a path under a data folder is denied for every step but the ones it names", () => {
  const path = "tools/data/a.json";
  assert.deepEqual(DATA_PATHS, { "tools/data/": ["reg"] });
  for (const id of IDS) assert.equal(isDenied(id, path), id !== "reg", id);
  const entries = [[path, "100644 A"]];
  assert.equal(sd("a", entries), sd("a", []));
  assert.equal(sd("b", entries), sd("b", []));
  assert.notEqual(sd("reg", entries), sd("reg", []));
});

test("SI-MR1 an e2e spec digest ignores data folders but not tool code", () => {
  const spec = "e2e/a.spec.ts";
  const inputs = ["app/p.tsx"];
  const none = state([["app/p.tsx", "100644 a"]]);
  const withData = state([...none.entries, ["tools/data/x.json", "100644 b"]]);
  const withTool = state([...none.entries, ["tools/x.mjs", "100644 c"]]);
  const d = (st) => specDigest(spec, inputs, { state: st });
  assert.equal(d(withData), d(none), "data is not an e2e input");
  assert.notEqual(d(withTool), d(none), "tool code is");
});
