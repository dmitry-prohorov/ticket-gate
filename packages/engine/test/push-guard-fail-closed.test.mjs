// The push guard (`ticket-gate hook pre-tool-use`) denies, never allows, when gate.config.mjs is
// unusable: a hook that crashes exits 1, which Claude Code treats as non-blocking. Each case
// spawns the hook in a throwaway project with the given config and reads its verdict.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  BIN,
  CONFIG_URL,
  gateProject,
} from "./mutations/__tests__/gate-project.mjs";

const THROWS = 'throw new Error("boom");\n';
const withGuard = (names) =>
  `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};\nexport default defineGate({ steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })], dod: { files: ['plans/*.md'], contract: 'plans/{id}.md' }, pushGuard: { protected: ${JSON.stringify(names)} } });\n`;

/** Runs the hook for `command`; config null removes gate.config.mjs. Returns { status, stdout, stderr }. */
function hook(config, command) {
  const p = gateProject({ registry: null, config: config ?? THROWS });
  if (config === null) rmSync(join(p.dir, "gate.config.mjs"));
  return spawnSync(process.execPath, [BIN, "hook", "pre-tool-use"], {
    cwd: p.dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
}

const denied = (r, label) => {
  assert.equal(r.status, 0, `${label}: exit ${r.status} ${r.stderr}`);
  assert.match(r.stdout, /"permissionDecision":"deny"/, label);
  assert.match(r.stdout, /gate\.config\.mjs is unusable/, label);
};

test("BG-FC-1a a throwing or missing config denies a push from a feature branch", () => {
  for (const config of [THROWS, null]) {
    denied(hook(config, "git push origin feat"), "push");
    denied(hook(config, "ls && git push"), "chained push");
  }
});

test("BG-FC-1b a broken config denies gh pr, repo and api calls and allows unrelated commands", () => {
  for (const cmd of ["gh pr view 1", "gh repo view", "gh api repos/a/b"])
    denied(hook(THROWS, cmd), cmd);
  for (const cmd of ["git status", "gh issue list", "ls"]) {
    const r = hook(THROWS, cmd);
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
    assert.equal(r.stdout, "", cmd);
  }
});

test("BG-FC-2 a broken config does not fall back to the built-in main and master names", () => {
  // Under a fallback to main|master this push (to a feature branch) would be allowed.
  denied(hook(THROWS, "git push origin feat:topic"), "feature refspec");
});

test("BG-FC-3 protected names from the config are matched literally, not as a pattern", () => {
  const config = withGuard(["trunk", "re.lease"]);
  for (const name of ["trunk", "re.lease"]) {
    const r = hook(config, `git push origin ${name}`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"permissionDecision":"deny"/, name);
  }
  for (const name of ["reXlease", "main"]) {
    const r = hook(config, `git push origin ${name}`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "", name);
  }
});
