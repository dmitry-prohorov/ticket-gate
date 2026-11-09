// Chrome trace reduction for the React profiler. No project literal: the
// component names and the build hints come from the caller.

/**
 * Reduces a Chrome trace to the render numbers. `traceEvents` (or a bare array) of
 * `TimeStamp` events whose `args.data` carries React's track, message and start/end (us).
 */
export function analyse(trace, names) {
  const events = (Array.isArray(trace) ? trace : trace.traceEvents)
    .filter((e) => e.name === 'TimeStamp' && e.args?.data)
    .map((e) => e.args.data);
  const ms = (d) => (d.end - d.start) / 1000;
  const sched = events
    .filter((d) => d.trackGroup === 'Scheduler ⚛' && d.end > d.start)
    .sort((a, b) => a.start - b.start);
  const commits = sched.filter((d) => d.message === 'Commit');
  const renders = sched.filter((d) => d.message === 'Render');
  // A commit's cost: itself plus every Render on its lane since that lane's previous commit.
  const lastCommitEnd = {};
  let slowest = 0;
  for (const c of commits) {
    const since = lastCommitEnd[c.track] ?? -Infinity;
    const own = renders.filter(
      (r) => r.track === c.track && r.start >= since && r.end <= c.start + 1,
    );
    slowest = Math.max(slowest, ms(c) + own.reduce((s, r) => s + ms(r), 0));
    lastCommitEnd[c.track] = c.end;
  }
  const renderMs = renders.reduce((s, r) => s + ms(r), 0);
  const commitMs = commits.reduce((s, c) => s + ms(c), 0);
  // Effect entries use the `secondary*` colours; renders use `primary*` / `tertiary*`.
  const rendered = events.filter(
    (d) =>
      d.track === 'Components ⚛' && !String(d.color).startsWith('secondary'),
  );
  const counts = Object.fromEntries(
    names.map((name) => [
      name,
      rendered.filter((d) =>
        new RegExp(`(^|\\()${name}(\\)|$)`).test(d.message),
      ).length,
    ]),
  );
  return {
    commits: commits.length,
    totalRenderMs: round(renderMs + commitMs),
    renderMs: round(renderMs),
    commitMs: round(commitMs),
    slowestCommitMs: round(slowest),
    ...counts,
    componentRendersAll: rendered.length,
  };
}

export const round = (n) => Math.round(n * 10) / 10;

/** The three guard messages. `build` is { command, unmangle }, `messages` is { expected }. */
export const problemHints = ({ build, messages }) => ({
  noCommit: `no React Commit in the trace: not a profiling build. Build with \`${build.command}\`, or run with --build.`,
  noHook:
    'Commits but no Components track: the __REACT_DEVTOOLS_GLOBAL_HOOK__ stub was not installed before React loaded.',
  mangled: `the Components track has none of the expected component names (${messages.expected}): component names are mangled. Build with ${build.unmangle}, or run with --build.`,
});

/** r = analyse(...). Returns one hints value, or null for a usable trace. */
export function traceProblem(r, names, hints) {
  if (r.commits === 0) return hints.noCommit;
  if (r.componentRendersAll === 0) return hints.noHook;
  if (names.every((name) => r[name] === 0)) return hints.mangled;
  return null;
}

/** analyse + guard: throws the guard message so the run exits 1 instead of printing zeros. */
export function reduceRun(trace, names, hints) {
  const result = analyse(trace, names);
  const problem = traceProblem(result, names, hints);
  if (problem !== null) throw new Error(problem);
  return result;
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : round((s[mid - 1] + s[mid]) / 2);
}
