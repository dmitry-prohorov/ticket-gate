// The Stop hook never fails open when gate.config.mjs is unusable. Each case spawns
// `ticket-gate hook stop` in a throwaway git project with a newly ticked Definition-of-Done box
// and a deliberately broken (or absent) config; the verdict is the exit status.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { BIN } from "./mutations/__tests__/gate-project.mjs";
import { CONFIG, OPEN, PHASE, stopHookProject } from "./stop-hook-project.mjs";

const THROWS = 'throw new Error("boom");\n';

/** A project with the tick on the working tree; `config` replaces gate.config.mjs (null removes it). */
function project(config) {
  const p = stopHookProject();
  if (config === null) rmSync(join(p.dir, "gate.config.mjs"));
  else if (config !== undefined) p.put("gate.config.mjs", config);
  return p;
}

const stop = (p) =>
  spawnSync(process.execPath, [BIN, "hook", "stop"], {
    cwd: p.dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    input: "{}",
    encoding: "utf8",
  });

test("TG-FC-1a a throwing config and a newly ticked box exits 2 naming the config", () => {
  const r = stop(project(THROWS));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /gate\.config\.mjs/);
  assert.match(r.stderr, /boom/);
  assert.equal(r.stdout, "");
});

test("TG-FC-1b a missing config and a newly ticked box exits 2, not a silent pass", () => {
  const r = stop(project(null));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /gate\.config\.mjs/);
});

test("TG-FC-3 a dod.files glob matching nothing fails closed", () => {
  const config = CONFIG.replace("plans/phase-*.md", "nothing/*.md");
  assert.notEqual(config, CONFIG, "the fixture replace must hit");
  const p = project(config);
  const r = stop(p);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /gate\.config\.mjs/);
  assert.match(r.stderr, /dod\.files matches no file/);
});

test("TG-FC-2 a broken config with no new tick approves", () => {
  for (const config of [THROWS, null]) {
    const p = project(config);
    p.put(PHASE, OPEN);
    const r = stop(p);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  }
});
