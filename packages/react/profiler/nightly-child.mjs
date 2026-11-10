// Spawned by the nightly suite: one profiler run in the worktree. The nightly already holds the
// stack lock, so the profiler takes none. It leaves results.json and numbers.json in the run directory.
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { profiler } from './cli.mjs';
import { numbersOf } from './nightly.mjs';

const [config, out, ...args] = process.argv.slice(2);
try {
  const { default: cfg } = await import(pathToFileURL(resolve(config)).href);
  await profiler({ ...cfg, lock: false }).run([...args, `--out=${out}`]);
  const written = readdirSync(out)
    .filter((f) => /^results-\d+\.json$/.test(f))
    .sort()
    .at(-1);
  renameSync(join(out, written), join(out, 'results.json'));
  const { summary } = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
  writeFileSync(join(out, 'numbers.json'), JSON.stringify(numbersOf(summary, cfg)));
} catch (err) {
  console.error(String(err.message).replace(/\s*\n\s*/g, ' '));
  process.exitCode = 1;
}
// A handle a project config left open must not hold the suite until its time limit.
process.exit(process.exitCode ?? 0);
