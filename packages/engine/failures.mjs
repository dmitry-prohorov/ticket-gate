// Turns the raw output of the failed steps of the verify command into a short
// Markdown summary at .turbo/ticket-verify-failures.md: which test, file:line and
// message per failure, so a dev agent reads 30 lines instead of a 4000-line log.
// Pure string work (no dependency). The gate calls writeFailures()
// after the receipt is written; a green run deletes the file.
//
// Every recogniser runs over every failed step's output (a `check` step mixes
// prettier, eslint, tsc, vitest, node:test and the check-* tools), so nothing
// here branches on a step id. An output no recogniser matches gets a `tail` entry.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const FAILURES_REL = '.turbo/ticket-verify-failures.md';
export const MAX_ENTRIES = 20;
const MAX_MESSAGE = 240;
const TAIL_LINES = 15;

const ANSI = /\x1b\[[0-9;]*m/g;
const TURBO_PREFIX = /^[\w@/.-]+:[\w:-]+: /;

const stripLine = (l) => l.replace(ANSI, '').replace(TURBO_PREFIX, '');

/** Split, strip ANSI and a leading turbo `pkg:task: ` prefix, trim, drop empty lines. */
export function cleanLines(out) {
  return String(out ?? '')
    .split('\n')
    .map((l) => stripLine(l).trim())
    .filter(Boolean);
}

const cut = (s) =>
  s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 3)}...` : s;

/** `file:///abs/x.mjs:4:1` or `/abs/x.mjs:4:1` becomes a path relative to the cwd. */
function relPath(p) {
  const bare = p.replace(/^file:\/\//, '');
  const cwd = `${process.cwd()}/`;
  return bare.startsWith(cwd) ? bare.slice(cwd.length) : bare;
}

const entry = (kind, name, message, location = null) => ({
  kind,
  name,
  message,
  location,
});

/** First line after `i` (stopping at `stop`) matching `re`; returns the regex match or null. */
function look(lines, i, re, stop, max = 40) {
  for (let j = i + 1; j < lines.length && j <= i + max; j += 1) {
    if (stop(lines[j])) return null;
    const m = re.exec(lines[j]);
    if (m) return m;
  }
  return null;
}

const VITEST_FAIL = /^FAIL\s+(\S+)\s+>\s+(.+)$/;
const VITEST_SUITE_FAIL = /^FAIL\s+(\S+)(?:\s+\[.*\])?$/;
const VITEST_STOP = (l) => /^FAIL\s/.test(l) || l.startsWith('⎯');
const VITEST_MSG = /^((?:\w*Error|expected)\b.*)$/;
const VITEST_LOC = /^❯\s+(?!\S*node_modules)(\S+?:\d+(?::\d+)?)$/;
const SPEC_FAIL = /^✖\s+(.+?)(?:\s+\([\d.]+m?s\))?$/;
const SPEC_STOP = (l) => /^[✔✖ℹ▶]/.test(l);
const TAP_FAIL = /^not ok \d+ - (.+?)(?:\s+#.*)?$/;
const TAP_STOP = (l) => /^(ok|not ok) \d+ - |^# Subtest/.test(l);
const PW_FAIL =
  /^\d+\)\s+\[[^\]]+\]\s+›\s+(\S+?:\d+:\d+)\s+›\s+(.+?)(?:\s+─+)?$/;
const TSC_PAREN = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const TSC_COLON = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/;
const ESLINT_FILE = /^\S+\.[cm]?[jt]sx?$/;
const ESLINT_ROW = /^(\d+):(\d+)\s{2,}error\s{2,}(.+?)(?:\s{2,}([@\w/.-]+))?$/;
const PRETTIER = /^\[warn\]\s+(\S.*)$/;
const CHECK_FAILED = /^check:([\w-]+) FAILED \(\d+\):$/;
const DUP_HEADER =
  /^(?:check:dup: )?(?:\d+ new clone\(s\)|\d+ baseline entr(?:y|ies) (?:no longer match|has an empty|have an empty))/;
