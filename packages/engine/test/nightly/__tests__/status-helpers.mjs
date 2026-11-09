// Shared helpers for the nightly status tests.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const BIN = join(HERE, '..', '..', '..', 'bin', 'ticket-gate.mjs');
const CONFIG_URL = pathToFileURL(join(HERE, '..', '..', '..', 'config.mjs')).href;
const DEMO_URL = pathToFileURL(join(HERE, 'demo-nightly.mjs')).href;
export const FIX = join(HERE, 'fixtures', 'nightly');
export const fixture = (n) =>
  JSON.parse(readFileSync(join(FIX, `${n}.json`), 'utf8'));
export const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
export const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'nightly-status-'));
  dirs.push(d);
  return d;
};

export const H = 3_600_000;
export const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();
export const iso = (ms) => new Date(ms).toISOString();
export const line = (over = {}) => ({
  v: 1,
  sha: 'a'.repeat(40),
  ranAt: iso(NOW - H),
  endedAt: iso(NOW - H / 2),
  ms: 1_800_000,
  trigger: 'scheduled',
  status: 'green',
  reason: null,
  reachedPlaywright: true,
  stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 1 },
  redSpecs: [],
  flakySpecs: [],
  report: 'r.json',
  finalReset: 'pass',
  ...over,
});
export const flakyLine = (spec, hoursAgo, over = {}) =>
  line({
    ranAt: iso(NOW - hoursAgo * H),
    status: 'amber',
    stats: { expected: 3, unexpected: 0, flaky: 1, skipped: 1 },
    flakySpecs: [spec],
    ...over,
  });
export const SPEC = 'calendar.spec.ts';
export const flakySummary = {
  stats: { expected: 3, unexpected: 0, flaky: 1, skipped: 1 },
  failedSpecs: [],
  flakySpecs: [SPEC],
  redTests: [],
};
export const cleanSummary = {
  stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 1 },
  failedSpecs: [],
  flakySpecs: [],
  redTests: [],
};

// A fake git: `log` returns tab-separated "sha<TAB>subject" lines (newest
// first), `diff` returns the changed paths of the merge named in the args.
export function fakeGit(merges, { onCall } = {}) {
  return (...raw) => {
    const args = raw.flat().flatMap((a) => String(a).split(' '));
    onCall?.(args);
    if (args.includes('log')) {
      const cap = args.find((a) => /^-\d+$|^--max-count=\d+$/.test(a));
      const n = cap ? Number(cap.replace(/\D/g, '')) : merges.length;
      const nIdx = args.indexOf('-n');
      const cap2 = nIdx >= 0 ? Number(args[nIdx + 1]) : n;
      return merges
        .slice(0, Math.min(n, cap2))
        .map((m) => `${m.sha}\t${m.subject}`)
        .join('\n');
    }
    if (args.includes('diff')) {
      const key = args.find((a) => a.endsWith('^1'));
      const sha = key ? key.slice(0, -2) : args.at(-1);
      return (merges.find((m) => m.sha === sha)?.files ?? []).join('\n');
    }
    return '';
  };
}

export const GREEN_SHA = 'g'.repeat(40);
export const RED_SHA = 'r'.repeat(40);

// --- T-7: the CLI, in a throwaway project (a git repo and a gate.config.mjs with the demo nightly) ---
export function scratchProject() {
  const dir = tmp();
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: dir,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  git('init', '-q', '-b', 'main');
  writeFileSync(
    join(dir, 'gate.config.mjs'),
    `import { defineGate, step } from '${CONFIG_URL}';
import { nightly } from '${DEMO_URL}';
export default defineGate({
  steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })],
  nightly,
});
`,
  );
  writeFileSync(join(dir, 'base.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { dir, sha: git('rev-parse', 'HEAD').trim() };
}
export const cliRepo = scratchProject;
export const cli = (repo, nightly, ...args) =>
  spawnSync(process.execPath, [BIN, 'nightly', 'status', ...args], {
    cwd: repo.dir,
    encoding: 'utf8',
    env: { ...process.env, FP_NIGHTLY_DIR: nightly, FP_STACK_LOCK_OWNER: '' },
  });
export function nightlyDir(repo, latest) {
  const d = tmp();
  if (latest) {
    const l = {
      ...line({
        sha: repo.sha,
        ranAt: iso(Date.now() - H),
        endedAt: iso(Date.now()),
      }),
      ...latest,
    };
    writeFileSync(
      join(d, 'latest.json'),
      `${JSON.stringify({ ...l, redTests: l.redTests ?? [] })}\n`,
    );
    writeFileSync(join(d, 'history.jsonl'), `${JSON.stringify(l)}\n`);
  }
  return d;
}
