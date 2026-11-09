// Ported cases of the move proof, the follow-up register and the two ratchets (module size, skill
// references), each against synthetic input: throwaway git repos, register folders and trees under
// os.tmpdir(). Each test is bitten by an `INFRA-81a/Mn` registry entry named in PORTED-CASES.md.
// move-proof.mjs, receipt.mjs and fu.mjs read the project root at import, so they load after the scratch
// project is entered.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { countLines, createModuleSize, createSkillRefs } from "../ratchet.mjs";
import { CONFIG_URL, enterScratchProject } from "./scratch-project.mjs";

const leave =
  enterScratchProject(`import { defineGate, step } from '${CONFIG_URL}';
export default defineGate({
  steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })],
  reviewMap: { rules: [], sizeExcluded: ['**/*.test.mjs'] },
});
`);
const { importLineNumbers, matchMoves, moveProof, normalise } = await import(
  "../move-proof.mjs"
);
const { buildReceipt } = await import("../receipt.mjs");
const {
  checkFollowUps,
  fileIdOf,
  idOfFileId,
  parseFile,
  parseRow,
  run: fuRun,
  serialiseFile,
  toRow,
} = await import("../fu.mjs");

const dirs = [];
after(() => {
  leave();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const gitIn = (dir, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: dir, stdio: "pipe", encoding: "utf8" },
  );

// --- move proof ---

/** A temp repo with `files` committed as the base. */
function moveRepo(files) {
  const dir = tmp("move-");
  gitIn(dir, "init", "-q", "-b", "main");
  for (const [f, body] of Object.entries(files)) put(dir, f, body);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "base");
  return { dir, base: gitIn(dir, "rev-parse", "HEAD").trim() };
}

const add = (text, line = 1, path = "a.mjs") => ({ path, line, text });

test("P81 MC-5 export and whitespace normalise, export default does not", () => {
  assert.equal(normalise("export const a = 1;"), normalise("  const a = 1;  "));
  assert.equal(normalise("\t const a = 1; "), "const a = 1;");
  assert.notEqual(normalise("export default f;"), normalise("f;"));
  assert.equal(
    normalise("export * from './x.mjs';"),
    "export * from './x.mjs';",
  );
  assert.deepEqual(
    matchMoves([add("export const a = 1;")], ["  const a = 1;"]),
    [],
  );
  assert.equal(matchMoves([add("export default f;")], ["f;"]).length, 1);
});

test("P81 MC-6 a multi-line import gaining a name is exempt", () => {
  const { dir, base } = moveRepo({
    "a.mjs": "import {\n  one,\n} from './x.mjs';\nconst k = 1;\n",
  });
  put(
    dir,
    "a.mjs",
    "import {\n  one,\n  extra,\n} from './x.mjs';\nconst k = 1;\n",
  );
  const proof = moveProof(base, dir);
  assert.deepEqual(proof.lines, []);
  assert.equal(proof.unmatched, 0);
});

test("P81 MC-7 excluded paths count on neither side", () => {
  const { dir, base } = moveRepo({
    "x.test.mjs": "const only = 1;\n",
    "lib.mjs": "const keep = 1;\n",
  });
  put(dir, "x.test.mjs", "const only = 1;\nconst brand = 2;\n");
  put(dir, "fresh.test.mjs", "const untracked = 3;\n");
  assert.equal(
    moveProof(base, dir).unmatched,
    0,
    "a line added to a test file, tracked or not, is not counted",
  );
  put(dir, "x.test.mjs", "");
  put(dir, "lib.mjs", "const keep = 1;\nconst only = 1;\n");
  const proof = moveProof(base, dir);
  assert.deepEqual(
    proof.lines.map((l) => `${l.path}:${l.line}`),
    ["lib.mjs:2"],
    "a line removed from a test file pays for nothing",
  );
});

