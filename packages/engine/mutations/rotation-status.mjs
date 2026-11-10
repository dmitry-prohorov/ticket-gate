import { WINDOW_MS, byRanAtDesc } from '../nightly/record.mjs';
import { SEED_CAP, gitText, realGit, short, suspectsFirst } from '../nightly/seed.mjs';

export const ROTATION_WARN_DAYS = 14;

// ------------------------------------------------ mutation rotation

/**
 * Days for the registry to rotate once: ceil(live / perNight), perNight = the
 * mean `ran` over the last 7 days of nights whose phase ran (or errored after
 * running some). null when no such night, or no live count. `live` defaults to
 * the newest history line that carries a mutations record.
 */
export function rotationDays(history, nowMs, live = null) {
  const withPhase = history.filter((r) => r.mutations);
  const total = live ?? withPhase.sort(byRanAtDesc)[0]?.mutations?.live ?? null;
  const nights = withPhase.filter(
    (r) =>
      nowMs - Date.parse(r.ranAt) <= WINDOW_MS &&
      (r.mutations.status === 'ran' ||
        (r.mutations.status === 'error' && r.mutations.ran > 0)),
  );
  if (nights.length === 0 || total === null) return null;
  const perNight =
    nights.reduce((n, r) => n + (r.mutations.ran ?? 0), 0) / nights.length;
  return perNight > 0 ? Math.ceil(total / perNight) : null;
}

const touches = (files, survivor) =>
  files.some((f) => f === survivor.file || f === survivor.testFile);

/** Merges since the survivor's last kill (or the newest 20), suspects first. */
export function mutationSeed({ survivor, sha, git }) {
  const lastKillSha = survivor.lastKillSha ?? null;
  const logArgs = ['log', '--first-parent', '--merges', '--format=%H%x09%s'];
  const out = lastKillSha
    ? gitText(git, ...logArgs, `${lastKillSha}..${sha}`)
    : gitText(git, ...logArgs, '-n', String(SEED_CAP), sha);
  const merges = out
    .split('\n')
    .filter(Boolean)
    .slice(0, lastKillSha ? undefined : SEED_CAP)
    .map((row) => {
      const [msha, ...rest] = row.split('\t');
      const files = gitText(git, 'diff', '--name-only', `${msha}^1`, msha)
        .split('\n')
        .filter(Boolean);
      return {
        sha: msha,
        subject: rest.join('\t'),
        suspect: touches(files, survivor),
      };
    });
  return { key: survivor.key, lastKillSha, merges: suspectsFirst(merges) };
}

/** The mutation lines of the status output; empty when the night has no phase record. */
export function mutationLines(latest, history, nowMs, git = realGit) {
  const m = latest?.mutations;
  if (!m) return [];
  const rot = rotationDays(history, nowMs, m.live ?? null);
  const proof =
    m.oldestProofDays === null || m.oldestProofDays === undefined
      ? 'never'
      : `${m.oldestProofDays} days`;
  let text = `mutations: ${m.killed} killed, ${m.survived} survived, ${m.error} error; oldest proof ${proof}; rotation ${rot === null ? 'n/a' : `${rot} days`}`;
  if (m.unproven > 0) text += ` (${m.unproven} unproven)`;
  if (m.status !== 'ran') text += ` [phase ${m.status}: ${m.reason}]`;
  if (rot !== null && rot > ROTATION_WARN_DAYS)
    text += ` WARN: rotation over ${ROTATION_WARN_DAYS} days; raise FP_NIGHTLY_MUTATION_MIN or take the Move-to-CI trigger`;
  const lines = [text];
  const day = new Date(nowMs).toLocaleDateString('en-CA');
  for (const survivor of m.survivors ?? []) {
    lines.push(`mutation survivor: ${survivor.key} (${survivor.testFile})`);
    try {
      const seed = mutationSeed({ survivor, sha: latest.sha, git });
      lines.push(
        seed.lastKillSha
          ? `fix seed: merges since last kill ${short(seed.lastKillSha)} (suspects first)`
          : `fix seed: no kill on record; the newest ${SEED_CAP} merges (suspects first)`,
      );
      for (const g of seed.merges)
        lines.push(`  ${g.suspect ? '*' : ' '} ${short(g.sha)} ${g.subject}`);
    } catch (e) {
      lines.push(`mutation fix seed unavailable: ${e.message}`);
    }
  }
  if ((m.survivors ?? []).length > 0)
    lines.push(
      `  next: branch fix/mutations-${day} seeded from the lines above`,
    );
  return lines;
}
