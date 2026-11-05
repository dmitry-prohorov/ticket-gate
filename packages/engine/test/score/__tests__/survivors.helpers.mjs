// Shared fixtures for the score engine tests; runCli drives the real `ticket-gate score` bin
// against a gate.config.mjs holding the demo score config.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '../../../bin/ticket-gate.mjs');
const DEMO_URL = pathToFileURL(join(HERE, 'demo.mjs')).href;
const CONFIG_URL = pathToFileURL(join(HERE, '../../../config.mjs')).href;
export const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

export const mut = (status, over = {}) => ({
  id: String(Math.random()),
  mutatorName: 'ConditionalExpression',
  replacement: 'true',
  status,
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  ...over,
});

export const many = (status, n) => Array.from({ length: n }, () => mut(status));

export const at = (line, column, endColumn) => ({
  start: { line, column },
  end: { line, column: endColumn },
});

export const verdict = (over) => ({
  path: 'packages/core/src/domain/a.ts',
  isNew: false,
  score: 90,
  baseScore: 90,
  noCoverageOnChanged: 0,
  ...over,
});

export const on = (status, line, over = {}) =>
  mut(status, { location: at(line, 1, 2), ...over });

export const A = 'packages/core/src/domain/a.ts';

export const fixtureFile = (mutants, source = 'x\ny\nconst z = a > b;\n') => ({
  source,
  mutants,
});

export function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'mutation-survivors-'));
  dirs.push(dir);
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'packages/core/src/domain'), { recursive: true });
  writeFileSync(join(dir, A), 'l1\nl2\nl3\nl4\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-qb', 'feat');
  return { dir, git, base };
}

export const B = 'packages/core/src/domain/b.ts';

export const reportOf = (files) => ({
  schemaVersion: '1.0',
  files,
  testFiles: {},
});

export const goodFiles = (bScore) => {
  // b.ts: ten valid mutants, bScore/10 of them killed
  const k = bScore / 10;
  return {
    // a survivor on line 1, which branchEdit leaves unchanged (line 3 is the changed one)
    'src/domain/a.ts': fixtureFile([
      ...many('Killed', 9),
      mut('Survived', { location: at(1, 1, 2) }),
    ]),
    'src/domain/b.ts': fixtureFile([
      ...many('Killed', k),
      ...many('Survived', 10 - k),
    ]),
  };
};

export const writeReports = (dir, branchFiles, baseFiles) => {
  writeFileSync(
    join(dir, 'branch.json'),
    JSON.stringify(reportOf(branchFiles)),
  );
  writeFileSync(join(dir, 'base.json'), JSON.stringify(reportOf(baseFiles)));
};

// One config dir for the whole file: defineGate({ score: DEMO_SCORE }) as gate.config.mjs.
let configDir;
const demoConfigDir = () => {
  if (configDir) return configDir;
  configDir = mkdtempSync(join(tmpdir(), 'score-config-'));
  dirs.push(configDir);
  writeFileSync(
    join(configDir, 'gate.config.mjs'),
    `import { defineGate } from '${CONFIG_URL}';\n` +
      `import { DEMO_SCORE } from '${DEMO_URL}';\n` +
      'export default defineGate({ score: DEMO_SCORE });\n',
  );
  return configDir;
};

export const runCli = (dir, base, ...extra) =>
  spawnSync(
    'node',
    [BIN, 'score', `--base=${base}`, `--root=${dir}`, ...extra],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        TICKET_GATE_CONFIG_DIR: demoConfigDir(),
        TICKET_GATE_ROOT: dir,
      },
    },
  );

export const withReports = (dir) => [
  `--report=${join(dir, 'branch.json')}`,
  `--base-report=${join(dir, 'base.json')}`,
];

export function branchEdit(r) {
  writeFileSync(join(r.dir, A), 'l1\nl2\nCHANGED\nl4\n');
  writeFileSync(join(r.dir, B), 'b1\nb2\n');
}

export const aOnly = (...muts) => ({ 'src/domain/a.ts': fixtureFile(muts) });

export function baseDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ms-base-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'packages/core/node_modules'), { recursive: true });
  return dir;
}
