// L-1..L-3. Run by `pnpm test:tools`. Expected values come from the contract, never from
// running the implementation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluationSpecs,
  hasLoadTimeCode,
  loadTimeChanged,
  loadTimeUnits,
} from '../../../graph/load-time.mjs';

const first = (src, file = 'x.ts') => loadTimeUnits(src, file)[0];

test('L-1 the classifier calls only the F2 forms inert and everything else load-time', () => {
  const inert = [
    'function f() { return g(); }',
    'export default function () { return 1; }',
    'async function f() { await g(); }',
    'function* f() { yield g(); }',
    "import { a } from './a';",
    "export { a } from './a';",
    "export * from './a';",
    'const a = 1; export {};',
    "'use client';",
    "const a = 'x';",
    'const a = 1;',
    'const a = -1;',
    'const a = +1;',
    'const a = /x+/g;',
    'const a = null;',
    'const a = true;',
    'const a = `plain`;',
    "const a = { b: 1, c: { d: 'x', e: [1, 2, [3]] } };",
    "const a = ['a', 'b'];",
    'const a = () => g();',
    'const a = function () { return g(); };',
    'const a = Object.freeze({ a: 1 });',
    "const a = { b: 'x', c: [1] } as const;",
    "const a = { b: 'x' } satisfies Foo;",
    'const a = { m() { return g(); }, get x() { return g(); } };',
    "enum E { A, B = 'b', C = 3 }",
    'class C extends Error { x = g(); static m() { return g(); } y: number; }',
    'class C { static z: number; }',
    ';',
  ];
  for (const src of inert)
    assert.equal(first(src)?.loadTime ?? false, false, src);
  const typeOnly = [
    'interface I { a: number }',
    'type T = number;',
    "import type { A } from './a';",
    "export type { A } from './a';",
    'declare const x: number;',
  ];
  for (const src of typeOnly) assert.equal(loadTimeUnits(src).length, 0, src);
  const loadTime = [
    'const a = f();',
    'const a = `x${y}`;',
    'const a = new Map(f());',
    "const a = new Set(['a']);",
    'class C { static { init(); } }',
    'class C { static x = 1; }',
    'class A {} class B extends A {}',
    'if (x) { y(); }',
    'let x = 1;',
    'var x = 1;',
    'const a = { b: f() };',
    'const a = { b };',
    'const a = { ...b };',
    'const a = { [k]: 1 };',
    'export default X;',
    'const a = undefined;',
    'const a = Math.max(1, 2);',
    'const a = b;',
    'const { a } = b;',
    'foo();',
    'enum E { A = f() }',
    'await using x = null;',
    'using x = null;',
  ];
  for (const src of loadTime) {
    const units = src.startsWith('class A {}')
      ? loadTimeUnits(src)
      : [first(src)];
    assert.equal(units.at(-1).loadTime, true, src);
  }
  const nested = loadTimeUnits('const { a: { B } } = m; class X extends B {}');
  assert.deepEqual(
    nested.map((u) => u.loadTime),
    [true, true],
  );
  assert.equal(first('const a = <div />;', 'x.tsx').loadTime, true);
  assert.equal(hasLoadTimeCode('function f() {}'), false);
  assert.equal(hasLoadTimeCode('const a = f();'), true);
});

test('L-2 loadTimeChanged judges load-time statements, their order, and ignores comments', () => {
  const base = 'const A = 1;\nconst B = f(A);\nfunction g() { return 1; }\n';
  assert.equal(
    loadTimeChanged(
      base,
      'const A = 1;\nconst B = f(/* note */ A);\nfunction g() { return 1; }\n',
    ),
    false,
  );
  assert.equal(
    loadTimeChanged(
      base,
      'const A = 1;\n\nconst B =\n  f(A); // why\nfunction g() { return 1; }\n',
    ),
    false,
  );
  assert.equal(
    loadTimeChanged(
      base,
      'const A = 1;\nconst B = f(A);\nfunction g() { return 2; }\n',
    ),
    false,
  );
  assert.equal(
    loadTimeChanged(
      base,
      'const A = 1;\nconst B = f(A + 1);\nfunction g() { return 1; }\n',
    ),
    true,
  );
  assert.equal(loadTimeChanged(base, `${base}init();\n`), true);
  assert.equal(
    loadTimeChanged(base, 'const A = 1;\nfunction g() { return 1; }\n'),
    true,
  );
  assert.equal(
    loadTimeChanged(
      base,
      'const B = f(A);\nconst A = 1;\nfunction g() { return 1; }\n',
    ),
    true,
  );
  assert.equal(
    loadTimeChanged(
      'function a() { return 1; }\nfunction b() { return 2; }\n',
      'function b() { return 2; }\nfunction a() { return 1; }\n',
    ),
    false,
  );
  assert.equal(loadTimeChanged(null, 'const a = f();'), true);
  assert.equal(loadTimeChanged(null, 'function a() {}'), false);
});

test('L-3 evaluationSpecs lists the runtime edges and omits type-only ones', () => {
  const src = [
    "import { a } from './a';",
    "import './b';",
    "import { type C } from './c';",
    "export { d } from './d';",
    "export * from './e';",
    "const f = () => import('./f');",
    "import type { T } from './t';",
    "export type { U } from './u';",
    "type V = typeof import('./v');",
  ].join('\n');
  assert.deepEqual(evaluationSpecs(src).sort(), [
    './a',
    './b',
    './c',
    './d',
    './e',
    './f',
  ]);
});
