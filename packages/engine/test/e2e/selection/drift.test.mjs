// DR-1: `--drift` maps a report's visited pages through `selection.drift.map`, and refuses to run
// when the config has none.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { fileRoots, jsGraph } from '../../../graph/js.mjs';
import { main } from '../../../selection/cli.mjs';
import { defineSelection } from '../../../selection/define.mjs';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-drift-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'e2e'), { recursive: true });
  writeFileSync(join(dir, 'e2e/a.spec.ts'), '// e2e-areas: calendar\n');
  writeFileSync(join(dir, 'a.js'), 'export const a = 1;\n');
  writeFileSync(
    join(dir, 'report.json'),
    JSON.stringify({
      suites: [
        {
          specs: [
            {
              file: 'a.spec.ts',
              tests: [
                {
                  status: 'expected',
                  annotations: [{ type: 'e2e-nav', description: '/timetable' }],
                  results: [],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  return dir;
};

const config = (root, drift) =>
  defineSelection({
    label: 'demo-select',
    root,
    specs: {
      dir: 'e2e',
      match: /\.spec\.ts$/,
      header: /^\/\/ e2e-areas: (.+)$/,
    },
    graphs: [jsGraph({ roots: [fileRoots(['a.js'], 'calendar')] })],
    commands: { self: 'demo', verify: 'demo verify' },
    ...(drift ? { drift } : {}),
  });

const capture = async (fn) => {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    return { code: await fn(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
};

test('DR-1 --drift without selection.drift exits 2 naming the key; with a map it prints the mapped lines', async () => {
  const root = repo();
  const bare = await capture(() => main(['--drift=report.json'], config(root)));
  assert.equal(bare.code, 2);
  assert.match(bare.err.join('\n'), /selection\.drift is required/);

  const seen = [];
  const mapped = await capture(() =>
    main(
      ['--drift=report.json'],
      config(root, {
        map: async (navigation, headers) => {
          seen.push([navigation, [...headers]]);
          return [
            { file: 'a.spec.ts', pathname: '/timetable', area: 'timetable' },
          ];
        },
      }),
    ),
  );
  assert.equal(mapped.code, 1);
  assert.deepEqual(seen, [
    [{ 'a.spec.ts': ['/timetable'] }, [['a.spec.ts', ['calendar']]]],
  ]);
  assert.match(
    mapped.out.join('\n'),
    /drift: a\.spec\.ts visited \/timetable \(timetable\) not in its header/,
  );
});
