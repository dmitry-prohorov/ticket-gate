// A throwaway git project with a stub Playwright, for the profiler cases. The stub writes the
// project's trace.json where the profiler asks for a trace, so no browser ever starts.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../../..');
export const PROFILE_URL = pathToFileURL(join(REPO, 'packages/react/profile.mjs')).href;
export const CLI = join(HERE, 'profile-cli.mjs');
export const BIN = join(REPO, 'packages/engine/bin/ticket-gate.mjs');
export { REPO };

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const us = (ms) => ms * 1000;
const sched = (message, startMs, endMs) => ({
  name: 'TimeStamp',
  args: {
    data: {
      trackGroup: 'Scheduler ⚛',
      track: 'Blocking',
      message,
      start: us(startMs),
      end: us(endMs),
    },
  },
});
const comp = (message, color = 'primary-light') => ({
  name: 'TimeStamp',
  args: { data: { track: 'Components ⚛', message, color, start: 0, end: 1 } },
});

/** Render R 0-4, Commit 4-5, R 5-7, R 7-10, Commit 10-11; Card x2 (one secondary), List x1. */
export const traces = {
  synthetic: [
    sched('Render', 0, 4),
    sched('Commit', 4, 5),
    sched('Render', 5, 7),
    sched('Render', 7, 10),
    sched('Commit', 10, 11),
    comp('Card'),
    comp('Memo(Card)'),
    comp('Card', 'secondary-light'),
    comp('CardList'),
    comp('List'),
  ],
  noCommit: [comp('Card'), comp('List')],
  mangled: [sched('Commit', 0, 1), comp('a'), comp('b')],
};

const STUB = `const { copyFileSync } = require('node:fs');
const { join } = require('node:path');
const trace = join(__dirname, '..', '..', '..', 'trace.json');
const page = {};
const context = {
  addInitScript: async () => {},
  newPage: async () => page,
  close: async () => {},
};
exports.chromium = {
  launch: async () => {
    const browser = {
      path: '',
      version: () => 'stub-1',
      newContext: async () => context,
      startTracing: async (_page, o) => {
        browser.path = o.path;
      },
      stopTracing: async () => copyFileSync(trace, browser.path),
      close: async () => {},
    };
    return browser;
  },
};
`;

const configText = ({ lock, build, appUp }) => `import { viteProfiling } from ${JSON.stringify(PROFILE_URL)};

const root = new URL('.', import.meta.url).pathname;

export default {
  root,
  command: 'demo profile',
  lock: ${JSON.stringify(lock)},
  scenarios: { home: async () => async () => {} },
  writing: [],
  componentsFor: () => ['Card', 'List'],
  usage: { maxRenders: 'home:<n>' },
  out: \`\${root}profile-out\`,
  tracePrefix: 'web-',
  context: { viewport: { width: 1280, height: 800 } },
  open: async () => {},
  reset: async () => {},
  playwrightFrom: \`\${root}package.json\`,
  appUrl: 'http://localhost:4173',
  build: { ...viteProfiling({ cmd: 'demo build', preview: 'demo preview' }), ...${JSON.stringify(build)} },
  messages: { expected: 'Card, List' },
  preflight: { portInUse: 'port in use', noApp: 'nothing answers: run with --build', noWebEnv: 'no app env' },
  services: [],
  probe: async () => ${appUp},
  hasEnv: () => true,
};
`;

/**
 * Writes a project: git repo with one commit, stub Playwright, `trace.json` and a profile
 * config. `links` also symlinks the three packages into node_modules for the README example.
 */
export function makeProject({
  trace = traces.synthetic,
  build = {},
  lock = false,
  appUp = true,
  links = false,
} = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'profile-project-')));
  dirs.push(dir);
  const w = (f, text) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  };
  w('package.json', '{"name":"scratch","private":true,"type":"module"}\n');
  w('trace.json', JSON.stringify(trace));
  w('node_modules/@playwright/test/package.json', '{"name":"@playwright/test","main":"index.js"}\n');
  w('node_modules/@playwright/test/index.js', STUB);
  w('profile.config.mjs', configText({ lock, build, appUp }));
  if (links) {
    mkdirSync(join(dir, 'node_modules/@ticket-gate'), { recursive: true });
    for (const p of ['engine', 'react', 'supabase-next'])
      symlinkSync(join(REPO, 'packages', p), join(dir, 'node_modules/@ticket-gate', p));
  }
  const git = (...a) =>
    execFileSync(
      'git',
      ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a],
      { cwd: dir, stdio: 'ignore' },
    );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init', '--no-verify');
  return { dir, write: w };
}

/** Runs the profiler in a child with a clean env: `args` after the project dir. */
export function runProfile(dir, args = [], env = {}, cmd = [CLI, dir]) {
  const r = spawnSync(process.execPath, [...cmd, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stderr: r.stderr };
}
