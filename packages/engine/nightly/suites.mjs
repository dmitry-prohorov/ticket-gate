// The Playwright suite as a runner (the block that lived in run.mjs).
import { summarizeReport } from '../runners/playwright.mjs';

/** playwrightSuite({ cmd }) -> runner: `cmd` + the suite's args + a json reporter, run in the worktree. */
export function playwrightSuite({ cmd }) {
  return {
    name: 'playwright',
    async run({ wt, io, args = [], limitS, env = {}, out }) {
      io.rm(out);
      const pw = await io.run(
        cmd[0],
        [...cmd.slice(1), ...args, '--reporter=json,list'],
        {
          cwd: wt,
          env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: out },
          limitS,
        },
      );
      let raw = null;
      if (io.exists(out)) {
        try {
          raw = JSON.parse(io.readFile(out));
        } catch {
          raw = null;
        }
        io.rm(out);
      }
      if (pw.timedOut) return { timedOut: true, summary: null, report: null };
      const summary = raw === null ? null : summarizeReport(raw);
      const report =
        summary === null
          ? null
          : {
              playwright: raw,
              // [{ file, pathnames }]: what each spec visited (the navigation recorder)
              navigation: Object.entries(summary.navigation).map(
                ([file, pathnames]) => ({ file, pathnames }),
              ),
            };
      return { timedOut: false, summary, report };
    },
  };
}
