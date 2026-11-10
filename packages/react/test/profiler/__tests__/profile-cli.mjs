// Spawned by the profiler cases: process.argv[2] is the project dir, the rest are profiler args.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { profile } from '../../../profile.mjs';

const [dir, ...args] = process.argv.slice(2);
try {
  const { default: cfg } = await import(pathToFileURL(join(dir, 'profile.config.mjs')).href);
  await profile(cfg).run(args);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
