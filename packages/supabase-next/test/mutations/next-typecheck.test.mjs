// Run by `pnpm test:tools`. Function cases inject fakes (no shell, pnpm or
// stack); CLI cases spawn the script in a throwaway repo under os.tmpdir() with
// plain shell test commands, so nothing touches this repo.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  readdirSync,
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { patchKey } from '#engine/mutations/served.mjs';
import { runMutations } from '#engine/mutations/run.mjs';
import {
  typecheckPatches,
  typechecked,
} from '../../mutations/next-typecheck.mjs';
import {
  ORIGINAL,
  repo,
  patch,
  scratch,
  serveWorld,
  pw,
  pwBites,
} from '../../../engine/test/mutations/__tests__/mutate-check.helpers.mjs';

// The real compiler comes from this repo's root devDependency (D3), standing in for a
// consumer's apps/web/node_modules.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const TS_LINE =
  "CalendarHeader.tsx(13,10): error TS6133: 'Columns3' is declared but its value is never read.";

test('M-1a a patch that does not type check is error before any build', async () => {
  const w = serveWorld(pwBites);
  w.io.typecheck = () =>
    new Map([
      [patchKey(patch('M1', { test: pw('a') })), { ok: false, line: TS_LINE }],
    ]);
  const r = await runMutations(
    { mutations: [patch('M1', { test: pw('a') })] },
    w.io,
  );
  assert.equal(r.results[0].status, 'error');
  assert.ok(r.results[0].detail.includes(TS_LINE), r.results[0].detail);
  assert.equal(w.builds, 0);
  assert.equal(w.starts, 0);
  assert.deepEqual(w.log, []);
  assert.equal(r.ok, false);
  // With a second, compiling entry: one clean build, and only that group builds.
  const w2 = serveWorld(pwBites);
  const bad = patch('M1', { test: pw('a') });
  const good = patch('M2', { test: pw('b'), replace: 'y' });
  w2.io.typecheck = () =>
    new Map([[patchKey(bad), { ok: false, line: TS_LINE }]]);
  const r2 = await runMutations({ mutations: [bad, good] }, w2.io);
  assert.equal(r2.results.find((x) => x.id === 'M1').status, 'error');
  assert.equal(r2.results.find((x) => x.id === 'M2').status, 'killed');
  assert.equal(w2.builds, 2);
  assert.equal(r2.groups.length, 1);
  assert.deepEqual(r2.groups[0].ids, ['M2']);
});

test('M-1b identical patches are type checked once', () => {
  const calls = [];
  const checker = {
    read: () => ORIGINAL,
    check: (file, source) => {
      calls.push([file, source === ORIGINAL ? 'clean' : 'patched']);
      return [];
    },
  };
  const a = patch('M1', { test: pw('a') });
  const b = patch('M2', { test: pw('b') });
  const c = patch('M3', { test: pw('c'), replace: 'x' });
  const out = typecheckPatches([a, b, c], checker);
  assert.equal(calls.filter((x) => x[1] === 'patched').length, 2);
  assert.equal(calls.filter((x) => x[1] === 'clean').length, 1);
  assert.deepEqual(out.get(patchKey(a)), out.get(patchKey(b)));
  assert.equal(out.size, 2);
});

test('M-1e an entry next build does not compile is n/a', () => {
  const calls = [];
  const checker = {
    read: () => ORIGINAL,
    check: (file) => {
      calls.push(file);
      return [];
    },
  };
  const vitest = patch('M1', { test: 'pnpm -F @demo/core test x' });
  const e2e = patch('M2', { test: pw('a'), file: 'apps/web/e2e/x.spec.ts' });
  const js = patch('M3', { test: pw('a'), file: 'apps/web/x.mjs' });
  assert.equal(typechecked(vitest), false);
  assert.equal(typechecked(e2e), false);
  assert.equal(typechecked(js), false);
  assert.equal(typechecked(patch('M4', { test: pw('a') })), true);
  assert.equal(typecheckPatches([vitest, e2e, js], checker).size, 0);
  assert.deepEqual(calls, []);
  // The CLI prints n/a for them.
  const dir = repo(ORIGINAL, { 'apps/web/e2e/x.spec.ts': 'x\n' });
  const file = join(dir, 'm.json');
  writeFileSync(
    file,
    scratch([
      patch('M1', { test: 'node --test src/x.test.mjs' }),
      patch('M2', { test: pw('a'), file: 'apps/web/e2e/x.spec.ts', find: 'x' }),
    ]),
  );
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', `--file=${file}`, '--typecheck'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(
    p.stdout,
    /^T\/M1 typecheck: n\/a \(not built by next build\)$/m,
  );
  assert.match(
    p.stdout,
    /^T\/M2 typecheck: n\/a \(not built by next build\)$/m,
  );
  assert.match(p.stdout, /T typecheck: 0 ok, 0 error, 2 n\/a, 0 checks/);
});

