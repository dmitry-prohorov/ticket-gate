#!/usr/bin/env node
// Prompt-cache usage for one Claude Code session and every subagent it spawned,
// read from the transcripts Claude Code writes under ~/.claude/projects/<slug>/.
//
//   cache-report                  latest session of this repo
//   cache-report <session-id>     that session
//   cache-report <path.jsonl>     a transcript anywhere
//   add --json for machine-readable output
//
// Every cache write is put in one of three buckets:
//   spawn    the first request of an agent (system prompt, agent definition, task);
//   growth   the turn's new messages appended to an already-cached prefix;
//   rebuild  a request that read back less than half of the previous request's
//            context, so it rewrote it: the cache expired (subagents get a
//            5-minute TTL) or the prefix changed. That is the waste worth chasing.
// Cost is in input-token units, priced relative to an uncached input token:
// a cache read is 0.1, a 5-minute write 1.25, a 1-hour write 2.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const WEIGHT = { uncached: 1, write5m: 1.25, write1h: 2, read: 0.1 };
const REBUILD_SHARE = 0.5;

/** ~/.claude/projects/<slug> for a working directory: every non-alphanumeric becomes `-`. */
export function projectDir(cwd = process.cwd(), home = homedir()) {
  return join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Path of the most recently modified top-level session transcript in a project dir. */
export function latestSession(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f));
  if (!files.length) throw new Error(`no session transcripts in ${dir}`);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/**
 * Collapse a transcript into one usage record per API request. Streaming logs
 * the same message id several times with a growing output count; the last copy
 * holds the final usage, the first copy the time the request was answered.
 */
export function requests(text) {
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec.message;
    if (msg?.role !== 'assistant' || !msg.usage) continue;
    const id = msg.id ?? rec.uuid;
    const prev = byId.get(id);
    byId.set(id, {
      at: prev?.at ?? Date.parse(rec.timestamp),
      model: msg.model,
      usage: msg.usage,
    });
  }
  return [...byId.values()];
}

/** Token totals, write buckets and rebuild events for one agent's requests. */
export function summarize(reqs) {
  const s = {
    requests: reqs.length,
    uncached: 0,
    write5m: 0,
    write1h: 0,
    read: 0,
    output: 0,
    spawn: 0,
    growth: 0,
    rebuild: 0,
    rebuilds: [],
    models: new Set(),
  };
  let prevContext = 0;
  let prevAt = NaN;
  reqs.forEach((r, i) => {
    const u = r.usage;
    const write = u.cache_creation_input_tokens ?? 0;
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    s.uncached += u.input_tokens ?? 0;
    s.write1h += w1h;
    s.write5m += write - w1h;
    s.read += u.cache_read_input_tokens ?? 0;
    s.output += u.output_tokens ?? 0;
    if (r.model && r.model !== '<synthetic>') s.models.add(r.model);
    if (i === 0) s.spawn += write;
    else if ((u.cache_read_input_tokens ?? 0) < REBUILD_SHARE * prevContext) {
      s.rebuild += write;
      s.rebuilds.push({
        tokens: write,
        gapSec: Math.round((r.at - prevAt) / 1000),
      });
    } else s.growth += write;
    prevContext =
      (u.input_tokens ?? 0) + write + (u.cache_read_input_tokens ?? 0);
    prevAt = r.at;
  });
  return s;
}

/** Input cost of a summary, in uncached-input-token units. */
export function cost(s) {
  return (
    s.uncached * WEIGHT.uncached +
    s.write5m * WEIGHT.write5m +
    s.write1h * WEIGHT.write1h +
    s.read * WEIGHT.read
  );
}

/** Cost of the rebuild writes alone, priced at the TTL each agent wrote at. */
export function rebuildCost(s) {
  const writes = s.write5m + s.write1h;
  if (!writes) return 0;
  const rate =
    (s.write5m * WEIGHT.write5m + s.write1h * WEIGHT.write1h) / writes;
  return s.rebuild * rate;
}

function label(file) {
  const meta = file.replace(/\.jsonl$/, '.meta.json');
  if (existsSync(meta)) {
    try {
      const m = JSON.parse(readFileSync(meta, 'utf8'));
      return [m.agentType, m.description].filter(Boolean).join(': ');
    } catch {
      // fall through to the file name
    }
  }
  return basename(file, '.jsonl');
}

/** Every `subagents/workflows/<wfId>/agent-*.jsonl` (a review-round run's agents). */
function workflowAgents(subDir) {
  const root = join(subDir, 'workflows');
  if (!existsSync(root)) return [];
  const out = [];
  for (const workflow of readdirSync(root).sort()) {
    const dir = join(root, workflow);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort())
      if (/^agent-.*\.jsonl$/.test(f))
        out.push({ file: join(dir, f), workflow });
  }
  return out;
}

