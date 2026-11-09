import { execFileSync } from 'node:child_process';

import { byRanAtDesc } from './record.mjs';

export const SEED_CAP = 20;

/**
 * R8: suspect = the merge's files select the full suite or one of the red specs.
 * The caller injects e2e-select's exports (this file must not import it: it
 * imports walkReport from here). Falls back to the interim rule on a throw.
 */
export function selectionSelects({
  select,
  buildGraph,
  root,
  interim = () => false,
}) {
  let graph = null;
  return (files, redSpecs) => {
    try {
      graph ??= buildGraph(root);
      const s = select({ root, changed: files, graph });
      return s.mode === 'full' || s.specs.some((f) => redSpecs.includes(f));
    } catch {
      return interim(files, redSpecs);
    }
  };
}

export const gitText = (git, ...args) => String(git(...args) ?? '').trim();

export function suspectsFirst(merges) {
  const suspects = merges.filter((m) => m.suspect);
  const others = merges.filter((m) => !m.suspect);
  return [...suspects, ...others];
}

/** Merges since the last green sha (or the newest 20), suspects first. */
export function fixSeed({ latest, history, git, selects = () => false }) {
  const lastGreen = history
    .filter((r) => r.status === 'green')
    .sort(byRanAtDesc)[0];
  const lastGreenSha = lastGreen?.sha ?? null;
  const redSpecs = latest.redSpecs ?? [];
  const logArgs = ['log', '--first-parent', '--merges', '--format=%H%x09%s'];
  const out = lastGreenSha
    ? gitText(git, ...logArgs, `${lastGreenSha}..${latest.sha}`)
    : gitText(git, ...logArgs, '-n', String(SEED_CAP), latest.sha);
  const merges = out
    .split('\n')
    .filter(Boolean)
    .slice(0, lastGreenSha ? undefined : SEED_CAP)
    .map((row) => {
      const [sha, ...rest] = row.split('\t');
      const files = gitText(git, 'diff', '--name-only', `${sha}^1`, sha)
        .split('\n')
        .filter(Boolean);
      return {
        sha,
        subject: rest.join('\t'),
        suspect: selects(files, redSpecs),
      };
    });
  return {
    redSpecs,
    redTests: latest.redTests ?? [],
    lastGreenSha,
    merges: suspectsFirst(merges),
  };
}

export const short = (sha) => String(sha ?? '').slice(0, 12);

export const realGit = (...args) =>
  execFileSync('git', args.flat(), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
