const ANSI = /\x1b\[[0-9;]*m/g;
const VITEST_NO_FILES = /^No test files found, exiting with code \d+$/m;
const JEST_NO_TESTS = /^No tests found, exiting with code \d+$/m;
const count = (line, word) =>
  Number(line.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
const lastMatch = (text, re) => [...text.matchAll(re)].at(-1);

const PW_NO_TESTS = /^Error: No tests found\.?$/m;
// prettier-ignore
const PW_NO_SERVER = /Process from config\.webServer (?:was not able to start|exited early)|Timed out waiting \d+ms from config\.webServer/;

// Playwright: the last block of "  <n> passed|failed|flaky|skipped|did not run|interrupted" lines.
function playwrightSummary(text) {
  const re =
    /^ {2}(\d+) (passed|failed|flaky|skipped|did not run|interrupted)\b.*$/;
  let block = [];
  let prev = false;
  for (const l of text.split('\n')) {
    const m = l.match(re);
    if (/^ {4}/.test(l)) continue; // a failed test's header sits inside the block
    if (m) {
      if (!prev) block = [];
      block.push({ n: Number(m[1]), kind: m[2], line: l.trim() });
      prev = true;
    } else prev = false;
  }
  if (!block.length) return null;
  const ran = block
    .filter((b) => b.kind !== 'skipped' && b.kind !== 'did not run')
    .reduce((a, b) => a + b.n, 0);
  return { line: block.map((b) => b.line).join(', '), ran };
}

function vitestSummary(text) {
  const m = lastMatch(text, /^ +(Tests {2}(.+))$/gm);
  if (!m) return null;
  return {
    line: m[1].trim(),
    passed: count(m[2], 'passed'),
    failed: count(m[2], 'failed'),
    filesFailed: /^ +Test Files {2}.*\bfailed\b/m.test(text),
  };
}

function jestSummary(text) {
  const m = lastMatch(text, /^(Tests: +(.+))$/gm);
  if (!m) return null;
  return {
    line: m[1].trim(),
    passed: count(m[2], 'passed'),
    failed: count(m[2], 'failed'),
    suitesFailed: /^Test Suites:.*\bfailed\b/m.test(text),
  };
}

// node --test: the last summary block (spec "ℹ tests N" or TAP "# tests N").
// With process isolation a filter that matched nothing reports one passing
// "test" named after the file; those top-level file-only passes do not count.
function nodeSummary(text, cmd) {
  const block = { tests: null, pass: 0, fail: 0, cancelled: 0 };
  let line = null;
  for (const m of text.matchAll(
    /^[ℹ#] (tests|pass|fail|cancelled) (\d+)\s*$/gm,
  )) {
    if (m[1] === 'tests') {
      Object.assign(block, { pass: 0, fail: 0, cancelled: 0 });
      line = m[0].trim();
    }
    block[m[1]] = Number(m[2]);
  }
  if (line === null) return null;
  const tokens = new Set(
    cmd.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, '')),
  );
  let fileOnly = 0;
  for (const m of text.matchAll(
    /^(?:✔ (.+?) \(\d+(?:\.\d+)?ms\)|ok \d+ - (.+?))\s*$/gm,
  ))
    if (tokens.has(m[1] ?? m[2])) fileOnly++;
  return { ...block, line: line.replace(/^[ℹ#] /, ''), fileOnly };
}

/**
 * Did this test output run zero tests? A reason string ('<runner>: <summary>')
 * or null. Positive per runner; output with no recognised summary (shell
 * `true`, grep, playwright) is null and classified by exit code. A run that
 * reports a failure is never zero: a load failure is a kill. `extra` holds the
 * harness parsers (cmd, out) -> reason | null, tried after the built-in ones.
 */
// prettier-ignore
export function zeroTestRun(cmd, out, extra = []) {
  out = String(out ?? '');
  const text = out.replace(ANSI, '');
  // A failing node --test run can echo other runners' summaries in an assertion diff.
  const n = nodeSummary(text, cmd);
  if (n && n.fail + n.cancelled > 0) return null;
  if (VITEST_NO_FILES.test(text)) return 'vitest: No test files found';
  const v = vitestSummary(text);
  if (v && v.passed + v.failed === 0 && !v.filesFailed) return `vitest: ${v.line}`;
  if (JEST_NO_TESTS.test(text)) return 'jest: No tests found';
  const j = jestSummary(text);
  if (j && j.passed + j.failed === 0 && !j.suitesFailed) return `jest: ${j.line}`;
  if (n && n.pass - n.fileOnly <= 0 && n.fail + n.cancelled === 0) return `node --test: ${n.line}`;
  if (PW_NO_TESTS.test(text)) return 'playwright: No tests found';
  if (PW_NO_SERVER.test(text)) return 'playwright: webServer did not start';
  const pw = playwrightSummary(text);
  if (pw && pw.ran === 0) return `playwright: ${pw.line}`;
  const extraHit = extra.map((z) => z(cmd, out)).find((r) => r != null);
  return extraHit ?? null;
}

function zeroResult(m, why, when) {
  const fix =
    when === 'before the mutation'
      ? 'fix the "test" filter or path; it selects nothing'
      : 'neither killed nor survived; check the filter';
  return {
    id: m.id,
    status: 'error',
    detail: `ran zero tests ${when} (${why}): ${fix}`,
  };
}

/** Per-child limits in seconds (R10): a child past its limit is an `error`, never a kill. */
export const LIMITS = {
  run: 900,
  reset: 300,
  build: 300,
  sql: 120,
  probe: 10,
  webBuild: 600,
  serve: 120,
};

function timedOutResult(m, t) {
  return {
    id: m.id,
    status: 'error',
    detail: `TIMEOUT after ${t.limitS ?? LIMITS.run} s: ${m.test}`,
  };
}

// Killed, survived, or (zero tests ran) error; zero is checked before the exit code.
function verdict(m, t, extra = []) {
  if (t.timedOut === true) return timedOutResult(m, t);
  const zero = zeroTestRun(m.test, t.out, extra);
  if (zero) return zeroResult(m, zero, 'under the mutation');
  return t.code !== 0
    ? { id: m.id, status: 'killed', detail: tail(t.out) }
    : {
        id: m.id,
        status: 'survived',
        detail: `the test still passes with the guard removed (${m.protects ?? m.id}): it does not bite; strengthen the test, then re-run`,
      };
}

const tail = (out) => out.trim().split('\n').slice(-5).join('\n');

export { tail, verdict, zeroResult };