test("P81 MC-8 blank lines are ignored, comments are not", () => {
  const { dir, base } = moveRepo({ "lib.mjs": "const a = 1;\n" });
  put(dir, "lib.mjs", "const a = 1;\n\n   \n// note\n");
  const proof = moveProof(base, dir);
  assert.deepEqual(
    proof.lines.map((l) => l.text),
    ["// note"],
  );
  assert.equal(proof.unmatched, 1);
});

test("P81 MC-10 an import with a trailing comment closes on its own line", () => {
  const lines = [
    "import { a } from './a.js'; // keep",
    "export function gate(x) {",
    "  if (x) {",
    "    return true;",
  ];
  assert.deepEqual([...importLineNumbers(lines)], [1]);
  assert.deepEqual(
    [...importLineNumbers(["import { a } from './a.js' // no semi", "run();"])],
    [1],
  );
});

test("P81 MC-10b a // inside the specifier is not a comment", () => {
  const url = "import { serve } from 'https://example.test/std/server.ts';";
  assert.deepEqual([...importLineNumbers([url, "const a = 1;"])], [1]);
  assert.deepEqual(
    [...importLineNumbers(["export * from 'npm:x//y'", "run();"])],
    [1],
  );
});

test("P81 MC-11 a non-JS file has no import exemption", () => {
  const { dir, base } = moveRepo({ "scripts/tool.py": "import json\n" });
  put(dir, "scripts/tool.py", "import json\nx = 1\ny = 2\n");
  const proof = moveProof(base, dir);
  assert.equal(proof.unmatched, 2);
  assert.deepEqual(
    proof.lines.map((l) => l.text),
    ["x = 1", "y = 2"],
  );
});

test("P81 MC-R2 buildReceipt without moveProof records null", () => {
  const r = buildReceipt({
    treeHash: "t",
    ranAt: "now",
    ok: true,
    results: [],
    size: { lines: 1, level: "ok" },
    base: "b",
  });
  assert.ok("moveProof" in r);
  assert.equal(r.moveProof, null);
});

// --- follow-up register ---

/** A register folder `<root>/register` holding `files`. */
const register = (files) => {
  const root = tmp("fu-");
  const dir = join(root, "register");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return { root, dir };
};

