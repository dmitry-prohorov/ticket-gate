// Test binding for the duplication check: the check's CLI shim with demo project values inlined.
// Usage: node dup-cli.mjs [--update [--seed]] [--report=<path>] [--root=<dir>] [--baseline=<path>]
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { duplication } from '../../../checks/duplication.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

const ratchet = duplication({
  packages: {
    web: 'apps/web/',
    mobile: 'apps/mobile/',
    core: 'packages/core/',
  },
  withinMax: 20,
  config: '.jscpd.json',
  report: '.turbo/jscpd',
  baseline: 'tools/duplication-baseline.json',
  bin: join(REPO, 'node_modules', '.bin', 'jscpd'),
  comment:
    'Entries without "allow" are debt. "allow" is the reason a copy is deliberate. Never hand-add an entry: extract the shared code instead, and use `pnpm check:dup --update` only for a removed clone or a deliberate copy you then give an "allow" reason.',
  name: 'check:dup',
  fix: {
    noReport:
      'Run `node_modules/.bin/jscpd --config .jscpd.json` and read its error; if node_modules is stale run `pnpm install`.',
    fresh:
      'Extract the shared code: to the shared package when it is platform-free, else into one module both sides import. Do not baseline it. If the copy is deliberate, run `pnpm check:dup --update` and give the new entry an "allow" reason.',
    stale:
      'The copy was removed or changed: run `pnpm check:dup --update` and commit tools/duplication-baseline.json.',
    unreasoned:
      'Write why the copy is deliberate, or extract it and run `pnpm check:dup --update`.',
  },
});

export const { packageOf, compare, updateBaseline } = ratchet;
export const cloneOf = (dup, root = REPO) => ratchet.cloneOf(dup, root);

function main() {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='))?.slice(7);
  const r = ratchet.check({ root: resolve(rootArg ?? REPO), args });
  for (const l of r.err) console.error(l);
  for (const l of r.out) console.log(l);
  process.exitCode = r.code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
