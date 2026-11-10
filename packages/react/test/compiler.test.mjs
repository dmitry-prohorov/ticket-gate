// CC-*: each case builds a throwaway git tree in os.tmpdir(), writes its own baseline and runs
// the CLI binding against it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const tool = join(here, '__tests__', 'compiler-cli.mjs');
const requireFromRoot = createRequire(join(repo, 'package.json'));
const PLUGIN = 'babel-plugin-react-compiler';

// Version of the plugin as the binding resolves it, never a literal.
function packageDirOf(req, name) {
  let dir = dirname(req.resolve(name));
  for (;;) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj) && JSON.parse(readFileSync(pj, 'utf8')).name === name) {
      return dir;
    }
    const up = dirname(dir);
    assert.notEqual(up, dir, `no package.json for ${name}`);
    dir = up;
  }
}
function pluginVersion() {
  return JSON.parse(
    readFileSync(
      join(packageDirOf(requireFromRoot, PLUGIN), 'package.json'),
      'utf8',
    ),
  ).version;
}
const PLUGIN_VERSION = pluginVersion();

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Writes `files` ({ relPath: source }) into a fresh git tree.
function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  dirs.push(dir);
  for (const [rel, src] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, src);
  }
  const git = spawnSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(git.status, 0, String(git.stderr));
  const add = spawnSync('git', ['add', '-A'], { cwd: dir });
  assert.equal(add.status, 0, String(add.stderr));
  return dir;
}

function writeBaseline(
  dir,
  { plugin = PLUGIN_VERSION, bailouts = [], skipped = [] },
  name = 'baseline.json',
) {
  const file = join(dir, '..', `${dir.split('/').pop()}-${name}`);
  dirs.push(file);
  writeFileSync(
    file,
    `${JSON.stringify({ comment: 'fixture', plugin, bailouts, skipped }, null, 2)}\n`,
  );
  return file;
}

function run(dir, baseline, ...extra) {
  const r = spawnSync(
    process.execPath,
    [tool, `--root=${dir}`, `--baseline=${baseline}`, ...extra],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const readBaseline = (file) => JSON.parse(readFileSync(file, 'utf8'));

const BAD_BODY = `async function go() {}
function done() {}
`;
const bad = (name) => `${BAD_BODY}export function ${name}() {
  const onClick = async () => {
    try {
      await go();
    } finally {
      done();
    }
  };
  return <button onClick={onClick}>x</button>;
}
`;
const arrow = `${BAD_BODY}export const Arrow = () => {
  const onClick = async () => {
    try {
      await go();
    } finally {
      done();
    }
  };
  return <button onClick={onClick}>x</button>;
};
`;
const GOOD = `import { useState } from 'react';
export function Good() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
`;
const SKIPPING_HOOK =
  'export function useThing(a: number) { return { v: a + 1 }; }\n';
const BAD_KEY = 'apps/web/components/Bad.tsx|Bad|Todo';
const ARROW_KEY = 'apps/web/components/Arrow.tsx|Arrow|Todo';
const HOOK_KEY = 'apps/mobile/lib/use-thing.ts|useThing';

test('CC-1 a new try/finally bailout fails and names the function', () => {
  const dir = makeTree({
    'apps/web/components/Bad.tsx': bad('Bad'),
    'apps/web/components/Arrow.tsx': arrow,
    'apps/web/components/Good.tsx': GOOD,
  });
  const empty = writeBaseline(dir, {});
  const r = run(dir, empty);
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(
    r.out,
    /new bailout: apps\/web\/components\/Bad\.tsx:\d+ Bad \[Todo\]/,
  );
  assert.match(
    r.out,
    /new bailout: apps\/web\/components\/Arrow\.tsx:\d+ Arrow \[Todo\]/,
  );
  assert.doesNotMatch(r.out, /new bailout: [^\n]*Good/);
  const summary = /(\d+) compiled functions/.exec(r.out);
  assert.ok(summary && Number(summary[1]) >= 1, `summary: ${r.out}`);

  const known = writeBaseline(
    dir,
    {
      bailouts: [
        { key: ARROW_KEY, reason: 'x' },
        { key: BAD_KEY, reason: 'x' },
      ],
    },
    'known.json',
  );
  const ok = run(dir, known);
  assert.equal(ok.status, 0, ok.out + ok.err);
  assert.doesNotMatch(ok.out, /new bailout/);
});

test('CC-2 a fixed bailout is stale until --update drops it', () => {
  const dir = makeTree({ 'apps/web/components/Good.tsx': GOOD });
  const file = writeBaseline(dir, {
    bailouts: [{ key: 'apps/web/components/Good.tsx|Good|Todo', reason: 'x' }],
  });
  const r = run(dir, file);
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.out, /stale: apps\/web\/components\/Good\.tsx\|Good\|Todo/);

  const upd = run(dir, file, '--update');
  assert.equal(upd.status, 0, upd.out + upd.err);
  assert.deepEqual(readBaseline(file).bailouts, []);
  const after = run(dir, file);
  assert.equal(after.status, 0, after.out + after.err);
});

test('CC-2b a stale skip entry fails until --update drops it', () => {
  const dir = makeTree({ 'apps/web/components/Good.tsx': GOOD });
  const file = writeBaseline(dir, {
    skipped: [{ key: 'apps/web/components/Good.tsx|Good', allow: 'x' }],
  });
  const r = run(dir, file);
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.out, /stale: apps\/web\/components\/Good\.tsx\|Good/);

  const upd = run(dir, file, '--update');
  assert.equal(upd.status, 0, upd.out + upd.err);
  assert.deepEqual(readBaseline(file).skipped, []);
  const after = run(dir, file);
  assert.equal(after.status, 0, after.out + after.err);
});

