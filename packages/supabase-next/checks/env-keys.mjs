// Asserts that the local demo anon key committed in apps/*/.env.example is a
// JWT the local Supabase stack will actually accept.
//
// Why this exists: docs/setup.md tells every new developer to `cp
// apps/web/.env.example apps/web/.env.local`. A single corrupted character in
// that key does not fail loudly - GoTrue's unauthenticated endpoints still
// answer 200, so sign-in appears to work and the first PostgREST call then
// returns 401 PGRST301 as an opaque data error. One such typo ("supabane-demo"
// for "supabase-demo", signature unchanged) shipped in both templates and cost
// a review round to find.
//
// It runs offline and always: no Docker, no running stack, no network, no
// dependency. `supabase status -o json` is the source of truth for the value,
// but a gate that needs the stack up would be skipped exactly when it matters,
// and a gate that no-ops when the stack is down is worse than none - it reads
// as coverage. Instead this verifies the HMAC directly against the demo JWT
// secret that every `supabase start` stack signs with, which is a published
// constant, not a secret.
//
// Pure: returns { code, out, err } and never prints or exits; a project binds the templates, the
// label and the fix text in its own CLI.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The default local JWT secret of every `supabase start` stack. Published by
// Supabase, identical on every machine, and worthless against any hosted
// project. It is not a secret (AGENTS.md hard rule 7 is about real keys).
const LOCAL_DEMO_JWT_SECRET =
  'super-secret-jwt-token-with-at-least-32-characters-long';

const EXPECTED_ISS = 'supabase-demo';

/** Reads `NAME=value` from a dotenv-style file, ignoring comments. */
function readVar(root, file, name) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== name) continue;
    return trimmed.slice(eq + 1).trim();
  }
  return null;
}

function signatureIsValid(header, payload, signature) {
  const expected = createHmac('sha256', LOCAL_DEMO_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {{ root: string, targets: { file: string, name: string }[], label: string, fix: string[] }} cfg
 * @returns {{ code: 0 | 1, out: string[], err: string[] }}
 */
export function checkEnvExampleKeys({ root, targets, label, fix }) {
  const problems = [];

  for (const { file, name } of targets) {
    const value = readVar(root, file, name);
    if (!value) {
      problems.push(`${file}: ${name} is missing or empty.`);
      continue;
    }

    const parts = value.split('.');
    if (parts.length !== 3) {
      problems.push(`${file}: ${name} is not a three-segment JWT.`);
      continue;
    }
    const [header, payload, signature] = parts;

    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      problems.push(`${file}: ${name} payload is not base64url JSON.`);
      continue;
    }

    if (claims.iss !== EXPECTED_ISS) {
      problems.push(
        `${file}: ${name} has iss "${claims.iss}", expected "${EXPECTED_ISS}".`,
      );
    }
    if (claims.role !== 'anon') {
      problems.push(
        `${file}: ${name} has role "${claims.role}", expected "anon". Only the anon key belongs in a committed template.`,
      );
    }
    if (!signatureIsValid(header, payload, signature)) {
      problems.push(
        `${file}: ${name} signature does not verify against the local demo JWT secret, so the local stack will reject it with 401 PGRST301.`,
      );
    }
  }

  if (problems.length) {
    return {
      code: 1,
      out: [],
      err: [
        `${label} local demo anon key is unusable:\n`,
        ...problems.map((p) => `  - ${p}`),
        fix.join('\n'),
      ],
    };
  }
  return {
    code: 0,
    out: [
      `${label} anon keys verify against the local demo JWT secret (${targets.length} checked).`,
    ],
    err: [],
  };
}
