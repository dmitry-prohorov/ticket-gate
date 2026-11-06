// The selection key of a gate config: defaults, freezing, and how graph sources, rules and test
// runners merge from the config and from packs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { defineGate } from "../config.mjs";
import { ROOT } from "../root.mjs";
import { defineSelection } from "../selection/define.mjs";
import { select } from "../selection/select.mjs";

const mkStep = (id, extra = {}) => ({
  id,
  when: true,
  cmd: `run ${id}`,
  why: "why",
  notRun: "not run",
  summary: () => "ok",
  limitS: 10,
  reuse: { deny: [] },
  ...extra,
});
const graph = (name) => ({ name, graph: () => ({ reach: () => null }) });
const rule = (name, full) => ({ name, rule: () => ({ full }) });
const runner = (name) => ({ name, command: name, list: () => ({}) });
const pack = (name, hooks = {}) => ({ name, version: "1", ...hooks });
const selection = (extra = {}) => ({
  specs: { dir: "e2e", match: /\.spec\.ts$/, header: /^\/\/ areas: (.+)$/ },
  graphs: [graph("own")],
  ...extra,
});
const gate = (sel, packs = [], steps = [mkStep("check")]) =>
  defineGate({
    steps,
    packs,
    ...(sel === undefined ? {} : { selection: sel }),
  });

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("SL-1 defineGate fills and freezes selection; root defaults to the project root; defineSelection is idempotent", () => {
  const g = gate(selection());
  assert.equal(g.selection.root, ROOT);
  assert.equal(g.selection.label, "e2e-select");
  assert.equal(g.selection.drift, null);
  assert.deepEqual(g.selection.rules, []);
  assert.equal(g.selection.runner, null);
  assert.ok(Object.isFrozen(g.selection));
  assert.ok(Object.isFrozen(g.selection.specs));
  assert.deepEqual(defineSelection(g.selection), g.selection);
  assert.equal(
    gate(selection({ root: "/elsewhere" })).selection.root,
    "/elsewhere",
  );
});

test("SL-2 a graph source name given by two packs throws naming both packs", () => {
  assert.throws(
    () =>
      gate(selection({ graphs: [] }), [
        pack("p1", { selectionGraphs: graph("js") }),
        pack("p2", { selectionGraphs: [graph("js")] }),
      ]),
    /gate\.config: selection: graph source "js" is given by p1 and p2/,
  );
});

test("SL-3 a rule name given by gate.config and a pack throws naming gate.config and the pack", () => {
  assert.throws(
    () =>
      gate(selection({ rules: [rule("r", "a")] }), [
        pack("p1", { selectionRules: rule("r", "b") }),
      ]),
    /selection: rule "r" is given by gate\.config and p1/,
  );
});

test("SL-4 pack rules run after the config's rules, in packs order", () => {
  const root = mkdtempSync(join(tmpdir(), "sel-config-"));
  dirs.push(root);
  const g = gate(
    selection({
      rules: [rule("own", "own-rule")],
      outside: { prefixes: [""] },
    }),
    [
      pack("p1", { selectionRules: rule("one", "pack-one") }),
      pack("p2", { selectionRules: rule("two", "pack-two") }),
    ],
  );
  assert.deepEqual(
    g.selection.rules.map((r) => r.name),
    ["own", "one", "two"],
  );
  const sel = select({ root, changed: ["x.ts"], config: g.selection });
  assert.equal(sel.why, "x.ts: own-rule");
  const packsOnly = gate(selection({ outside: { prefixes: [""] } }), [
    pack("p1", { selectionRules: rule("one", "pack-one") }),
    pack("p2", { selectionRules: rule("two", "pack-two") }),
  ]);
  assert.equal(
    select({ root, changed: ["x.ts"], config: packsOnly.selection }).why,
    "x.ts: pack-one",
  );
});

test("SL-5 a runner given by name resolves from testRunners; an unknown name throws", () => {
  const g = gate(selection({ runner: "pw" }), [
    pack("p1", { testRunners: [runner("other"), runner("pw")] }),
  ]);
  assert.equal(g.selection.runner.name, "pw");
  assert.throws(
    () =>
      gate(selection({ runner: "nope" }), [
        pack("p1", { testRunners: runner("pw") }),
      ]),
    /selection: no test runner named "nope"/,
  );
  const own = runner("own");
  assert.equal(gate(selection({ runner: own }), []).selection.runner, own);
});

test("SL-6 a selection without specs.dir throws gate.config: selection: selection.specs.dir is required", () => {
  assert.throws(
    () => gate(selection({ specs: { match: /x/, header: /x/ } })),
    /^Error: gate\.config: selection: selection\.specs\.dir is required$/,
  );
  assert.throws(() => gate(5), /gate\.config: selection: must be an object/);
});

test("SL-7 a gate without selection has no selection field", () => {
  assert.equal("selection" in gate(undefined), false);
});

test("SL-8 two steps with nightly units throw naming both ids", () => {
  const units = (nightly) => ({
    select() {},
    cmd() {},
    ...(nightly ? { nightly: { suite: "s" } } : {}),
  });
  assert.throws(
    () =>
      gate(
        undefined,
        [],
        [
          mkStep("a", { units: units(true) }),
          mkStep("plain", { units: units(false) }),
          mkStep("b", { units: units(true) }),
        ],
      ),
    /gate\.config: steps: only one step may carry nightly units: a, b/,
  );
  gate(
    undefined,
    [],
    [mkStep("a", { units: units(true) }), mkStep("b", { units: units(false) })],
  );
});
