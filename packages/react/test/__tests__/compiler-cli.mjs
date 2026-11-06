// Test binding for the React Compiler check: the check's CLI shim with demo project values inlined.
// Usage: node compiler-cli.mjs [--update [--seed]] [--root=<dir>] [--baseline=<path>]
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reactCompiler } from '../../compiler.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SCAN_DIRS = ['apps/web', 'apps/mobile', 'packages/core/src'];

const EXCLUDE =
  /(^|\/)(e2e|\.maestro|__tests__)\/|\.(test|spec)\.[jt]sx?$|\.d\.ts$|(^|\/)[^/]+\.config\.[cm]?[jt]s$/;

const BASELINE_COMMENT =
  'Entries without "allow" are debt. "allow" is the reason a bailout or a skipped function is deliberate. Never hand-add an entry: fix the function, or run `pnpm check:compiler --update` only for a fixed bailout or one you then give an "allow" reason.';

const compiler = reactCompiler({
  repo: REPO,
  scanDirs: SCAN_DIRS,
  exclude: EXCLUDE,
  resolve: { from: '.', via: ['@babel/core'] },
  baseline: 'tools/react-compiler-baseline.json',
  comment: BASELINE_COMMENT,
  name: 'check:compiler',
  update: 'pnpm check:compiler --update',
  install: 'pnpm install',
});

function main() {
  const { code, out, err } = compiler.run(process.argv.slice(2));
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  process.exitCode = code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
