#!/usr/bin/env node
// A stand-in for a local database stack, so the example runs anywhere: the "database" is
// .turbo/db.json. A real project would call docker, supabase, sf or its own scripts here.
//
//   node tools/gate/db.mjs up | health | reset | migrate | status
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE = join('.turbo', 'db.json');
const read = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null);
const write = (s) => {
  mkdirSync('.turbo', { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(s, null, 2)}\n`);
};
const migrations = () => readdirSync(join('db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();

const [cmd] = process.argv.slice(2);
if (cmd === 'up') {
  write(read() ?? { up: true, applied: [] });
  console.log('db: up');
} else if (cmd === 'health') {
  if (!read()?.up) {
    console.error('db: down. Start it with: node tools/gate/db.mjs up');
    process.exit(1);
  }
  console.log('db: healthy');
} else if (cmd === 'reset') {
  write({ up: true, applied: migrations() });
  console.log(`db: reset, ${migrations().length} migration(s) applied`);
} else if (cmd === 'migrate') {
  const s = read() ?? { up: true, applied: [] };
  const todo = migrations().filter((m) => !s.applied.includes(m));
  write({ ...s, applied: [...s.applied, ...todo] });
  console.log(`db: migrated, ${todo.length} new migration(s)`);
} else if (cmd === 'status') {
  const s = read();
  console.log(s ? `db: ${s.up ? 'up' : 'down'}, ${s.applied.length} migration(s) applied` : 'db: never started');
} else {
  console.error('usage: node tools/gate/db.mjs up | health | reset | migrate | status');
  process.exit(2);
}
