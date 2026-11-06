import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  cost,
  format,
  projectDir,
  rebuildCost,
  report,
  requests,
  summarize,
  total,
} from '../../checks/cache-report.mjs';

/** One transcript line for an assistant message. */
function line(id, at, usage, model = 'claude-opus-5-5') {
  return JSON.stringify({
    timestamp: new Date(at).toISOString(),
    message: { id, role: 'assistant', model, usage },
  });
}

const use = (input, write, read, output = 0, w1h = 0) => ({
  input_tokens: input,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  cache_creation: {
    ephemeral_5m_input_tokens: write - w1h,
    ephemeral_1h_input_tokens: w1h,
  },
  output_tokens: output,
});

test('projectDir turns every non-alphanumeric of the cwd into a dash', () => {
  assert.equal(
    projectDir('/home/u/work/demo.project', '/h'),
    '/h/.claude/projects/-home-u-work-demo-project',
  );
});

test('requests keeps one record per message id, with the final output count and the first timestamp', () => {
  const text = [
    line('m1', 1000, use(2, 100, 0, 8)),
    line('m1', 5000, use(2, 100, 0, 900)),
    JSON.stringify({ message: { role: 'user', content: 'x' } }),
    'not json',
    line('m2', 9000, use(1, 10, 100, 5)),
  ].join('\n');
  const reqs = requests(text);
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].usage.output_tokens, 900);
  assert.equal(reqs[0].at, 1000);
});

test('summarize buckets the first write as spawn, small writes as growth, a context rewrite as rebuild', () => {
  const reqs = requests(
    [
      line('a', 0, use(2, 40_000, 0)), // spawn
      line('b', 10_000, use(1, 5_000, 40_000)), // growth
      line('c', 20_000, use(1, 2_000, 45_000)), // growth
      line('d', 627_000, use(1, 47_500, 0)), // cache expired after a 607 s wait
      line('e', 630_000, use(1, 1_000, 47_500)), // growth again
    ].join('\n'),
  );
  const s = summarize(reqs);
  assert.equal(s.spawn, 40_000);
  assert.equal(s.growth, 8_000);
  assert.equal(s.rebuild, 47_500);
  assert.deepEqual(s.rebuilds, [{ tokens: 47_500, gapSec: 607 }]);
  assert.equal(s.read, 132_500);
  assert.equal(s.write5m, 95_500);
});

test('cost prices reads at 0.1, 5-minute writes at 1.25 and 1-hour writes at 2', () => {
  const s = summarize(
    requests([line('a', 0, use(10, 300, 1000, 0, 100))].join('\n')),
  );
  assert.equal(s.write1h, 100);
  assert.equal(s.write5m, 200);
  assert.equal(cost(s), 10 + 200 * 1.25 + 100 * 2 + 1000 * 0.1);
});

test('rebuildCost prices rebuild tokens at the agent write rate and is zero without writes', () => {
  const s = summarize(
    requests(
      [line('a', 0, use(0, 1000, 0)), line('b', 400_000, use(0, 1000, 0))].join(
        '\n',
      ),
    ),
  );
  assert.equal(s.rebuild, 1000);
  assert.equal(rebuildCost(s), 1250);
  assert.equal(rebuildCost(summarize([])), 0);
});

// ---------------------------------------------------------------- report: workflow agents

const tmps = [];
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

/** A session transcript with one plain subagent; returns { dir, session, sub }. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cache-report-'));
  tmps.push(dir);
  const session = join(dir, 's.jsonl');
  writeFileSync(
    session,
    [
      line('a', 0, use(2, 40_000, 0, 5)),
      line('b', 10_000, use(1, 5_000, 40_000, 5)),
    ].join('\n'),
  );
  const sub = join(dir, 's', 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, 'agent-a.jsonl'),
    line('p', 20_000, use(1, 8_000, 0, 3)),
  );
  writeFileSync(
    join(sub, 'agent-a.meta.json'),
    JSON.stringify({ agentType: 'dev-infra', description: 'work' }),
  );
  return { dir, session, sub };
}

test('5-6 report: a plain subagent and a workflow with two agents give four rows, grouped under the wf id', () => {
  const { session, sub } = fixture();
  const wf = join(sub, 'workflows', 'wf_x');
  mkdirSync(wf, { recursive: true });
  // started in the opposite order of their file names, to prove start ordering
  writeFileSync(
    join(wf, 'agent-b.jsonl'),
    line('w2', 40_000, use(1, 6_000, 0, 2)),
  );
  writeFileSync(
    join(wf, 'agent-b.meta.json'),
    JSON.stringify({ agentType: 'verify-finding' }),
  );
  writeFileSync(
    join(wf, 'agent-c.jsonl'),
    line('w1', 30_000, use(1, 7_000, 0, 2)),
  );
  writeFileSync(
    join(wf, 'agent-c.meta.json'),
    JSON.stringify({ agentType: 'reviewer-tests' }),
  );
  writeFileSync(join(wf, 'journal.jsonl'), line('j', 1_000, use(1, 999, 0, 1)));
  const rows = report(session);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.agent),
    [
      'orchestrator (session)',
      'dev-infra: work',
      'wf_x/reviewer-tests',
      'wf_x/verify-finding',
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.workflow),
    [undefined, undefined, 'wf_x', 'wf_x'],
  );
  assert.equal(
    total(rows).requests,
    rows.reduce((n, r) => n + r.requests, 0),
  );
  assert.equal(total(rows).requests, 5);
});

test('5-7 report: a workflow agent without meta.json is labelled by its file basename', () => {
  const { session, sub } = fixture();
  const wf = join(sub, 'workflows', 'wf_x');
  mkdirSync(wf, { recursive: true });
  writeFileSync(
    join(wf, 'agent-d.jsonl'),
    line('w', 30_000, use(1, 7_000, 0, 2)),
  );
  const rows = report(session);
  assert.equal(rows.at(-1).agent, 'wf_x/agent-d');
});

test('5-8 report: without a workflows dir the output equals the base fixture', () => {
  const { session } = fixture();
  // Generated by running tools/cache-report.mjs at cf6201a on this fixture.
  const expected = [
    'cache report: SESSION',
    '',
    'agent                   reqs   hit%  read  write  rebuild  n  max gap  model   ',
    'orchestrator (session)     2  47.1%   40k    45k        0  0        -  opus-5-5',
    'dev-infra: work            1   0.0%     0     8k        0  0        -  opus-5-5',
    '',
    'agents 2, requests 3, hit rate 43.0%',
    'writes 53k: spawn 48k (90.6%), growth 5k (9.4%), rebuild 0 (0.0%) in 0 events',
    'input cost 70k units; rebuilds 0.0% of it',
  ].join('\n');
  assert.equal(format(report(session), 'SESSION'), expected);
});
