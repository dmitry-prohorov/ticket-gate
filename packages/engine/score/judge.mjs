// Scores and verdicts of the mutation score gate. Pure: the rule thresholds
// arrive in `cfg`.

const KILLED = new Set(['Killed', 'Timeout']);
const OPEN = new Set(['Survived', 'NoCoverage']);

/**
 * Head mutants on unchanged lines that the base killed and the branch does not: a
 * test was removed or weakened. A mutant is matched by its location (mapped from
 * base to head), mutator and replacement; counts are compared per key, so a key the
 * base already left open is not a regression. A changed line never matches: `toHead`
 * maps untouched base lines only onto untouched head lines.
 */
export function regressedMutants(baseMutants, headMutants, toHead) {
  const keyOf = (m, start, end) =>
    `${start}:${m.location.start.column}-${end}:${m.location.end.column}/${m.mutatorName}/${m.replacement}`;
  const base = new Map();
  for (const m of baseMutants) {
    const start = toHead(m.location.start.line);
    const end = toHead(m.location.end.line);
    if (start === null || end === null) continue;
    const k = keyOf(m, start, end);
    const c = base.get(k) ?? { killed: 0, open: 0 };
    if (KILLED.has(m.status)) c.killed++;
    else if (OPEN.has(m.status)) c.open++;
    base.set(k, c);
  }
  const headOpen = new Map();
  for (const m of headMutants) {
    if (!OPEN.has(m.status)) continue;
    const k = keyOf(m, m.location.start.line, m.location.end.line);
    headOpen.set(k, [...(headOpen.get(k) ?? []), m]);
  }
  const out = [];
  for (const [k, list] of headOpen) {
    const c = base.get(k);
    if (!c) continue;
    const n = Math.min(c.killed, Math.max(0, list.length - c.open));
    out.push(...list.slice(0, n));
  }
  return out;
}

/** Killed + Timeout over Killed + Timeout + Survived + NoCoverage. */
export function scoreFile(mutants) {
  const c = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0 };
  for (const m of mutants) if (m.status in c) c[m.status]++;
  const killed = c.Killed + c.Timeout;
  const valid = killed + c.Survived + c.NoCoverage;
  const score = valid === 0 ? 100 : Math.round((10000 * killed) / valid) / 100;
  return {
    killed,
    survived: c.Survived,
    noCoverage: c.NoCoverage,
    valid,
    score,
  };
}

/** Failure reasons for one file; empty means pass. `cfg.newFileMin` is the floor for a new file. */
export function judge(v, cfg) {
  const reasons = [];
  if (v.isNew && v.score < cfg.newFileMin)
    reasons.push(`new file score ${v.score.toFixed(2)} < ${cfg.newFileMin}`);
  // An existing file fails only on a mutant that survives on a line this branch
  // changed. A whole-file score below base is a warning (see `warnings`): it can
  // come from lines nobody touched, and the nightly rotation re-checks them.
  if (!v.isNew && (v.survivedOnChanged ?? 0) > 0)
    reasons.push(`${v.survivedOnChanged} surviving mutant(s) on changed lines`);
  if (!v.isNew && v.noCoverageOnChanged > 0)
    reasons.push(
      `${v.noCoverageOnChanged} no-coverage mutant(s) on changed lines`,
    );
  if (!v.isNew && (v.regressed?.length ?? 0) > 0)
    reasons.push(
      `${v.regressed.length} mutant(s) killed on base now survive on unchanged lines (a test was removed or weakened)`,
    );
  return reasons;
}

/**
 * Non-failing notes for one file: the whole-file score fell below base with no
 * regressed mutant (a killed base mutant on a line the branch removed, say).
 */
export function warnings(v) {
  const out = [];
  if (!v.isNew && v.score < v.baseScore && !(v.regressed?.length ?? 0))
    out.push(
      `score ${v.score.toFixed(2)} dropped below base ${v.baseScore} (whole file; not a failure, no mutant killed on base survives)`,
    );
  return out;
}

/** True when a regressed mutant should be confirmed by a run without the incremental cache. */
export function needsForcedRerun(verdicts, ranStryker) {
  return ranStryker && verdicts.some((v) => (v.regressed?.length ?? 0) > 0);
}

export function summaryLine(verdicts) {
  const scores = verdicts.map((v) => v.score);
  const min = scores.length ? Math.min(...scores) : 100;
  const max = scores.length ? Math.max(...scores) : 100;
  const n = verdicts.reduce((a, v) => a + v.survivorsOnChanged, 0);
  const g = verdicts.reduce((a, v) => a + (v.regressed?.length ?? 0), 0);
  const w = verdicts.reduce((a, v) => a + (v.warnings?.length ?? 0), 0);
  return `mutation: ${verdicts.length} files, score ${min.toFixed(1)}..${max.toFixed(1)}, ${n} survivors on changed lines${g ? `, ${g} regressed on unchanged lines` : ''}${w ? `, ${w} warning(s): whole-file score below base` : ''}`;
}