const exec = (dir, argv) => {
  const out = [];
  const err = [];
  const code = fuRun(argv, {
    dir,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out, err };
};

const snapshot = (root) => {
  const all = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else all[p] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return all;
};

const fx = (id, status, extra = {}) =>
  serialiseFile({
    id,
    status,
    owner: status === "open" ? "someone" : undefined,
    fixedIn: status === "done" ? "T-1 (abc)." : undefined,
    body: `Body of ${id}. More.`,
    ...extra,
  });

const LIST_FILES = () => ({
  "FU203.md": fx("FU203", "open", { severity: "MED" }),
  "FU10a.md": fx("FU10a", "open"),
  "FU26-T-6.md": fx("FU26 (T-6)", "open", { owner: "Z owner" }),
  "FU9.md": fx("FU9", "done"),
  "README.md": "# readme\n",
});

test("P81 L-2 parseFile throws on each malformed form", () => {
  const bad = {
    "no frontmatter": ["id: FU1\nbody\n", /no frontmatter/],
    unclosed: ["---\nid: FU1\nbody\n", /closing --- is missing/],
    unparseable: ["---\nid FU1\n---\nb.\n", /line 2 does not parse/],
    "duplicate key": ["---\nid: FU1\nid: FU2\n---\nb.\n", /repeated key id/],
    "single quotes": [
      "---\nid: FU1\nowner: 'x'\n---\nb.\n",
      /single quotes are not supported/,
    ],
    "bad json": [
      '---\nid: FU1\nowner: "x\n---\nb.\n',
      /bad double-quoted value/,
    ],
    "text after the quote": [
      '---\nid: FU1\nowner: "x" y\n---\nb.\n',
      /bad double-quoted value/,
    ],
  };
  for (const [name, [text, message]] of Object.entries(bad))
    assert.throws(() => parseFile(text), message, name);
  assert.equal(parseFile("---\nid: FU1\n---\nb.\n").data.id, "FU1", "control");
});

test("P81 L-3 row round trip through a file", () => {
  const rows = [
    "- [ ] **FU203** (MED, bug + UX, web; ticket) Wide grids. Defined: x. Owner: unassigned (a web ticket).",
    "- [ ] **FU6** No prefetch. Defined: contracts/T-5.md. Owner: nobody.",
    "- [ ] **FU26 (T-6)** (LOW) Something. Owner: a: b.",
    "- [ ] **FU10a** The test. PARTIAL: T-9 did half (abc1234). Owner: a mobile ticket.",
    "- [x] **FU9** (LOW) Done thing. Owner: T-1. Fixed in: T-2 (b812601).",
    "- [x] **FU11** Only fixed. Fixed in: `T-2` (b812601).",
    "- [ ] **FU12** (nit) Body with `a: b` # c: d. Owner: z.",
  ];
  for (const row of rows) {
    const parsed = parseRow(row);
    assert.equal(toRow(serialiseFile(parsed)), row);
  }
  const p = parseRow(rows[3]);
  assert.equal(p.status, "open");
  assert.match(p.body, /PARTIAL: T-9/);
  assert.equal(p.owner, "a mobile ticket.");
  const d = parseRow(rows[4]);
  assert.deepEqual(
    [d.status, d.severity, d.owner, d.fixedIn],
    ["done", "LOW", "T-1.", "T-2 (b812601)."],
  );
  assert.equal(parseRow(rows[1]).severity, undefined);
  assert.equal(parseRow(rows[2]).id, "FU26 (T-6)");
});

test("P81 L-5 file ids both ways", () => {
  const pairs = [
    ["FU203", "FU203"],
    ["FU10a", "FU10a"],
    ["FU26 (T-6)", "FU26-T-6"],
    ["FU27 (T-5b)", "FU27-T-5b"],
  ];
  for (const [id, fileId] of pairs) {
    assert.equal(fileIdOf(id), fileId);
    assert.equal(idOfFileId(fileId), id);
  }
  assert.equal(fileIdOf("not an id"), "not an id");
});

test("P81 C-1 list default: open only, sorted, tab separated, cut rule", () => {
  const { dir } = register(LIST_FILES());
  const r = exec(dir, ["list"]);
  assert.equal(r.code, 0);
  assert.deepEqual(
    r.out.map((l) => l.split("\t")[0]),
    ["FU10a", "FU26 (T-6)", "FU203"],
  );
  assert.deepEqual(r.out[2].split("\t"), [
    "FU203",
    "MED",
    "someone",
    "Body of FU203",
  ]);
  assert.equal(r.out[0].split("\t")[1], "-");

  const long = register({
    "FU1.md": fx("FU1", "open", {
      owner: "o".repeat(70),
      body: `${"b".repeat(120)}.`,
    }),
  });
  const cols = exec(long.dir, ["list"]).out[0].split("\t");
  assert.equal(cols[2], `${"o".repeat(57)}...`);
  assert.equal(cols[3], `${"b".repeat(97)}...`);
  const exact = register({
    "FU1.md": fx("FU1", "open", { owner: "o".repeat(60) }),
  });
  assert.equal(exec(exact.dir, ["list"]).out[0].split("\t")[2], "o".repeat(60));
});

test("P81 C-2 list --all, --status, --owner", () => {
  const { dir } = register(LIST_FILES());
  const ids = (argv) => exec(dir, argv).out.map((l) => l.split("\t")[0]);
  assert.deepEqual(ids(["list", "--all"]), [
    "FU9",
    "FU10a",
    "FU26 (T-6)",
    "FU203",
  ]);
  assert.deepEqual(ids(["list", "--status", "done"]), ["FU9"]);
  assert.deepEqual(ids(["list", "--status", "open"]), [
    "FU10a",
    "FU26 (T-6)",
    "FU203",
  ]);
  assert.deepEqual(ids(["list", "--owner", "z OWN"]), ["FU26 (T-6)"]);
  assert.deepEqual(ids(["list", "--all", "--owner", "SOMEONE"]), [
    "FU10a",
    "FU203",
  ]);
  assert.equal(exec(dir, ["list", "--status", "weird"]).code, 2);
});

test("P81 C-3 next", () => {
  const { dir } = register(LIST_FILES());
  assert.deepEqual(exec(dir, ["next"]).out, ["FU204"]);
  const empty = register({ "README.md": "x\n" });
  assert.deepEqual(exec(empty.dir, ["next"]).out, ["FU1"]);
  const suffix = register({
    "FU10a.md": fx("FU10a", "open"),
    "FU3.md": fx("FU3", "open"),
  });
  assert.deepEqual(exec(suffix.dir, ["next"]).out, ["FU11"]);
});

test("P81 C-4 close sets status and fixed-in, nothing else", () => {
  for (const key of ["FU26-T-6", "FU26 (T-6)"]) {
    const files = LIST_FILES();
    files["FU26-T-6.md"] = fx("FU26 (T-6)", "open", {
      severity: "LOW",
      owner: "a: b",
      body: "Body `x: y`. Defined: z.",
    });
    const { dir } = register(files);
    const r = exec(dir, ["close", key, "--by", "T-9", "--sha", "abc1234"]);
    assert.equal(r.code, 0, r.err.join());
    const text = readFileSync(join(dir, "FU26-T-6.md"), "utf8");
    const p = parseFile(text);
    assert.equal(p.data.status, "done");
    assert.equal(p.data["fixed-in"], "T-9 (abc1234).");
    assert.equal(p.data.owner, "a: b");
    assert.equal(p.data.severity, "LOW");
    assert.equal(p.data.id, "FU26 (T-6)");
    assert.equal(p.body, "Body `x: y`. Defined: z.");
    assert.equal(
      text,
      serialiseFile({
        id: "FU26 (T-6)",
        status: "done",
        severity: "LOW",
        owner: "a: b",
        fixedIn: "T-9 (abc1234).",
        body: "Body `x: y`. Defined: z.",
      }),
    );
  }
});

test("P81 C-5 b close refuses unknown, missing flags and a bad subcommand, and writes nothing", () => {
  const { root, dir } = register(LIST_FILES());
  const before = snapshot(root);
  const unknown = exec(dir, ["close", "FU999", "--by", "A-1", "--sha", "abc"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err.join(), /no follow-up FU999 in /);
  assert.equal(exec(dir, ["close", "FU203", "--by", "A-1"]).code, 2);
  assert.equal(exec(dir, ["close", "FU203", "--sha", "abc"]).code, 2);
  assert.equal(
    exec(dir, ["close", "FU203", "--by", "", "--sha", "abc"]).code,
    2,
  );
  assert.equal(exec(dir, ["close", "--by", "A", "--sha", "b"]).code, 2);
  assert.equal(exec(dir, ["bogus"]).code, 2);
  assert.deepEqual(snapshot(root), before);
});

test("P81 C-6 only close writes, and only the closed file", () => {
  const { root, dir } = register(LIST_FILES());
  writeFileSync(join(root, "sibling.txt"), "keep");
  const before = snapshot(root);
  for (const argv of [["list"], ["list", "--all"], ["show", "FU203"], ["next"]])
    assert.equal(exec(dir, argv).code, 0);
  assert.deepEqual(snapshot(root), before);
  assert.equal(
    exec(dir, ["close", "FU203", "--by", "A-1", "--sha", "abc"]).code,
    0,
  );
  const after = snapshot(root);
  const changed = Object.keys(after).filter((p) => after[p] !== before[p]);
  assert.deepEqual(changed, [join(dir, "FU203.md")]);
  assert.deepEqual(Object.keys(after), Object.keys(before));
});

test("P81 C-7 show prints the file verbatim by id or file id", () => {
  const { dir } = register(LIST_FILES());
  const text = readFileSync(join(dir, "FU26-T-6.md"), "utf8");
  assert.deepEqual(exec(dir, ["show", "FU26 (T-6)"]).out, [text.slice(0, -1)]);
  assert.deepEqual(exec(dir, ["show", "FU26-T-6"]).out, [text.slice(0, -1)]);
  assert.equal(exec(dir, ["show", "FU1"]).code, 1);
});

// --- follow-up register check ---

const README = [
  "# Follow-up register",
  "Ids FU1-FU3 were used twice in phase 1; FU7 was also minted twice.",
  "",
  "## Collisions / ambiguities",
  "",
  "Ids FU50 were used twice here, which is never parsed.",
].join("\n");

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

test("P81 K-1 b an id that does not parse fails", () => {
  const bad = check([file("FU12 [x]", { name: "FU12.md" })]);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /does not look like FU/);
  const none = check([
    raw("FU12.md", "---\nstatus: open\nowner: x\n---\ns.\n"),
  ]);
  assert.equal(none.length, 1);
  assert.match(none[0], /id is missing/);
});

test("P81 K-2 a bare id next to a suffixed one fails; two suffixes pass; README missing fails", () => {
  const bare = check([file("FU12"), file("FU12 (X)")]);
  assert.equal(bare.length, 1);
  assert.match(bare[0], /FU12 \(X\) duplicates FU12/);
  assert.equal(check([file("FU12 (X)"), file("FU12")]).length, 1);
  assert.deepEqual(check([file("FU26 (A)"), file("FU26 (B)")]), []);
  const e = check([file("FU12")], { readme: null });
  assert.deepEqual(e, ["register/README.md is missing"]);
});

test("P81 K-5 b a file with no frontmatter fails", () => {
  const n = check([raw("FU12.md", "just text\n")]);
  assert.equal(n.length, 1);
  assert.match(n[0], /FU12\.md: no frontmatter/);
  const late = check([
    raw(
      "FU12.md",
      "intro\n---\nid: FU12\nstatus: open\nowner: x\n---\nsummary.\n",
    ),
  ]);
  assert.equal(late.length, 1, late.join("\n"));
  assert.match(late[0], /FU12\.md: no frontmatter/);
});

// --- module-size ratchet ---

const size = createModuleSize({
  limits: { module: 10, test: 20 },
  testRe: /\.spec\.mjs$/,
  roots: ["src", "lib"],
  baselineRel: "baseline.json",
  comment: "sizes",
  name: "chk:size",
  cmd: "tool size",
  fixNew: "Fix: split the new module.",
  fixGrew: "Fix: shrink the file.",
  usage: "Usage: tool size [--update]",
});

const lines = (n) => "x\n".repeat(n);

/** files: { rel: lineCount }; `untracked` leaves a file out of the index. */
function sizeRepo(files, { untracked = [], baseline } = {}) {
  const dir = tmp("size-");
  gitIn(dir, "init", "-q");
  for (const [rel, n] of Object.entries(files)) {
    put(dir, rel, lines(n));
    if (!untracked.includes(rel)) gitIn(dir, "add", rel);
  }
  const baselinePath = join(dir, "baseline.json");
  if (baseline)
    writeFileSync(baselinePath, JSON.stringify({ files: baseline }));
  return { dir, baselinePath };
}

const sizeRun = (r, opts = {}) =>
  size.checkModuleSize(r.dir, { baselinePath: r.baselinePath, ...opts });

test("P81 MS-4 b test files get the test limit, others the module limit", () => {
  assert.equal(size.limitOf("src/a.spec.mjs"), 20);
  assert.equal(size.limitOf("src/a.mjs"), 10);
  const ok = sizeRun(sizeRepo({ "src/a.spec.mjs": 15 }, { baseline: {} }));
  assert.equal(ok.code, 0, ok.lines.join("\n"));
  const edge = sizeRun(sizeRepo({ "src/a.spec.mjs": 20 }, { baseline: {} }));
  assert.equal(edge.code, 0, edge.lines.join("\n"));
  const big = sizeRun(sizeRepo({ "src/a.spec.mjs": 21 }, { baseline: {} }));
  assert.equal(big.code, 1);
  assert.ok(
    big.lines.some((l) =>
      l.startsWith("NEW src/a.spec.mjs 21 lines (limit 20)"),
    ),
    big.lines.join("\n"),
  );
  const mod = sizeRun(sizeRepo({ "src/a.mjs": 11 }, { baseline: {} }));
  assert.equal(mod.code, 1);
  assert.ok(
    mod.lines.some((l) => l.startsWith("NEW src/a.mjs 11 lines (limit 10)")),
    mod.lines.join("\n"),
  );
});

test("P81 MS-5 countLines counts physical lines", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\n\n"), 2);
});