test('CC-3 a hook the compiler silently skips fails', () => {
  const dir = makeTree({ 'apps/mobile/lib/use-thing.ts': SKIPPING_HOOK });
  const file = writeBaseline(dir, {});
  const r = run(dir, file);
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(
    r.out,
    /skipped: apps\/mobile\/lib\/use-thing\.ts:\d+ useThing /,
  );

  const memo = makeTree({
    'apps/mobile/lib/use-thing.ts': `export function useThing(a: number) {
  'use memo';
  return { v: a + 1 };
}
`,
  });
  const ok = run(memo, writeBaseline(memo, {}));
  assert.equal(ok.status, 0, ok.out + ok.err);
  assert.doesNotMatch(ok.out, /skipped:/);
});

test('CC-4 an empty allow fails; a reasoned one passes', () => {
  const dir = makeTree({ 'apps/mobile/lib/use-thing.ts': SKIPPING_HOOK });
  const reasoned = writeBaseline(dir, {
    skipped: [{ key: HOOK_KEY, allow: 'route handler' }],
  });
  const ok = run(dir, reasoned);
  assert.equal(ok.status, 0, ok.out + ok.err);

  const empty = writeBaseline(
    dir,
    { skipped: [{ key: HOOK_KEY, allow: '' }] },
    'empty.json',
  );
  const r = run(dir, empty);
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(r.out, /unreasoned: apps\/mobile\/lib\/use-thing\.ts\|useThing/);
});

test('CC-5 --update keeps reasons, new entries get allow "", --seed gives debt', () => {
  const dir = makeTree({
    'apps/web/components/Old.tsx': bad('Old'),
    'apps/web/components/Bad.tsx': bad('Bad'),
  });
  const oldKey = 'apps/web/components/Old.tsx|Old|Todo';
  const seedBaseline = {
    bailouts: [{ key: oldKey, reason: 'x', allow: 'vendored' }],
  };

  const file = writeBaseline(dir, seedBaseline, 'upd.json');
  const upd = run(dir, file, '--update');
  assert.equal(upd.status, 0, upd.out + upd.err);
  const entries = readBaseline(file).bailouts;
  assert.equal(entries.find((e) => e.key === oldKey)?.allow, 'vendored');
  const fresh = entries.find((e) => e.key === BAD_KEY);
  assert.ok(fresh, 'new bailout was not written');
  assert.equal(fresh.allow, '');
  const check = run(dir, file);
  assert.equal(check.status, 1, check.out + check.err);

  const seeded = writeBaseline(dir, seedBaseline, 'seed.json');
  const seed = run(dir, seeded, '--update', '--seed');
  assert.equal(seed.status, 0, seed.out + seed.err);
  const sEntries = readBaseline(seeded).bailouts;
  assert.equal(sEntries.find((e) => e.key === oldKey)?.allow, 'vendored');
  const debt = sEntries.find((e) => e.key === BAD_KEY);
  assert.ok(debt, 'seeded bailout was not written');
  assert.equal(debt.allow, undefined);
  const ok = run(dir, seeded);
  assert.equal(ok.status, 0, ok.out + ok.err);
});

