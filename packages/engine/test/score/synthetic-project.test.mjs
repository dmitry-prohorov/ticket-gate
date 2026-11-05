// A project that is not the demo one: its own package dir, a newFileMin of 90 and hand-written
// schema reports, driven through the real `ticket-gate score` bin. No mutation tool runs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "../../bin/ticket-gate.mjs");
const CONFIG_URL = pathToFileURL(join(HERE, "../../config.mjs")).href;
const STRYKER_URL = pathToFileURL(
  join(HERE, "../../score/adapters/stryker.mjs"),
).href;

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const FILE = "pkg/src/a.ts";
const NEW = "pkg/src/n.ts";

const configDir = (newFileMin, withScore = true) => {
  const dir = tmp("synthetic-config-");
  const score = withScore
    ? `{
  scope: /^pkg\\/src\\//,
  packageDir: 'pkg',
  newFileMin: ${newFileMin},
  baseInstall: { cmd: 'true', args: [], label: 'install', hint: 'npm ci', marker: '.done' },
  adapter: stryker({ branchCmd: ['true'], packageDir: 'pkg', config: 's.json', reportPath: 'r.json' }),
}`
    : null;
  writeFileSync(
    join(dir, "gate.config.mjs"),
    `import { defineGate } from '${CONFIG_URL}';\n` +
      `import { stryker } from '${STRYKER_URL}';\n` +
      `export default defineGate(${score ? `{ score: ${score} }` : "{}"});\n`,
  );
  return dir;
};

// a repo with a.ts committed (base) and line 3 changed on the branch
const project = () => {
  const dir = tmp("synthetic-project-");
  const git = (...a) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "pkg/src"), { recursive: true });
  writeFileSync(join(dir, FILE), "l1\nl2\nl3\nl4\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, FILE), "l1\nl2\nCHANGED\nl4\n");
  return { dir, base };
};

const mutant = (status, line, over = {}) => ({
  id: `${status}${line}`,
  mutatorName: "ConditionalExpression",
  replacement: "true",
  status,
  location: { start: { line, column: 1 }, end: { line, column: 2 } },
  ...over,
});
const times = (n, status, line) =>
  Array.from({ length: n }, () => mutant(status, line));

const report = (mutants, schemaVersion = "1.0", key = "src/a.ts") => ({
  schemaVersion,
  files: { [key]: { source: "l1\nl2\nl3\nl4\n", mutants } },
  testFiles: {},
});

const run = (p, branch, base, cfgDir = configDir(90)) => {
  const put = (name, body) => {
    const path = join(p.dir, name);
    if (body === null) rmSync(path, { force: true });
    else
      writeFileSync(
        path,
        typeof body === "string" ? body : JSON.stringify(body),
      );
    return path;
  };
  return spawnSync(
    "node",
    [
      BIN,
      "score",
      `--base=${p.base}`,
      `--root=${p.dir}`,
      `--report=${put("branch.json", branch)}`,
      `--base-report=${put("base.json", base)}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TICKET_GATE_CONFIG_DIR: cfgDir,
        TICKET_GATE_ROOT: p.dir,
      },
    },
  );
};

const killedOn = (line, n = 9) => [
  ...times(n, "Killed", line),
  mutant("Survived", 1),
];

test("SC-1 ticket-gate score passes a project whose hand-written report has no open mutant on changed lines", () => {
  const p = project();
  const r = report([...times(9, "Killed", 3), mutant("Survived", 1)]);
  const res = run(p, r, r);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(
    res.stdout.trim().split("\n").at(-1),
    "mutation: 1 files, score 90.0..90.0, 0 survivors on changed lines",
  );
});

test("SC-2 a survivor on a changed line exits 1 with the FAIL line", () => {
  const p = project();
  const res = run(
    p,
    report([...times(9, "Killed", 1), mutant("Survived", 3)]),
    report(times(10, "Killed", 1)),
  );
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.ok(
    res.stdout.includes(
      `mutation: FAIL ${FILE}: 1 surviving mutant(s) on changed lines`,
    ),
    res.stdout,
  );
});

test("SC-3 a mutant the base killed that survives on an unchanged line exits 1 as regressed", () => {
  const p = project();
  const res = run(
    p,
    report([...times(9, "Killed", 3), mutant("Survived", 1)]),
    report([...times(9, "Killed", 3), mutant("Killed", 1)]),
  );
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.ok(
    res.stdout.includes(
      `mutation: FAIL ${FILE}: 1 mutant(s) killed on base now survive on unchanged lines (a test was removed or weakened)`,
    ),
    res.stdout,
  );
});

test("SC-4 a new file under the configured newFileMin (90) exits 1; at 90 it passes", () => {
  const p = project();
  writeFileSync(join(p.dir, NEW), "n1\nn2\n");
  writeFileSync(join(p.dir, FILE), "l1\nl2\nl3\nl4\n"); // a.ts unchanged: only n.ts is a target
  const base = report([], "1.0");
  const score = (killed, total) =>
    report(
      [...times(killed, "Killed", 1), ...times(total - killed, "Survived", 2)],
      "1.0",
      "src/n.ts",
    );
  const low = run(p, score(17, 20), base);
  assert.equal(low.status, 1, low.stdout + low.stderr);
  assert.ok(
    low.stdout.includes(`mutation: FAIL ${NEW}: new file score 85.00 < 90`),
    low.stdout,
  );
  const edge = run(p, score(9, 10), base);
  assert.equal(edge.status, 0, edge.stdout + edge.stderr);
});

test('SC-5 schemaVersion "3.0" exits 2 with the mutation: FAIL line', () => {
  const p = project();
  const res = run(p, report(killedOn(3), "3.0"), report(killedOn(3)));
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(
    res.stdout,
    /^mutation: FAIL branch report .+branch\.json: schemaVersion "3\.0" is not a supported/m,
  );
});

test("SC-6 a report that is not JSON exits 2; a missing one exits 2", () => {
  const p = project();
  const bad = run(p, "not json {", report(killedOn(3)));
  assert.equal(bad.status, 2, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^mutation: FAIL branch report unreadable: /m);
  const gone = run(p, report(killedOn(3)), null);
  assert.equal(gone.status, 2, gone.stdout + gone.stderr);
  assert.match(gone.stdout, /^mutation: FAIL base report missing: /m);
});

test("SC-7 a mutant without location exits 2 naming the field", () => {
  const p = project();
  const { location, ...noLocation } = mutant("Survived", 3);
  assert.ok(location);
  const res = run(
    p,
    report([...times(9, "Killed", 3), noLocation]),
    report(killedOn(3)),
  );
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(
    res.stdout,
    /mutation: FAIL branch report .+: files\["src\/a\.ts"\]\.mutants\[9\]: location\.start\.line is not a positive integer/,
  );
});

test("SC-8 a gate without score exits 2 with the not-configured line on stderr", () => {
  const p = project();
  const res = run(
    p,
    report(killedOn(3)),
    report(killedOn(3)),
    configDir(0, false),
  );
  assert.equal(res.status, 2, res.stdout + res.stderr);
  assert.match(
    res.stderr,
    /mutation: FAIL score is not configured: add a score key to gate\.config\.mjs/,
  );
});
