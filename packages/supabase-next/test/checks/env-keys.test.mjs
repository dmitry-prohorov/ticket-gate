import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkEnvExampleKeys } from '../../checks/env-keys.mjs';

// The published demo secret of every `supabase start` stack (not a secret).
const DEMO = 'super-secret-jwt-token-with-at-least-32-characters-long';

const targets = [
  { file: 'a/.env.example', name: 'A' },
  { file: 'b/.env.example', name: 'B' },
];
const fix = ['f1', 'f2'];

// The demo anon key every `supabase start` stack ships; rebuilt here so no JWT literal is committed.
function realKey() {
  return sign({ iss: 'supabase-demo', role: 'anon', exp: 1983812996 });
}

function sign(claims) {
  const h = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = createHmac('sha256', DEMO).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}

function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'env-keys-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return checkEnvExampleKeys({ root, targets, label: 'L', fix });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('EK-1 checkEnvExampleKeys: valid, bad signature, wrong role, missing, two segments', () => {
  const key = realKey();

  // (i) both templates hold the real key
  assert.deepEqual(
    run({ 'a/.env.example': `A=${key}\n`, 'b/.env.example': `B=${key}\n` }),
    {
      code: 0,
      out: [
        'L anon keys verify against the local demo JWT secret (2 checked).',
      ],
      err: [],
    },
  );

  // (ii) swapped signature char, and a service_role key behind a comment line
  const last = key.slice(-1);
  const bad = key.slice(0, -1) + (last === 'A' ? 'B' : 'A');
  const svc = sign({ iss: 'supabase-demo', role: 'service_role' });
  const r = run({
    'a/.env.example': `A=${bad}\n`,
    'b/.env.example': `# A=x\nB=${svc}\n`,
  });
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, []);
  assert.deepEqual(r.err, [
    'L local demo anon key is unusable:\n',
    '  - a/.env.example: A signature does not verify against the local demo JWT secret, so the local stack will reject it with 401 PGRST301.',
    '  - b/.env.example: B has role "service_role", expected "anon". Only the anon key belongs in a committed template.',
    'f1\nf2',
  ]);

  // (iii) missing and two segments
  const m = run({ 'a/.env.example': '# A=x\n', 'b/.env.example': 'B=x.y\n' });
  assert.equal(m.code, 1);
  assert.deepEqual(m.err.slice(1, 3), [
    '  - a/.env.example: A is missing or empty.',
    '  - b/.env.example: B is not a three-segment JWT.',
  ]);
});
