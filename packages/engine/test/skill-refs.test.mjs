// The skill-reference ratchet (`createSkillRefs`) over mini trees under os.tmpdir(): a path-form
// reference needs its directory, a frontmatter `skills:` name needs an installed skill, and a
// prefixed name (one a project cannot resolve locally) fails closed.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { createSkillRefs } from "../ratchet.mjs";

const SOURCES = ["GUIDE.md", "agents/a.md", "agents/b.md"];
const refs = createSkillRefs({
  prefixes: ["ext", "vendor"],
  skillRoots: ["skills/shared", "skills/local"],
  sourceFiles: (root) => SOURCES.filter((f) => existsSync(join(root, f))),
  name: "check:refs",
  prefixedNote: " (prefixed names are not resolvable here)",
  fix: "Fix: install the skill or drop the reference.",
  usage: "Usage: gate refs [--root=DIR]",
});

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A tree with the skill `present` installed under skills/shared. */
function fixture(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "refs-"));
  dirs.push(dir);
  put(dir, "skills/shared/present/SKILL.md", "# present\n");
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  return dir;
}

test("SR-1 a skills/shared/<name> path with no directory fails", () => {
  const dir = fixture({
    "agents/a.md":
      "---\nname: a\n---\nline\nRead skills/shared/missing/SKILL.md first.\n",
  });
  const r = refs.checkSkillRefs(dir);
  assert.equal(r.code, 1);
  assert.ok(
    r.lines.some((l) =>
      l.startsWith("DANGLING agents/a.md:5 skills/shared/missing"),
    ),
    r.lines.join("\n"),
  );
  const ok = fixture({
    "agents/a.md": "Read skills/shared/present/SKILL.md first.\n",
  });
  assert.equal(refs.checkSkillRefs(ok).code, 0);
});

test("SR-2 a skills: frontmatter name with no installed skill fails, inline and block", () => {
  const inline = refs.checkSkillRefs(
    fixture({
      "agents/a.md": "---\nname: a\nskills: [present, missing]\n---\n",
    }),
  );
  assert.equal(inline.code, 1);
  assert.ok(
    inline.lines.some((l) => l.startsWith("DANGLING agents/a.md:3 missing")),
    inline.lines.join("\n"),
  );
  assert.ok(
    !inline.lines.some((l) => l.includes(" present")),
    inline.lines.join("\n"),
  );
  const block = refs.checkSkillRefs(
    fixture({
      "agents/a.md":
        "---\nname: a\nskills:\n  - present\n  - missing\n---\nbody\n",
    }),
  );
  assert.equal(block.code, 1);
  assert.ok(
    block.lines.some((l) => l.startsWith("DANGLING agents/a.md:5 missing")),
    block.lines.join("\n"),
  );
  const fine = refs.checkSkillRefs(
    fixture({ "agents/a.md": "---\nskills: [present]\n---\n" }),
  );
  assert.equal(fine.code, 0, fine.lines.join("\n"));
});

test("SR-3 a prefixed name fails closed even when a skill of that name is installed", () => {
  const dir = fixture({
    "GUIDE.md": "Use ext:present here.\n",
    "agents/b.md": "Use vendor:other there.\n",
  });
  const r = refs.checkSkillRefs(dir);
  assert.equal(r.code, 1);
  assert.ok(
    r.lines.some(
      (l) =>
        l.startsWith("DANGLING GUIDE.md:1 ext:present") &&
        l.includes("prefixed names are not resolvable here"),
    ),
    r.lines.join("\n"),
  );
  assert.ok(
    r.lines.some((l) => l.startsWith("DANGLING agents/b.md:1 vendor:other")),
    r.lines.join("\n"),
  );
  const front = refs.checkSkillRefs(
    fixture({ "agents/a.md": "---\nskills: [ext:present]\n---\n" }),
  );
  assert.equal(front.code, 1, front.lines.join("\n"));
});
