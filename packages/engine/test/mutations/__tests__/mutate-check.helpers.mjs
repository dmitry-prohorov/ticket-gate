import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bindConsumer } from './consumer.fixture.mjs';

bindConsumer();

const HERE = dirname(fileURLToPath(import.meta.url));
// The registry the consumer fixture's committed-entries helper reads: this repo's own.
const REPO = join(HERE, '../../../../..');
export const dirs = [];

/** Every live entry of the committed registry: [key, entry, area file]. */
export function committedEntries() {
  const root = join(REPO, 'mutation-registry');
  if (!existsSync(root)) return [];
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(d, e.name))
        : e.name.endsWith('.json')
          ? [join(d, e.name)]
          : [],
    );
  return walk(root).flatMap((f) =>
    Object.entries(JSON.parse(readFileSync(f, 'utf8')))
      .filter(([, e]) => !e.retired)
      .map(([key, e]) => [key, e, f]),
  );
}
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

export const SRC = 'src/guard.ts';
export const ORIGINAL = 'before\nif (n === 0) throw forbidden;\nafter $& $1\n';
export const FIND = 'if (n === 0) throw forbidden;';

// The tools/<x>.mjs scripts the ported bodies spawn: each binds the consumer fixture's
// Setup, then calls the engine module by file URL (the scratch repo has no install).
const url = (rel) => pathToFileURL(join(HERE, rel)).href;
const BIND = `import { bindConsumer } from '${url('consumer.fixture.mjs')}';
bindConsumer();
`;
const SHIMS = {
  'mutate-check.mjs': `${BIND}import { main } from '${url('../../../mutations/cli.mjs')}';
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
  'tree-hash.mjs': `export * from '${url('../../../tree.mjs')}';
`,
};

export function repo(source = ORIGINAL, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-check-'));
  dirs.push(dir);
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: dir,
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'tools'));
  for (const [name, body] of Object.entries(SHIMS))
    writeFileSync(join(dir, 'tools', name), body);
  writeFileSync(join(dir, 'gate.config.mjs'), 'export default {};\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, SRC), source);
  for (const [rel, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  writeFileSync(join(dir, '.gitignore'), '.turbo/\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  return dir;
}

export const patch = (id, over = {}) => ({
  id,
  protects: `5 ${id}`,
  kind: 'patch',
  file: SRC,
  find: FIND,
  replace: '',
  test: 'fake test',
  ...over,
});
// A scratch registry file (`--file=`): one area object, keys `<ticket>/<id>`.
export const scratch = (mutations, ticket = 'T') =>
  JSON.stringify(
    Object.fromEntries(
      mutations.map(({ id, ...e }) => [
        `${ticket}/${id}`,
        { testFile: SRC, ...e },
      ]),
    ),
  );
export const sql = (id, test = 'fake test') => ({
  id,
  protects: `3#${id}`,
  kind: 'sql',
  object: 'table public.t',
  apply: `select '${id}';`,
  test,
});

// A fake world: one file in memory, a log of every call, a scripted test.
export function world(
  testFn = () => ({ code: 1, out: 'red' }),
  file = ORIGINAL,
) {
  const w = { file, log: [], seenDuringTest: [] };
  w.io = {
    preflight: () => {
      w.log.push('preflight');
      return w.preflightFn();
    },
    readFile: () => w.file,
    writeFile: (_p, s) => {
      w.file = s;
    },
    run: (cmd) => {
      w.seenDuringTest.push(w.file);
      w.log.push(`run:${cmd}`);
      return testFn(cmd, w);
    },
    resetDb: () => {
      w.log.push('reset');
      w.mutated = false;
      return { code: 0, out: '' };
    },
    applySql: (s) => {
      w.log.push(`sql:${s}`);
      w.mutated = s.startsWith("select 'M");
      return { code: 0, out: '' };
    },
    // Catalog fakes: scripted per call number (0 = the baseline read).
    digest: () => {
      w.log.push('digest');
      return w.digestFn(w.digestCalls++);
    },
    snapshot: () => {
      w.log.push('snapshot');
      return w.snapFn(w.snapCalls++);
    },
  };
  w.preflightFn = () => ({ code: 0, out: '' });
  w.mutated = false;
  w.digestCalls = 0;
  w.snapCalls = 0;
  w.digestFn = () => 'BASE';
  w.snapFn = () => (w.mutated ? [policyObj()] : []);
  return w;
}
// Green on the first (baseline) call of a command, red after: a test that bites.
export const bites = () => {
  const seen = new Set();
  return (cmd) => {
    if (!seen.has(cmd)) {
      seen.add(cmd);
      return { code: 0, out: 'ok' };
    }
    return { code: 1, out: 'FAIL' };
  };
};
export const green = () => ({ code: 0, out: 'ok' });
// Red only while a sql mutation is applied: the fake of a test that bites.
export const whileMutated = (_cmd, w) =>
  w.mutated ? { code: 1, out: 'FAIL' } : { code: 0, out: 'ok' };
export const policyObj = (fp = 'x') => ({
  kind: 'policy',
  key: 'public.t.p',
  fp,
  create: 'create policy p on public.t',
  drop: 'drop policy if exists p on public.t',
});

export const V_NOMATCH = `
 RUN  v3.2.7 /repo/packages/core

 ↓ src/domain/agenda.test.ts (3 tests | 3 skipped)

 Test Files  1 skipped (1)
      Tests  3 skipped (3)
   Start at  15:51:03
   Duration  1.82s
`;

export const V_NOFILE = `
 RUN  v3.2.7 /repo/packages/core

No test files found, exiting with code 1

filter: src/domain/zzz-nofile
include: src/**/*.test.ts
`;

export const V_OK = `
 ✓ src/domain/async-action.test.ts (4 tests) 8ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
`;

export function serveWorld(testFn) {
  const w = world(testFn);
  Object.assign(w, {
    builds: 0,
    starts: 0,
    stops: 0,
    busy: false,
    startThrows: false,
    runOpts: [],
    buildFn: () => ({ code: 0, out: '' }),
  });
  w.io.run = (cmd, o) => {
    w.seenDuringTest.push(w.file);
    w.log.push(`run:${cmd}`);
    w.runOpts.push({ cmd, mutated: w.file !== ORIGINAL, reuse: o?.reuse });
    return testFn(cmd, w);
  };
  w.io.buildWeb = () => {
    w.builds++;
    w.log.push('buildWeb');
    return w.buildFn(w.builds);
  };
  w.io.startServer = async () => {
    w.starts++;
    if (w.startThrows) throw new Error('spawn blew up');
    return {
      ok: true,
      out: '',
      stop: async () => {
        w.stops++;
      },
    };
  };
  w.io.portInUse = async () => w.busy;
  return w;
}

export const pw = (name) =>
  `pnpm -F web exec playwright test e2e/${name}.spec.ts`;

export const PW_PASS = '\n  1 passed (3.2s)\n';

// Green on the clean tree, red while a patch is applied: a test that bites.
export const pwBites = (_cmd, w) =>
  w.file === ORIGINAL
    ? { code: 0, out: PW_PASS }
    : { code: 1, out: 'FAIL expected true' };