test("P81 MS-6 b files outside the roots are not measured", () => {
  const r = sizeRun(
    sizeRepo(
      {
        "docs/big.mjs": 50,
        "big.mjs": 50,
        "src/ok.mjs": 3,
      },
      { baseline: {} },
    ),
  );
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.match(
    r.lines.at(-1),
    /^chk:size: 1 files measured, 0 baselined, none grew$/,
  );
});

test("P81 MS-8 b --update --seed still refuses a new entry over the limit on an existing baseline", () => {
  const s = sizeRepo({ "src/n.mjs": 12 });
  const seeded = sizeRun(s, { update: true, seed: true });
  assert.equal(seeded.code, 0, seeded.lines.join("\n"));
  assert.deepEqual(
    JSON.parse(readFileSync(s.baselinePath, "utf8")).files["src/n.mjs"],
    { lines: 12 },
  );
  const e = sizeRepo({ "src/n.mjs": 15 }, { baseline: {} });
  const before = readFileSync(e.baselinePath, "utf8");
  const reseed = sizeRun(e, { update: true, seed: true });
  assert.equal(reseed.code, 1, reseed.lines.join("\n"));
  assert.ok(
    reseed.lines.some((l) => l.startsWith("NO REASON src/n.mjs 15 lines")),
    reseed.lines.join("\n"),
  );
  assert.equal(readFileSync(e.baselinePath, "utf8"), before);
});

