// defineGate: the load-time validation of a gate config. Each case builds a small valid
// config, breaks one thing and asserts the named error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defineGate } from "../config.mjs";

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
const base = (over = {}) => ({
  steps: [mkStep("check"), mkStep("db", { stack: "pg" })],
  stacks: {
    pg: { health: { step: "db", preflight: () => "a", ready: () => "b" } },
  },
  stopOnRedBefore: "db",
  dataPaths: { "data/": ["db"] },
  ...over,
});
const throws = (cfg, re) => assert.throws(() => defineGate(cfg), re);

test("GC-1 an unknown top-level key throws", () => {
  throws(
    { ...base(), stopOnRedBfore: "db" },
    /gate\.config: stopOnRedBfore: unknown key/,
  );
});

test("GC-2 a duplicate step id throws", () => {
  throws(
    base({
      steps: [mkStep("check"), mkStep("check")],
      stacks: {},
      stopOnRedBefore: "check",
      dataPaths: {},
    }),
    /duplicate step id "check"/,
  );
});

test("GC-3 a non-human step without a positive integer limitS throws", () => {
  for (const limitS of [undefined, 0, 1.5, -1]) {
    throws(
      base({
        steps: [mkStep("check", { limitS }), mkStep("db", { stack: "pg" })],
      }),
      /limitS must be a positive integer/,
    );
  }
});

test("GC-4 a non-human step without reuse throws", () => {
  throws(
    base({
      steps: [
        mkStep("check", { reuse: undefined }),
        mkStep("db", { stack: "pg" }),
      ],
    }),
    /reuse must be false/,
  );
  assert.doesNotThrow(() =>
    defineGate(
      base({
        steps: [
          mkStep("check", { reuse: false }),
          mkStep("db", { stack: "pg" }),
        ],
      }),
    ),
  );
});

test("GC-5 an unknown step id in stopOnRedBefore, stacks or dataPaths throws", () => {
  throws(
    base({ stopOnRedBefore: "sed" }),
    /stopOnRedBefore: unknown step id "sed"/,
  );
  throws(
    base({ dataPaths: { "x/": ["sed"] } }),
    /dataPaths\["x\/"\]: unknown step id "sed"/,
  );
  const health = { preflight: () => "a", ready: () => "b" };
  throws(
    base({ stacks: { pg: { health: { step: "sed", ...health } } } }),
    /stacks\.pg\.health\.step: unknown step id "sed"/,
  );
  const ok = { health: { step: "db", ...health } };
  const reset = (over) =>
    base({
      stacks: {
        pg: {
          ...ok,
          reset: { step: "db", satisfiedBy: [], before: [], ...over },
        },
      },
    });
  throws(reset({ step: "sed" }), /reset\.step: unknown step id/);
  throws(
    reset({ satisfiedBy: ["sed"] }),
    /reset\.satisfiedBy: unknown step id/,
  );
  throws(reset({ before: ["sed"] }), /reset\.before: unknown step id/);
  throws(
    reset({ note: { steps: ["sed"], text: () => "" } }),
    /reset\.note\.steps: unknown step id/,
  );
});

test("GC-6 a human step with reuse or limitS throws", () => {
  const human = (extra) =>
    base({
      steps: [
        mkStep("check"),
        mkStep("db", { stack: "pg" }),
        {
          ...mkStep("manual"),
          human: true,
          limitS: undefined,
          reuse: undefined,
          ...extra,
        },
      ],
    });
  throws(human({ limitS: 10 }), /a human step has no reuse or limitS/);
  throws(human({ reuse: false }), /a human step has no reuse or limitS/);
  assert.doesNotThrow(() => defineGate(human({})));
});

test("GC-7 a step naming an undefined stack throws", () => {
  throws(
    base({
      steps: [
        mkStep("check", { stack: "nope" }),
        mkStep("db", { stack: "pg" }),
      ],
    }),
    /unknown stack "nope"/,
  );
  throws(
    base({ steps: [mkStep("check", { stack: "toString" })] }),
    /unknown stack "toString"/,
  );
});

test("GC-8 an empty pushGuard.protected is rejected", () => {
  const ok = defineGate(base({ pushGuard: { protected: ["main"] } }));
  assert.deepEqual(ok.pushGuard.protected, ["main"]);
  const bad = (pushGuard) => throws(base({ pushGuard }), /pushGuard/);
  bad({});
  bad({ protected: [] });
  bad({ protected: [3] });
  bad({ protected: ["ma in"] });
});

test("GC-9 an empty dod.files is rejected", () => {
  const dod = (over = {}) => ({
    files: ["docs/phase-*.md"],
    contract: "docs/contracts/{id}.md",
    ...over,
  });
  assert.doesNotThrow(() => defineGate(base({ dod: dod() })));
  throws(base({ dod: dod({ files: [] }) }), /dod\.files/);
  throws(base({ dod: dod({ files: [3] }) }), /dod\.files/);
});