/**
 * One row per transcript: the session itself, each subagent in start order,
 * then each workflow run's agents grouped under its wf id (groups by earliest
 * start, rows within a group by start).
 */
export function report(sessionFile) {
  const files = [sessionFile];
  const sub = join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  if (existsSync(sub))
    for (const f of readdirSync(sub))
      if (f.endsWith('.jsonl')) files.push(join(sub, f));
  const rows = [];
  for (const file of files) {
    const reqs = requests(readFileSync(file, 'utf8'));
    if (!reqs.length) continue;
    const s = summarize(reqs);
    rows.push({
      agent: file === sessionFile ? 'orchestrator (session)' : label(file),
      start: reqs[0].at,
      ...s,
    });
  }
  const [head, ...rest] = rows;
  const ordered = head
    ? [head, ...rest.sort((a, b) => a.start - b.start)]
    : rest;
  const wfFiles = workflowAgents(sub);
  const groups = new Map();
  for (const { file, workflow } of wfFiles) {
    const reqs = requests(readFileSync(file, 'utf8'));
    if (!reqs.length) continue;
    const row = {
      agent: `${workflow}/${label(file)}`,
      workflow,
      start: reqs[0].at,
      ...summarize(reqs),
    };
    groups.set(workflow, [...(groups.get(workflow) ?? []), row]);
  }
  const sorted = [...groups.values()]
    .map((g) => g.sort((a, b) => a.start - b.start))
    .sort((a, b) => a[0].start - b[0].start);
  return [...ordered, ...sorted.flat()];
}

const KEYS = [
  'requests',
  'uncached',
  'write5m',
  'write1h',
  'read',
  'output',
  'spawn',
  'growth',
  'rebuild',
];

export function total(rows) {
  const t = Object.fromEntries(KEYS.map((k) => [k, 0]));
  t.rebuilds = [];
  t.costUnits = 0;
  t.rebuildUnits = 0;
  for (const r of rows) {
    for (const k of KEYS) t[k] += r[k];
    t.rebuilds.push(...r.rebuilds);
    t.costUnits += cost(r);
    t.rebuildUnits += rebuildCost(r);
  }
  return t;
}

const k = (n) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(n);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');

export function format(rows, sessionFile) {
  const out = [`cache report: ${sessionFile}`, ''];
  const head = [
    'agent',
    'reqs',
    'hit%',
    'read',
    'write',
    'rebuild',
    'n',
    'max gap',
    'model',
  ];
  const lines = rows.map((r) => {
    const input = r.uncached + r.write5m + r.write1h + r.read;
    const maxGap = r.rebuilds.reduce((m, e) => Math.max(m, e.gapSec), 0);
    return [
      r.agent.slice(0, 40),
      String(r.requests),
      pct(r.read, input),
      k(r.read),
      k(r.write5m + r.write1h),
      k(r.rebuild),
      String(r.rebuilds.length),
      maxGap ? `${maxGap}s` : '-',
      [...r.models].map((m) => m.replace(/^claude-/, '')).join(','),
    ];
  });
  const width = head.map((h, i) =>
    Math.max(h.length, ...lines.map((l) => l[i].length)),
  );
  const row = (cells) =>
    cells
      .map((c, i) =>
        i === 0 || i === 8 ? c.padEnd(width[i]) : c.padStart(width[i]),
      )
      .join('  ');
  out.push(row(head), ...lines.map(row), '');
  const t = total(rows);
  const writes = t.write5m + t.write1h;
  out.push(
    `agents ${rows.length}, requests ${t.requests}, hit rate ${pct(t.read, t.uncached + writes + t.read)}`,
    `writes ${k(writes)}: spawn ${k(t.spawn)} (${pct(t.spawn, writes)}), growth ${k(t.growth)} (${pct(t.growth, writes)}), rebuild ${k(t.rebuild)} (${pct(t.rebuild, writes)}) in ${t.rebuilds.length} events`,
    `input cost ${k(Math.round(t.costUnits))} units; rebuilds ${pct(t.rebuildUnits, t.costUnits)} of it`,
  );
  return out.join('\n');
}

/**
 * The report for the CLI arguments: { code, lines }. code 0 prints lines to stdout, code 1 (no
 * transcript) one line to stderr. The caller sets the exit code; this never exits.
 */
export function runCacheReport({ root, args }) {
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));
  const dir = projectDir(root);
  const file = !target
    ? latestSession(dir)
    : target.endsWith('.jsonl')
      ? target
      : join(dir, `${target}.jsonl`);
  if (!existsSync(file))
    return { code: 1, lines: [`cache-report: no transcript at ${file}`] };
  const rows = report(file);
  if (json) {
    const plain = rows.map((r) => ({ ...r, models: [...r.models] }));
    return {
      code: 0,
      lines: [
        JSON.stringify(
          { session: file, rows: plain, total: total(rows) },
          null,
          2,
        ),
      ],
    };
  }
  return { code: 0, lines: [format(rows, file)] };
}