test("P81 MS-9 CLI: exit 2 on unknown arg, --allow without --update, missing baseline", () => {
  const r = sizeRepo({ "src/a.mjs": 1 }, { baseline: {} });
  const at = [`--root=${r.dir}`, `--baseline=${r.baselinePath}`];
  assert.equal(size.runModuleSize(r.dir, [...at, "--bogus"]).code, 2);
  assert.equal(
    size.runModuleSize(r.dir, [...at, "--allow=src/a.mjs=why"]).code,
    2,
  );
  assert.equal(size.runModuleSize(r.dir, [...at, "--allow=bad"]).code, 2);
  assert.equal(size.runModuleSize(r.dir, [...at, "--seed"]).code, 2);
  const none = sizeRepo({ "src/a.mjs": 1 });
  const missing = size.runModuleSize(none.dir, []);
  assert.equal(missing.code, 2);
  assert.match(missing.lines.join("\n"), /tool size --update --seed/);
  assert.equal(size.runModuleSize(r.dir, at).code, 0);
});

test("P81 MS-9b an unreadable baseline or one without files gives exit 2 and the fix", () => {
  const want =
    /resolve the conflict, or delete the file and run tool size --update --seed/;
  const r = sizeRepo({ "src/a.mjs": 1 });
  writeFileSync(r.baselinePath, "{not json");
  for (const opts of [{}, { update: true, seed: true }]) {
    const bad = sizeRun(r, opts);
    assert.equal(bad.code, 2);
    assert.match(bad.lines.join("\n"), want);
  }
  assert.equal(readFileSync(r.baselinePath, "utf8"), "{not json");
  writeFileSync(r.baselinePath, '{"comment":"x"}');
  const nofiles = sizeRun(r, {});
  assert.equal(nofiles.code, 2);
  assert.match(nofiles.lines.join("\n"), want);
});

