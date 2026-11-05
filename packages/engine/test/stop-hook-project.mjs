// Test helper (not a test): a throwaway git project with a Definition-of-Done file whose box is
// ticked on the working tree, for tests that spawn the Stop hook (`ticket-gate hook stop`).
// It writes the receipt, the history file, the ticket files and the follow-up folder the hook reads.
// Nothing here names a real consumer; every path is synthetic.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BIN,
  CONFIG_URL,
  gateProject,
} from "./mutations/__tests__/gate-project.mjs";

const ENGINE = join(import.meta.dirname, "..");
const url = (rel) => JSON.stringify(pathToFileURL(join(ENGINE, rel)).href);

export const PHASE = "plans/phase-9.md";
export const HISTORY = ".turbo/ticket-verify-history.jsonl";
export const OPEN = "## X-01 thing\n\n- [ ] do it\n";
export const TICKED = "## X-01 thing\n\n- [x] do it\n";

export const CONFIG = `import { defineGate, step } from ${JSON.stringify(CONFIG_URL)};
export default defineGate({
  steps: [
    step({ id: 'check', when: true, cmd: 'run check', reuse: false }),
    step({ id: 'coverage', when: true, cmd: 'run coverage', reuse: { deny: [] } }),
  ],
  dod: { files: ['plans/phase-*.md'], contract: 'plans/contracts/{id}.md' },
  followUps: { dir: 'plans/follow-ups' },
  reviewMap: { splitHint: 'split the ticket' },
});
`;

/** Runs `code` (ESM, top-level await) with the project as working directory; returns stdout. */
export function inProject(dir, code) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/**
 * A project on branch `feat` (base `main`) whose DoD file has its box ticked in the working tree
 * (committed unticked on main). Returns the project handle plus:
 *   receipt(over)    write .turbo/ticket-verify.json for the tree as it is now
 *   gate()           run the Stop hook; null when it approves, else the parsed block
 *   history(...l)    write the history file (a treeHash string becomes an entry)
 *   commitWork(doc)  commit the tick together with src/a.txt; returns that tree's hash
 *   hashNow()        the tree hash as the engine computes it now
 *   digestOf(id, cmd, base)  the engine's step digest for a reused result
 */
export function stopHookProject({ config = CONFIG, files = {} } = {}) {
  const p = gateProject({
    config,
    registry: null,
    files: {
      [PHASE]: OPEN,
      ".ticket-gate/tree.json": '{"exclude":["plans"]}\n',
      ".gitignore": ".turbo/\n.env*\n",
      ...files,
    },
  });
  const { dir, put, git } = p;
  put(PHASE, TICKED);
  const hashNow = () =>
    inProject(
      dir,
      `import { treeHash } from ${url("tree.mjs")}; console.log(treeHash());`,
    );
  const digestOf = (id, cmd, base) =>
    inProject(
      dir,
      `import { stepDigest } from ${url("digest.mjs")}; console.log(stepDigest(${JSON.stringify(id)}, ${JSON.stringify(cmd)}, { base: ${JSON.stringify(base)} }));`,
    );
  const receipt = (over = {}) =>
    put(
      ".turbo/ticket-verify.json",
      JSON.stringify({
        treeHash: hashNow(),
        ranAt: "now",
        ok: true,
        results: [{ id: "check", cmd: "run check", status: "pass" }],
        ...over,
      }),
    );
  const gate = () => {
    const r = spawnSync(process.execPath, [BIN, "hook", "stop"], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      input: "{}",
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const history = (...lines) =>
    put(
      HISTORY,
      `${lines
        .map((l) =>
          l.startsWith("{") || l === "not json"
            ? l
            : JSON.stringify({ treeHash: l, ranAt: "then" }),
        )
        .join("\n")}\n`,
    );
  const commitWork = (doc = null) => {
    put("src/a.txt", "a\n");
    if (doc) put(PHASE, doc);
    git("add", "-A");
    git("commit", "-qm", "work");
    return hashNow();
  };
  return { ...p, receipt, gate, history, commitWork, hashNow, digestOf };
}