const DUP_LINE = /^(NEW|STALE|NO REASON) /;
const COMPILER =
  /^(?:new bailout|stale|skipped|unreasoned): |^plugin .* != baseline/;
const MUTATION = /^mutation: FAIL (.+)$/;

/**
 * Every recogniser over cleanLines(out), in output order, de-duplicated. A
 * Failure is { kind, name, message, location }. Returns [] for a clean log.
 */
export function parseFailures(out) {
  // `lines` keeps the indentation (the check-* tools indent their detail lines);
  // `c` is the same lines trimmed, for everything else.
  const lines = String(out ?? '')
    .split('\n')
    .map((l) => stripLine(l).trimEnd())
    .filter((l) => l.trim());
  const c = lines.map((l) => l.trim());
  const tasks = c.filter((l) => /^Tasks:/.test(l));
  const found = [];
  let file = null; // last eslint file header
  let detail = null; // check:<x> whose indented lines are being collected

  for (let i = 0; i < c.length; i += 1) {
    const line = c[i];
    const indented = /^\s/.test(lines[i]);

    if (detail && indented) {
      found.push(entry('check', detail, line));
      continue;
    }
    detail = null;

    let m;
    if ((m = VITEST_FAIL.exec(line)) || (m = VITEST_SUITE_FAIL.exec(line))) {
      const msg = look(c, i, VITEST_MSG, VITEST_STOP);
      const loc = look(c, i, VITEST_LOC, VITEST_STOP);
      const where = loc ? loc[1] : null;
      found.push(entry('vitest', m[2] ?? m[1], msg ? msg[1] : m[1], where));
    } else if (line.startsWith('✖') && (m = SPEC_FAIL.exec(line))) {
      const name = m[1];
      if (/^failing tests:?$/.test(name) || /^\d+ problems?\b/.test(name))
        continue;
      const msg = look(c, i, /^(\w*Error\b.*|error:.*)$/, SPEC_STOP, 12);
      const before = /^test at (\S+:\d+:\d+)$/.exec(c[i - 1] ?? '');
      const frame = look(c, i, /\((\S+?:\d+:\d+)\)/, SPEC_STOP, 12);
      const where = before
        ? before[1]
        : frame && !/node:|node_modules/.test(frame[1])
          ? relPath(frame[1])
          : null;
      found.push(entry('node-test', name, msg ? msg[1] : name, where));
    } else if ((m = TAP_FAIL.exec(line))) {
      const loc = look(c, i, /^location: '?([^']+)'?$/, TAP_STOP, 30);
      const inline = look(c, i, /^error: (?![|>])'?(.+?)'?$/, TAP_STOP, 30);
      const block = look(c, i, /^error: [|>]-?$/, TAP_STOP, 30);
      const lead = block ? c[c.indexOf(block.input, i) + 1] : null;
      found.push(
        entry(
          'node-test',
          m[1],
          inline ? inline[1] : (lead ?? m[1]),
          loc ? relPath(loc[1]) : null,
        ),
      );
    } else if ((m = PW_FAIL.exec(line))) {
      const msg = look(c, i, /^(Error:.*)$/, (l) => PW_FAIL.test(l), 12);
      found.push(entry('playwright', m[2], msg ? msg[1] : m[2], m[1]));
    } else if ((m = TSC_PAREN.exec(line)) || (m = TSC_COLON.exec(line))) {
      found.push(entry('tsc', m[4], m[5], `${m[1]}:${m[2]}:${m[3]}`));
    } else if (ESLINT_FILE.test(line)) {
      file = line;
    } else if (file && (m = ESLINT_ROW.exec(line))) {
      found.push(
        entry('eslint', m[4] ?? 'eslint', m[3], `${file}:${m[1]}:${m[2]}`),
      );
    } else if ((m = PRETTIER.exec(line)) && !/^Code style issues/.test(m[1])) {
      found.push(entry('prettier', m[1], 'Code style issues found', m[1]));
    } else if ((m = /^Failed:\s+(.+)$/.exec(line))) {
      for (const task of m[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean))
        found.push(entry('turbo', task, tasks.join(' | ')));
    } else if ((m = CHECK_FAILED.exec(line))) {
      detail = `check:${m[1]}`;
    } else if (/^Duplicate export names/.test(line)) {
      found.push(entry('check', 'check:lib-exports', line));
    } else if (
      /^\S+: web=.* mobile=/.test(line) ||
      /^stale allowlist entry/.test(line)
    ) {
      found.push(entry('check', 'check:lib-exports', line));
    } else if (DUP_HEADER.test(line) || DUP_LINE.test(line)) {
      found.push(entry('check', 'check:dup', line));
    } else if (COMPILER.test(line)) {
      const at = /([\w@./[\]()-]+\.[cm]?[jt]sx?:\d+)/.exec(line);
      found.push(entry('check', 'check:compiler', line, at ? at[1] : null));
    } else if ((m = MUTATION.exec(line))) {
      const p = /^(\S+): (.+)$/.exec(m[1]);
      found.push(
        p
          ? entry('mutation', p[1], p[2], p[1])
          : entry('mutation', 'mutation', m[1]),
      );
    }
  }
  return dedupe(found);
}

