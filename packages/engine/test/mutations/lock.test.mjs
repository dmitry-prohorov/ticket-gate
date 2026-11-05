import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { tryTake } from '../../lock.mjs';
import { GUARD, bin, gateProject } from './__tests__/gate-project.mjs';

const kids = [];
after(() => kids.forEach((k) => k.kill('SIGKILL')));

test('LK-1 mutate exits 1 naming the holder while another owner holds the stack lock', () => {
  const { dir } = gateProject({
    config: `import { defineGate } from ${JSON.stringify(
      new URL('../../config.mjs', import.meta.url).href,
    )};\nexport default defineGate({ steps: [], mutations: {} });\n`,
  });
  // A live holder: the lock sits at the project's default .turbo/stack.lock.
  const holderProc = spawn('sleep', ['60'], { stdio: 'ignore' });
  kids.push(holderProc);
  const { holder } = tryTake(join(dir, '.turbo', 'stack.lock'), {
    owner: 'verify:ticket',
    cwd: '/work/holder',
    pid: holderProc.pid,
    env: {},
  });
  // The child env is PATH and HOME only (bin), so it carries no lock variable.
  const r = bin(dir, ['mutate', '--registry', '--all']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /mutate:check: stack lock held: verify:ticket running since/);
  assert.match(r.out, new RegExp(`pid ${holder.pid}\\b`));
  assert.equal(readFileSync(join(dir, 'src/guard.mjs'), 'utf8'), GUARD);
});
