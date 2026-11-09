import { readdirSync } from 'node:fs';

import { isAlive, lockPath } from '../lock.mjs';
import { NIGHTLY_DEFAULTS } from './define.mjs';
import { FORCED_MAX, forcedShare, readE2eRuns } from './e2e-runs.mjs';
import {
  H,
  REACHED,
  WINDOW_MS,
  freshness,
  nightlyDir,
  readNightly,
  suiteView,
} from './record.mjs';
import { mutationLines } from '../mutations/rotation-status.mjs';
import { SEED_CAP, fixSeed, realGit, short } from './seed.mjs';

const DEFAULT_CFG = {
  ...NIGHTLY_DEFAULTS,
  suites: [{ name: '' }],
};

const localDay = (ms) => new Date(ms).toLocaleDateString('en-CA');

/** The two "Move to CI" triggers over the last 7 days (N-R5). */
export function moveToCi({
  history,
  nowMs,
  queued,
  suite = null,
  e2eRuns = [],
}) {
  const recent = history.filter(
    (r) => nowMs - Date.parse(r.ranAt) <= WINDOW_MS,
  );
  // a top-level skipped-busy night counts for every suite
  const busyOf = (r) =>
    r.status === 'skipped-busy' || suiteView(r, suite)?.reason === 'cut-short';
  const maxWallMs = Math.max(
    0,
    ...recent
      .map((r) => suiteView(r, suite))
      .filter(Boolean)
      .filter(REACHED)
      .map((v) => (suite === null ? (v.firstMs ?? v.ms) : v.ms) ?? 0),
  );
  const busy = new Set(
    recent.filter(busyOf).map((r) => localDay(Date.parse(r.ranAt))),
  );
  const busyNights = busy.size;
  const { share, totalMs } = forcedShare(e2eRuns, nowMs);
  return {
    t1: {
      maxWallMs,
      busyNights,
      met: maxWallMs > 4 * H || busyNights >= 2,
    },
    t2: {
      forcedShare: share,
      totalMs,
      queued,
      met: queued >= 3 || (share !== null && share > FORCED_MAX),
    },
  };
}

function headline(latest, fresh, cfg) {
  if (!latest) return `no nightly runs on record (${cfg.commands.run} --now)`;
  const s = latest.stats;
  const counts = s
    ? ` ${s.expected} passed, ${s.unexpected} failed, ${s.flaky} flaky`
    : '';
  let text = `${latest.status} ${short(latest.sha)} ${latest.ranAt}${counts}`;
  if (latest.reason) text += ` reason ${latest.reason}`;
  if (latest.status === 'red' && latest.redSpecs?.length)
    text += ` specs ${latest.redSpecs.join(', ')}`;
  if (latest.status === 'amber' && latest.flakySpecs?.length)
    text += ` flaky ${latest.flakySpecs.join(', ')}`;
  if (fresh === null) text += ' [no run has reached Playwright]';
  else if (fresh.stale)
    text += ` [STALE: last full run ${Math.round(fresh.ageMs / H)} h ago]`;
  return text;
}

function seedLines(seed) {
  const out = [];
  for (const t of seed.redTests)
    out.push(
      `  red: ${t.file} > ${t.title} [${t.project}]: ${String(t.error).split('\n')[0]}`,
    );
  out.push(
    seed.lastGreenSha
      ? `fix seed: merges since last green ${short(seed.lastGreenSha)} (suspects first)`
      : `fix seed: no green run on record; the newest ${SEED_CAP} merges (suspects first)`,
  );
  for (const m of seed.merges)
    out.push(`  ${m.suspect ? '*' : ' '} ${short(m.sha)} ${m.subject}`);
  out.push('  next: branch fix/nightly-<date> seeded from the lines above');
  return out;
}

/** Lines to print; [0] is the one-line status. */
export function statusLines(
  { latest, history, queued, e2eRuns = [] },
  nowMs,
  git = realGit,
  selects = undefined,
  cfg = DEFAULT_CFG,
) {
  selects ??= cfg.selects.interim;
  const fresh = freshness(history, nowMs);
  const lines = [headline(latest, fresh, cfg)];
  for (const suite of cfg.suites.slice(1)) {
    const view = latest ? suiteView(latest, suite.name) : null;
    if (view) lines.push(suite.runner.statusLine(view));
  }
  for (const d of latest?.drift ?? [])
    lines.push(
      `  drift: ${d.file} visited ${d.pathname} (${d.area}) not in its header`,
    );
  if (latest?.status === 'red') {
    try {
      lines.push(...seedLines(fixSeed({ latest, history, git, selects })));
    } catch (e) {
      lines.push(`fix seed unavailable: ${e.message}`);
    }
  }
  const m = moveToCi({ history, nowMs, queued, e2eRuns });
  const t1Line = (t1, label) =>
    `move-to-ci 1${label}: max wall ${(t1.maxWallMs / H).toFixed(1)} h, busy nights ${t1.busyNights} of last 7 (${t1.met ? 'MET' : 'not met'}; move at over 4 h or 2 nights)`;
  lines.push(t1Line(m.t1, ''));
  for (const suite of cfg.suites.slice(1))
    lines.push(
      t1Line(
        moveToCi({ history, nowMs, queued, e2eRuns, suite: suite.name }).t1,
        ` (${suite.name})`,
      ),
    );
  const share2 =
    m.t2.forcedShare === null
      ? 'n/a (no gate e2e runs in 14 days)'
      : `${Math.round(m.t2.forcedShare * 100)}% of ${(m.t2.totalMs / H).toFixed(1)} h in 14 days`;
  lines.push(
    `move-to-ci 2: forced-full share ${share2}, queued branches ${m.t2.queued} (${m.t2.met ? 'MET' : 'not met'}; move at over 25% or 3 or more)`,
  );
  lines.push(...mutationLines(latest, history, nowMs, git));
  return lines;
}

/** Live waiting gates: <lock>.waiters/<pid>.json whose pid is alive. */
export function queuedCount() {
  try {
    const dir = `${lockPath()}.waiters`;
    return readdirSync(dir).filter((f) => isAlive(Number.parseInt(f, 10)))
      .length;
  } catch {
    return 0;
  }
}

const EXIT = { green: 0, amber: 0, red: 1 };

export async function main(argv, cfg) {
  if (argv.length > 0) {
    console.error(
      `nightly:status takes no arguments (got ${argv.join(' ')}). Run: ${cfg.commands.status}`,
    );
    return 2;
  }
  const { latest, history } = readNightly(nightlyDir());
  const selects =
    latest?.status === 'red'
      ? ((await cfg.selects.load?.()) ?? undefined)
      : undefined;
  for (const l of statusLines(
    {
      latest,
      history,
      queued: queuedCount(),
      e2eRuns: readE2eRuns(nightlyDir()),
    },
    Date.now(),
    undefined,
    selects,
    cfg,
  ))
    console.log(l);
  return latest ? (EXIT[latest.status] ?? 3) : 3;
}
