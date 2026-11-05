// The pack's step defaults: which diffs select the e2e step, and the drift check that ends the
// database reset command.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { e2eWhen, RESET } from "../step-defaults.mjs";
import { bindTools } from "../tools.mjs";

bindTools({
  e2eAreas: {
    FULL_TRIGGERS: ["lock.yaml", "harness/"],
    TEST_FILE_RE: /\.test\.tsx?$/,
  },
});

test("VE-1a a non-test file under the core source selects e2e", () => {
  assert.equal(e2eWhen(["packages/core/src/domain/members.ts"]), true);
  // Control: a core test file, docs and an unrelated path do not.
  assert.equal(e2eWhen(["packages/core/src/domain/members.test.ts"]), false);
  assert.equal(e2eWhen(["docs/setup.md"]), false);
  assert.equal(e2eWhen([]), false);
});

test("VE-1b a full-trigger path, exact or by prefix, selects e2e", () => {
  assert.equal(e2eWhen(["lock.yaml"]), true);
  assert.equal(e2eWhen(["harness/seed.mjs"]), true);
  // Control: a near miss selects nothing, and one selecting path among others is enough.
  assert.equal(e2eWhen(["other.yaml", "harnes/x"]), false);
  assert.equal(e2eWhen(["docs/a.md", "harness/x.mjs"]), true);
});

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** The drift check alone (RESET minus its leading reset command), run in a repo that tracks one generated file of each kind. */
function driftRepo() {
  const dir = mkdtempSync(join(tmpdir(), "drift-"));
  dirs.push(dir);
  const put = (f, body) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  };
  const git = (...a) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd: dir,
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  put("packages/core/src/db.types.ts", "export type T = 1;\n");
  put("supabase/schema/tables/public.a.sql", "create table a ();\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const drift = RESET.slice(RESET.indexOf("&&") + 2).trim();
  const run = () => {
    try {
      execFileSync("sh", ["-c", drift], { cwd: dir, stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  return { put, run };
}

test("VT-S1a an untracked snapshot file fails the drift check", () => {
  const { put, run } = driftRepo();
  assert.equal(run(), 0, "control: a clean tree passes");
  put("supabase/schema/tables/public.b.sql", "create table b ();\n");
  assert.notEqual(run(), 0);
});

test("VT-S1b a changed tracked snapshot file fails the drift check", () => {
  const { put, run } = driftRepo();
  assert.equal(run(), 0, "control: a clean tree passes");
  put("supabase/schema/tables/public.a.sql", "create table a (id int);\n");
  assert.notEqual(run(), 0);
  // The generated types file is covered too.
  const types = driftRepo();
  types.put("packages/core/src/db.types.ts", "export type T = 2;\n");
  assert.notEqual(types.run(), 0);
});