/** Drops repeats by kind + name + location, and a location-less entry when a located twin exists. */
function dedupe(found) {
  // vitest and node:test print each failure twice; only the second copy has a location.
  const twice = (f) => f.kind === 'vitest' || f.kind === 'node-test';
  const located = new Set(
    found
      .filter((f) => f.location && twice(f))
      .map((f) => `${f.kind}\0${f.name}`),
  );
  const seen = new Set();
  return found.filter((f) => {
    if (!f.location && twice(f) && located.has(`${f.kind}\0${f.name}`))
      return false;
    const key = `${f.kind}\0${f.name}\0${f.location ?? ''}\0${f.kind === 'check' ? f.message : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tailEntry(out) {
  const tail = cleanLines(out).slice(-TAIL_LINES);
  return entry('tail', 'output tail', tail.map(cut).join('\n'));
}

function renderEntry(e) {
  if (e.kind === 'tail')
    return `- [tail] ${e.name} (last ${TAIL_LINES} lines):\n${e.message
      .split('\n')
      .map((l) => `    ${l}`)
      .join('\n')}`;
  const where = e.location ? ` (${e.location})` : '';
  return `- [${e.kind}] ${e.name}: ${cut(e.message)}${where}`;
}

/** The Markdown file body. failures: [{ id, cmd, why, out }] in run order. */
export function renderFailures({ treeHash, ranAt, failures, stoppedBy }) {
  const lines = [
    // prettier-ignore
    stoppedBy ? `# verify:ticket failures - stopped before the stack steps: ${stoppedBy} red` : '# verify:ticket failures',
    '',
    `treeHash: ${treeHash}   ranAt: ${ranAt}`,
  ];
  for (const f of failures) {
    const entries = parseFailures(f.out);
    if (entries.length === 0) entries.push(tailEntry(f.out));
    const shown = entries.slice(0, MAX_ENTRIES);
    lines.push('', `## ${f.id}: \`${f.cmd}\``, `Hint: ${f.why}`);
    for (const e of shown) lines.push(renderEntry(e));
    if (entries.length > MAX_ENTRIES)
      lines.push(
        `- ... and ${entries.length - MAX_ENTRIES} more (full output: the verify:ticket log)`,
      );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Red run: writes the summary and returns `path`. No failed step: deletes any
 * earlier file (it must never be read as current) and returns null.
 */
export function writeFailures(path, { treeHash, ranAt, failures, stoppedBy }) {
  if (failures.length === 0) {
    rmSync(path, { force: true });
    return null;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderFailures({ treeHash, ranAt, failures, stoppedBy }));
  return path;
}
