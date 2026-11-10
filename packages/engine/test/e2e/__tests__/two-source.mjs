// Synthetic two-source selection fixture (G-1..G-5b). Not a test file.
// A LWC-shaped js graph (root area `a`, a `c/` resolver, an Apex leaf resolver) plus a
// hand-written second source `apex` whose reach and expand are configurable.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fileRoots, jsGraph } from '../../../graph/js.mjs';
import { defineSelection } from '../../../selection/define.mjs';

const dirs = [];
export const cleanup = () =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));

export const FILES = {
  'web/app/a.js': `import { x } from 'c/x';\nexport const a = x;\n`,
  'lwc/x/x.js': `import run from '@salesforce/apex/Ctl.run';\nexport const x = run;\n`,
  // Unresolvable if it were parsed: the leaf resolver must stop the walk here.
  'classes/Ctl.cls': `import { y } from './nope';\n`,
  'classes/Svc.cls': `public class Svc {}\n`,
};

export const lwcResolver = {
  name: 'lwc',
  resolve: (s) => {
    if (!s.startsWith('c/')) return null;
    const n = s.slice(2);
    return { file: `lwc/${n}/${n}.js` };
  },
};

export const apexResolver = {
  name: 'apex',
  resolve: (s) => {
    const p = '@salesforce/apex/';
    if (!s.startsWith(p)) return null;
    const cls = s.slice(p.length).split('.')[0];
    return { file: `classes/${cls}.cls`, leaf: true };
  },
};

export const jsSource = () =>
  jsGraph({
    roots: [fileRoots(['web/app/a.js'], 'a')],
    resolvers: [lwcResolver, apexResolver],
  });

/** Hand-written second source: reach(Svc.cls) = bArea (if any); expand(Svc.cls) = [Ctl.cls]. */
export const apexSource = (bArea) => ({
  name: 'apex',
  graph: () => ({
    reach: (p) => ({
      areas: new Set(p === 'classes/Svc.cls' && bArea ? [bArea] : []),
      specs: new Set(),
    }),
    expand: (p) => (p === 'classes/Svc.cls' ? ['classes/Ctl.cls'] : []),
  }),
});

/**
 * @param {{ bArea?: string|null, bFirst?: boolean }} opts
 * @returns {{ dir: string, cfg: object }}
 */
export function twoSource({ bArea = null, bFirst = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-two-source-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  mkdirSync(join(dir, 'web/e2e'), { recursive: true });
  const graphs = bFirst
    ? [apexSource(bArea), jsSource()]
    : [jsSource(), apexSource(bArea)];
  const cfg = defineSelection({
    root: dir,
    areas: null,
    specs: {
      dir: 'web/e2e',
      match: /\.spec\.ts$/,
      header: /^\/\/ e2e-areas: ([a-z]+(, [a-z]+)*)$/,
    },
    outside: { prefixes: ['web/', 'lwc/', 'classes/'] },
    graphs,
  });
  return { dir, cfg };
}