// --- skill-reference ratchet ---

const refs = createSkillRefs({
  prefixes: ["ext"],
  skillRoots: ["skills/shared", "skills/local"],
  sourceFiles: (root) =>
    ["GUIDE.md", "agents/a.md"].filter((f) => {
      try {
        return statSync(join(root, f)).isFile();
      } catch {
        return false;
      }
    }),
  name: "chk:refs",
  prefixedNote: " (prefixed names cannot be resolved here)",
  fix: "Fix: install the skill or drop the reference.",
  usage: "Usage: tool refs [--root=DIR]",
});

/** A tree with `present` under skills/shared and `local-one` under skills/local. */
function refTree(files = {}) {
  const dir = tmp("refs-");
  put(dir, "skills/shared/present/SKILL.md", "# present\n");
  put(dir, "skills/local/local-one/SKILL.md", "# local\n");
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  return dir;
}

test("P81 SR-2 b flat block, CRLF and comma-separated skills: forms", () => {
  const dangling = (r, line) =>
    r.lines.some((l) => l.startsWith(`DANGLING agents/a.md:${line} missing`));
  const flat = refs.checkSkillRefs(
    refTree({ "agents/a.md": "---\nskills:\n- missing\n---\n" }),
  );
  assert.equal(flat.code, 1);
  assert.ok(dangling(flat, 3), flat.lines.join("\n"));
  const crlf = refs.checkSkillRefs(
    refTree({ "agents/a.md": "---\r\nskills: missing\r\n---\r\n" }),
  );
  assert.equal(crlf.code, 1);
  assert.ok(dangling(crlf, 2), crlf.lines.join("\n"));
  const csv = refs.checkSkillRefs(
    refTree({ "agents/a.md": "---\nskills: present, missing\n---\n" }),
  );
  assert.equal(csv.code, 1);
  assert.ok(dangling(csv, 2), csv.lines.join("\n"));
  assert.ok(
    !csv.lines.some((l) => l.includes(" present")),
    "an installed name in the same list is not reported",
  );
  const fine = refs.checkSkillRefs(
    refTree({ "agents/a.md": "---\r\nskills:\r\n- present\r\n---\r\n" }),
  );
  assert.equal(fine.code, 0, fine.lines.join("\n"));
});