test('CC-6 tests, specs, e2e, .maestro, .d.ts and *.config.ts are not scanned', () => {
  const src = bad('Excluded');
  const dir = makeTree({
    'apps/web/components/Bad.test.tsx': src,
    'apps/web/e2e/bad.tsx': src,
    'apps/web/__tests__/bad.tsx': src,
    'apps/mobile/.maestro/x.tsx': src,
    'apps/web/next.config.ts': src,
    'apps/web/types.d.ts': src,
    'apps/web/components/Good.tsx': GOOD,
  });
  const r = run(dir, writeBaseline(dir, {}));
  assert.equal(r.status, 0, r.out + r.err);
  assert.doesNotMatch(r.out, /new bailout/);

  // Positive control: the same tree plus one scanned file fails, on that file only.
  const control = makeTree({
    'apps/web/components/Bad.test.tsx': src,
    'apps/web/e2e/bad.tsx': src,
    'apps/web/__tests__/bad.tsx': src,
    'apps/mobile/.maestro/x.tsx': src,
    'apps/web/next.config.ts': src,
    'apps/web/types.d.ts': src,
    'apps/web/components/Bad.tsx': bad('Bad'),
  });
  const c = run(control, writeBaseline(control, {}));
  assert.equal(c.status, 1, c.out + c.err);
  assert.match(c.out, /new bailout: apps\/web\/components\/Bad\.tsx:/);
  assert.doesNotMatch(c.out, /Excluded/);
});

test('CC-10 a .ts file with an angle-bracket assertion is scanned', () => {
  const dir = makeTree({
    'packages/core/src/cast.ts':
      "const u: unknown = 'a';\nexport const c = <string>u;\n",
  });
  const r = run(dir, writeBaseline(dir, {}));
  assert.equal(r.status, 0, r.out + r.err);
});

test('CC-11 nested memo(forwardRef) bailouts keep their names', () => {
  const wrapped = (name) => `export const ${name} = memo(
  forwardRef((p, ref) => {
    const onClick = async () => {
      try {
        await go();
      } finally {
        done();
      }
    };
    return <button ref={ref} onClick={onClick}>x</button>;
  }),
);
`;
  const dir = makeTree({
    'apps/web/components/Wrapped.tsx': `import { forwardRef, memo } from 'react';
${BAD_BODY}${wrapped('Wrapped')}${wrapped('Other')}`,
  });
  const r = run(dir, writeBaseline(dir, {}));
  assert.equal(r.status, 1, r.out + r.err);
  assert.match(
    r.out,
    /new bailout: apps\/web\/components\/Wrapped\.tsx:\d+ Wrapped \[Todo\]/,
  );
  assert.match(
    r.out,
    /new bailout: apps\/web\/components\/Wrapped\.tsx:\d+ Other \[Todo\]/,
  );
  assert.doesNotMatch(r.out, /<anonymous>/);
});

test("CC-7 a plugin version other than the baseline's fails", () => {
  const dir = makeTree({ 'apps/web/components/Good.tsx': GOOD });
  const r = run(dir, writeBaseline(dir, { plugin: '0.0.0' }));
  assert.equal(r.status, 1, r.out + r.err);
  assert.ok(r.out.includes('0.0.0'), r.out);
  assert.ok(r.out.includes(PLUGIN_VERSION), r.out);

  const ok = run(dir, writeBaseline(dir, {}, 'ok.json'));
  assert.equal(ok.status, 0, ok.out + ok.err);
});

test('CC-8 several diagnostics in one function are one entry', () => {
  const dir = makeTree({
    'apps/web/components/Twice.tsx': `${BAD_BODY}export function Twice() {
  const a = async () => {
    try {
      await go();
    } finally {
      done();
    }
  };
  const b = async () => {
    try {
      await go();
    } finally {
      done();
    }
  };
  return <button onClick={a} onDoubleClick={b}>x</button>;
}
`,
  });
  const file = writeBaseline(dir, {});
  const r = run(dir, file, '--update', '--seed');
  assert.equal(r.status, 0, r.out + r.err);
  const entries = readBaseline(file).bailouts;
  assert.equal(entries.length, 1, JSON.stringify(entries));
  assert.equal(entries[0].key, 'apps/web/components/Twice.tsx|Twice|Todo');
});
