// A nightly suite runner for node:test specs. The engine calls `run(...)` once per night in the
// nightly worktree and stores the summary in the nightly record; `ticket-gate nightly status` reads it.
import { spawnSync } from 'node:child_process';

export function nodeTestSuite({ glob }) {
  return {
    run: async ({ wt, limitS }) => {
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', glob], {
        cwd: wt,
        encoding: 'utf8',
        timeout: limitS * 1000,
      });
      const count = (key) => Number(new RegExp(`^# ${key} (\\d+)$`, 'm').exec(r.stdout ?? '')?.[1] ?? 0);
      const failedSpecs = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      return {
        timedOut: r.error?.code === 'ETIMEDOUT',
        summary: {
          stats: { expected: count('pass'), unexpected: count('fail'), flaky: 0, skipped: count('skipped') },
          flakySpecs: [],
          failedSpecs,
          redTests: failedSpecs,
          navigation: {},
        },
        report: null,
      };
    },
  };
}