test("P81 SR-4 a path form resolves under its own root only", () => {
  const present = refs.checkSkillRefs(
    refTree({ "GUIDE.md": "see skills/local/local-one\n" }),
  );
  assert.equal(present.code, 0, present.lines.join("\n"));
  const wrongRoot = refs.checkSkillRefs(
    refTree({ "GUIDE.md": "see skills/shared/local-one\n" }),
  );
  assert.equal(wrongRoot.code, 1);
  assert.ok(
    wrongRoot.lines.some((l) =>
      l.startsWith("DANGLING GUIDE.md:1 skills/shared/local-one"),
    ),
    wrongRoot.lines.join("\n"),
  );
});

test("P81 SR-5 only the scanned files count; placeholders are ignored", () => {
  const dir = refTree({
    "docs/x.md": "see skills/shared/missing\n",
    "GUIDE.md": "a skills/shared/<name> b skills/shared/ c skills/local/.\n",
  });
  const r = refs.checkSkillRefs(dir);
  assert.equal(r.code, 0, r.lines.join("\n"));
  assert.deepEqual(
    refs.skillRefs("x skills/shared/<name> y skills/shared/\n"),
    [],
  );
  put(dir, "GUIDE.md", "see skills/shared/missing\n");
  assert.equal(
    refs.checkSkillRefs(dir).code,
    1,
    "control: a scanned file counts",
  );
});

test("P81 SR-7 CLI: exit 1 on a dangling ref, 2 on an unknown arg", () => {
  const bad = refTree({ "GUIDE.md": "skills/shared/missing\n" });
  assert.equal(refs.runSkillRefs(bad, [`--root=${bad}`]).code, 1);
  const ok = refTree();
  assert.equal(refs.runSkillRefs(ok, [`--root=${ok}`]).code, 0);
  assert.equal(refs.runSkillRefs(ok, [`--root=${bad}`]).code, 1);
  const unknown = refs.runSkillRefs(ok, ["--bogus"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.lines.join("\n"), /unknown argument --bogus/);
});
