// CR-* and DS-*: the cache-report and docs-stale commands of the bin. Every case spawns the bin.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { defineGate } from '../config.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(GATE, 'bin', 'ticket-gate.mjs');
const CONFIG_URL = pathToFileURL(join(GATE, 'config.mjs')).href;
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const scratch = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gate-cc-')));
  dirs.push(dir);
  return dir;
};
const bin = (cwd, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

const usage = (input, write, read, output) => ({
  input_tokens: input,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  cache_creation: {
    ephemeral_5m_input_tokens: write,
    ephemeral_1h_input_tokens: 0,
  },
  output_tokens: output,
});
const requestLine = (id, at, u) =>
  JSON.stringify({
    timestamp: new Date(at).toISOString(),
    message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: u },
  });

test('CR-1 ticket-gate cache-report <path.jsonl> --json prints the report of that transcript', () => {
  const dir = scratch();
  const file = join(dir, 's.jsonl');
  writeFileSync(
    file,
    [
      requestLine('a', 0, usage(2, 40_000, 0, 5)),
      requestLine('b', 10_000, usage(1, 5_000, 40_000, 5)),
    ].join('\n'),
  );
  const r = bin(dir, 'cache-report', file, '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.session, file);
  assert.ok(out.rows.length >= 1);
  assert.ok(out.total);
});

test('CR-2 cache-report on a missing transcript exits 1 with the no-transcript line on stderr', () => {
  const dir = scratch();
  const file = join(dir, 'missing.jsonl');
  const r = bin(dir, 'cache-report', file);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `cache-report: no transcript at ${file}\n`);
  assert.equal(r.stdout, '');
});

const withDocs = (body) => {
  const dir = scratch();
  writeFileSync(
    join(dir, 'gate.config.mjs'),
    `import { defineGate } from ${JSON.stringify(CONFIG_URL)};\nexport default defineGate({ steps: [], ${body} });\n`,
  );
  return dir;
};

test('DS-2 docs-stale without docs exits 2 with the not-configured line', () => {
  const dir = withDocs('');
  const r = bin(dir, 'docs-stale');
  assert.equal(r.status, 2);
  assert.equal(
    r.stderr,
    'docs-stale: FAIL docs is not configured: add docs.stamped to gate.config.mjs\n',
  );
  assert.equal(r.stdout, '');
});

test('DS-3 docs.stamped empty or not strings is a config error; a stamped dir prints the docsStale lines', () => {
  for (const stamped of [[], 'g', [1], ['']])
    assert.throws(
      () => defineGate({ steps: [], docs: { stamped } }),
      /gate\.config: docs\.stamped: must be a non-empty array of directory paths/,
    );
  assert.throws(() => defineGate({ steps: [], docs: { dirs: ['g'] } }), /gate\.config: docs:/);
  assert.throws(
    () => defineGate({ steps: [], docs: { stamped: ['g'], ext: 1 } }),
    /gate\.config: docs\.ext: must be a string/,
  );

  const dir = withDocs("docs: { stamped: ['g'] }");
  mkdirSync(join(dir, 'g'));
  writeFileSync(join(dir, 'g', 'p.html'), '<p>no stamp</p>\n');
  writeFileSync(join(dir, 'g', 'index.html'), '<p>skipped</p>\n');
  const r = bin(dir, 'docs-stale');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    'p.html: no guide-sources / checked-at stamp\n\n1 of 1 pages to review\n',
  );
});