// A fixture with a real apps/web tsconfig and one .tsx, sharing the real node_modules.
const TSX = 'apps/web/lib/x.tsx';
const TSX_SRC = "import { used } from './util';\nexport const v = used;\n";
function tsRepo() {
  const dir = repo(ORIGINAL, {
    'apps/web/tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noUnusedLocals: true,
        noEmit: true,
        jsx: 'preserve',
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'es2022',
        skipLibCheck: true,
      },
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules', 'e2e'],
    }),
    'apps/web/package.json': '{"name":"web"}\n',
    'apps/web/lib/util.ts': 'export const used = 1;\n',
    [TSX]: TSX_SRC,
  });
  symlinkSync(
    join(REPO, 'node_modules'),
    join(dir, 'apps/web/node_modules'),
  );
  writeFileSync(
    join(dir, 'm.json'),
    scratch([
      patch('M1', {
        file: TSX,
        find: 'export const v = used;',
        replace: 'export const v = 1;',
        test: pw('a'),
      }),
      patch('M2', {
        file: TSX,
        find: 'export const v = used;',
        replace: 'export const v = used + 1;',
        test: pw('b'),
      }),
    ]),
  );
  return dir;
}
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else
        out[abs.slice(dir.length)] = createHash('sha256')
          .update(readFileSync(abs))
          .digest('hex');
    }
  };
  walk(dir);
  return out;
};
const tc = (dir) =>
  spawn(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json', '--typecheck'],
    {
      cwd: dir,
    },
  );

test('M-1c --typecheck leaves the tree byte-identical, including on SIGINT', async () => {
  const dir = tsRepo();
  const before = snapshot(dir);
  const done = (child) =>
    new Promise((res) => {
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code, signal) => res({ code, signal, out }));
    });
  const normal = await done(tc(dir));
  assert.equal(normal.code, 1, normal.out);
  assert.deepEqual(snapshot(dir), before);
  // SIGINT sent once the first `typecheck` line is printed.
  const child = tc(dir);
  const finished = done(child);
  let sent = false;
  child.stdout.on('data', (d) => {
    if (!sent && String(d).includes('typecheck')) {
      sent = true;
      child.kill('SIGINT');
    }
  });
  const interrupted = await finished;
  assert.equal(interrupted.code, 130, interrupted.out);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(existsSync(join(dir, '.turbo/mutation-check.json')), false);
  assert.equal(existsSync(join(dir, '.turbo/mutation-registry.json')), false);
});

test('M-1d the real compiler reports the unused import', () => {
  const dir = tsRepo();
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json', '--typecheck'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );
  assert.equal(p.status, 1, p.stdout + p.stderr);
  assert.match(
    p.stdout,
    /^T\/M1 typecheck: error apps\/web\/lib\/x\.tsx\(1,1\): error TS6133/m,
  );
  assert.match(p.stdout, /^T\/M2 typecheck: ok$/m);
  assert.match(p.stdout, /T typecheck: 1 ok, 1 error, 0 n\/a, 3 checks/);
});

test('M-1f a file that already fails is n/a, not an error', () => {
  const dir = tsRepo();
  writeFileSync(
    join(dir, TSX),
    `${TSX_SRC}import { nothere } from './util';\nexport const w = nothere;\n`,
  );
  const p = spawnSync(
    'node',
    ['tools/mutate-check.mjs', 'T', '--file=m.json', '--typecheck'],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.match(
    p.stdout,
    /^T\/M1 typecheck: n\/a \(clean apps\/web\/lib\/x\.tsx already fails: .*TS2305/m,
  );
  assert.match(p.stdout, /T typecheck: 0 ok, 0 error, 2 n\/a, 1 checks/);
});

test('M-1g an unjudgeable patch is not an error and still builds', async () => {
  const m = patch('M1', { test: pw('a') });
  const checker = {
    read: () => ORIGINAL,
    check: (file, source) => {
      assert.equal(source, ORIGINAL, 'the patched file must not be checked');
      return ['x.tsx(1,1): error TS2305: broken'];
    },
  };
  const out = typecheckPatches([m], checker);
  const v = out.get(patchKey(m));
  assert.equal(v.ok, null);
  assert.match(v.line, /already fails/);
  const w = serveWorld(pwBites);
  w.io.typecheck = () => out;
  const r = await runMutations({ mutations: [m] }, w.io);
  assert.notEqual(r.results[0].status, 'error', r.results[0].detail);
  assert.equal(r.results[0].status, 'killed');
  assert.equal(w.builds, 2);
});

test('M-1h --typecheck refuses --only, --digest and --defer-playwright', () => {
  const dir = tsRepo();
  for (const f of ['--only=M1', '--digest', '--defer-playwright']) {
    const p = spawnSync(
      'node',
      ['tools/mutate-check.mjs', 'T', '--file=m.json', '--typecheck', f],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(p.status, 2, `${f}: ${p.stdout}${p.stderr}`);
    assert.ok(p.stderr.includes(f.split('=')[0]), `${f}: ${p.stderr}`);
  }
});
