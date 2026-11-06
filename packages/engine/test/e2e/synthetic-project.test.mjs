// `ticket-gate select` in throwaway projects that have no supabase-next pack: the selection comes
// from the project's own gate.config.mjs (and, in SP-2 and SP-5, a small inline pack).
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  CONFIG_URL,
  bin,
  gateProject,
} from "../mutations/__tests__/gate-project.mjs";

const ENGINE = join(import.meta.dirname, "../..");
const JS_URL = pathToFileURL(join(ENGINE, "graph", "js.mjs")).href;

const HEADER = "/^\\/\\/ e2e-areas: ([a-z]+(, [a-z]+)*)$/";
const A_TS = "import { b } from '@/lib/b';\nexport const a = b;\n";
const B_TS = "export const b = 1;\n";

const configOf = ({
  areas = ["home", "other"],
  extra = "",
  packs = "[]",
  runner = "",
} = {}) => `
import { defineGate } from ${JSON.stringify(CONFIG_URL)};
import { alias, fileRoots, jsGraph } from ${JSON.stringify(JS_URL)};
export default defineGate({
  steps: [],
  packs: ${packs},
  selection: {
    areas: ${JSON.stringify(areas)},
    specs: { dir: 'web/e2e', match: /\\.spec\\.ts$/, header: ${HEADER}, smokeMax: 5 },
    outside: { prefixes: ['web/'] },
    graphs: [jsGraph({ roots: [fileRoots(['web/app/a.ts'], 'home')], resolvers: [alias('@/', 'web')] })],
    ${runner}
    ${extra}
  },
});
`;

// The graph resolves `typescript` from the project: give the throwaway one this repo's.
const withTypescript = (made) => {
  symlinkSync(
    join(ENGINE, "../../node_modules"),
    join(made.dir, "node_modules"),
  );
  return made;
};

const project = (opts = {}, files = {}) =>
  withTypescript(
    gateProject({
      config: configOf(opts),
      registry: null,
      files: {
        "web/app/a.ts": A_TS,
        "web/lib/b.ts": B_TS,
        "web/lib/c.ts": "export const c = 1;\n",
        "web/e2e/home.spec.ts": "// e2e-areas: home\n'@smoke';\n",
        "web/e2e/other.spec.ts": "// e2e-areas: other\n",
        ".gitignore": ".turbo/\nnode_modules\n",
        ...files,
      },
    }),
  );

test("SP-1 ticket-gate select in a project with no supabase-next pack selects the specs a changed JS file reaches", () => {
  const { dir, put } = project();
  put("web/lib/b.ts", "export const b = 2;\n");
  const r = bin(dir, ["select"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /affected: affected: 1 areas, 1 specs/);
  assert.match(r.out, /^ {2}home\.spec\.ts$/m);
  assert.doesNotMatch(r.out, /other\.spec\.ts/);
});

const LIST = {
  suites: [
    {
      title: "home.spec.ts",
      file: "home.spec.ts",
      specs: [{ title: "shows home", file: "home.spec.ts", tests: [{}] }],
    },
    {
      title: "other.spec.ts",
      file: "other.spec.ts",
      specs: [
        { title: "other thing", file: "other.spec.ts", tests: [{}] },
        { title: "boots @smoke", file: "other.spec.ts", tests: [{}] },
      ],
    },
  ],
};

test("SP-2 select --test-list prints the affected and smoke lines from a named test runner", () => {
  const packs = `[{ name: 'runners', version: '1', testRunners: { name: 'canned', command: 'canned-run', list: () => (${JSON.stringify(LIST)}) } }]`;
  const { dir, put } = project({ packs, runner: "runner: 'canned'," });
  put("web/lib/b.ts", "export const b = 2;\n");
  const r = bin(dir, ["select", "--test-list"]);
  assert.equal(r.status, 0, r.out);
  assert.match(
    r.out,
    /affected: 1 areas, 1 specs; 2 tests -> \.turbo\/e2e-selection\.txt/,
  );
  assert.equal(
    readFileSync(join(dir, ".turbo/e2e-selection.txt"), "utf8"),
    "home.spec.ts › shows home\nother.spec.ts › boots @smoke\n",
  );
});

test("SP-3 select check exits 1 naming a spec without a header; ok prints the counts line", () => {
  const { dir, put } = project({}, { "web/e2e/bare.spec.ts": "no header\n" });
  const bad = bin(dir, ["select", "check"]);
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /missing-header bare\.spec\.ts/);
  assert.match(bad.out, /select check: fix each line above\./);
  put("web/e2e/bare.spec.ts", "// e2e-areas: home\n");
  const ok = bin(dir, ["select", "check"]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /select check: 3 specs, 0 entries ok/);
});

test("SP-4 a gate without selection exits 2 with the not-configured line on stderr", () => {
  const { dir } = gateProject({
    config: `import { defineGate } from ${JSON.stringify(CONFIG_URL)};\nexport default defineGate({ steps: [] });\n`,
    registry: null,
  });
  for (const args of [["select"], ["select", "check"]]) {
    const r = bin(dir, args);
    assert.equal(r.status, 2, r.out);
    assert.match(
      r.out,
      /select: FAIL selection is not configured: add a selection key to gate\.config\.mjs/,
    );
  }
});

test("SP-5 a pack selectionGraphs source adds an area the config's graph does not reach", () => {
  const source = `{ name: 'extra', graph: () => ({ unresolved: null, reach: (p) => ({ areas: new Set(p === 'web/lib/c.ts' ? ['extra'] : []), specs: new Set() }) }) }`;
  const packs = `[{ name: 'more', version: '1', selectionGraphs: ${source} }]`;
  const files = { "web/e2e/extra.spec.ts": "// e2e-areas: extra\n" };
  const withPack = project({ areas: ["home", "other", "extra"], packs }, files);
  withPack.put("web/lib/c.ts", "export const c = 2;\n");
  const r = bin(withPack.dir, ["select"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /affected: affected: 1 areas, 1 specs/);
  assert.match(r.out, /^ {2}extra\.spec\.ts$/m);
  const without = project({ areas: ["home", "other", "extra"] }, files);
  without.put("web/lib/c.ts", "export const c = 2;\n");
  const base = bin(without.dir, ["select"]);
  assert.match(base.out, /full: web\/lib\/c\.ts: unknown/);
});

test("SP-6 select --replay on a two-commit history prints one line per commit", () => {
  const { dir, put, git } = project({ extra: "replayPaths: ['web/']," });
  git("checkout", "-q", "main");
  for (const n of [1, 2]) {
    git("checkout", "-qb", `topic${n}`, "main");
    put("web/lib/b.ts", `export const b = ${n + 1};\n`);
    git("commit", "-qam", `change ${n}`);
    git("checkout", "-q", "main");
    git(
      "merge",
      "--no-ff",
      "-q",
      "-m",
      `Merge pull request #${n} from team/topic${n}`,
      `topic${n}`,
    );
  }
  const r = bin(dir, ["select", "--replay=main", "--count=2"]);
  assert.equal(r.status, 0, r.out);
  const lines = r.out.split("\n").filter((l) => / -> /.test(l));
  assert.equal(lines.length, 2, r.out);
  for (const l of lines)
    assert.match(l, /-> affected: affected: 1 areas, 1 specs/);
  assert.match(lines[0], /#1 /);
  assert.match(lines[1], /#2 /);
  assert.match(r.out, /full: 0 of 2/);
  assert.ok(!existsSync(join(dir, ".turbo/e2e-selection.txt")));
});
