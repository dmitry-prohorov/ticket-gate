# @ticket-gate/react

The React Compiler bailout ratchet for `@ticket-gate/engine`. `compiler.mjs` exports `reactCompiler(options)`, which runs
`babel-plugin-react-compiler` over the `.ts` and `.tsx` files of the configured scan directories and compares what the compiler
could not compile with a baseline file. A new bailout, a skipped component or hook, or a stale baseline entry fails the check.

Every project value (scan directories, exclude pattern, where `@babel/core` and the plugin resolve from, baseline path, message
texts) is an option. The package has no runtime dependency beyond the engine: `@babel/core` and `babel-plugin-react-compiler` are
resolved from the consuming project at call time.

## Profiling a React app

`ticket-gate profile` counts what React renders during one scripted action. It reads React's own performance tracks from a Chrome
trace: Scheduler (Render and Commit) and Components (one entry per component that rendered). It measures React DOM apps; LWC is not
covered.

```
ticket-gate profile [--build] [--runs=N] [--scenarios=] [--out=] [--compare=] [--max-renders=]
```

The command is added by `reactPack({ profile })`, where `profile` is a function returning the config below; the config is loaded only
when the command runs. `viteProfiling({ cmd, preview })` describes the build and the preview server of a Vite app, which must alias
`react-dom/client` to `react-dom/profiling` and set `esbuild.keepNames` in its own Vite config; a wrong build is caught by the trace
guards, which fail the run with the fix instead of printing zeros. For Next.js use
`{ ...nextProfiling({ app: 'web' }) }` from `@ticket-gate/supabase-next/profile-build.mjs`, and the Supabase reset and login hooks
from `@ticket-gate/supabase-next/profile-hooks.mjs`. `lock: false` skips the stack lock for a caller that already holds it. Playwright
comes from the project (`playwrightFrom` names the `package.json` that depends on it), never from this package, so it must be installed in the project at `playwrightFrom`.

`profile.config.mjs`:

```js
import { viteProfiling } from '@ticket-gate/react/profile.mjs';

const root = new URL('.', import.meta.url).pathname;

export default {
  root,
  command: 'ticket-gate profile',
  lock: 'profile:web',
  scenarios: { home: async () => async () => {} },
  writing: [],
  componentsFor: () => ['Card', 'List'],
  usage: { maxRenders: 'home:<n>' },
  out: `${root}profile-out`,
  tracePrefix: 'web-',
  context: { viewport: { width: 1280, height: 800 } },
  open: async () => {},
  reset: async () => {},
  playwrightFrom: `${root}package.json`,
  appUrl: 'http://localhost:4173',
  build: viteProfiling({ cmd: 'npm run build', preview: 'npm run preview' }),
  messages: { expected: 'Card, List' },
  preflight: { portInUse: 'port 4173 is in use', noApp: 'nothing on :4173: run with --build', noWebEnv: 'no app env' },
  services: [],
  probe: (url) => fetch(url).then(() => true, () => false),
  hasEnv: () => true,
};
```

`gate.config.mjs`:

```js
import { defineGate } from '@ticket-gate/engine';
import { reactPack } from '@ticket-gate/react/index.mjs';

export default defineGate({
  steps: [],
  packs: [reactPack({ profile: async () => (await import('./profile.config.mjs')).default })],
});
```

## Profiling every night

`reactProfile` from `@ticket-gate/react/profile.mjs` is a nightly suite runner. Put it in `nightly.suites` after the end-to-end suite, and give the suite entry `keep: runner.keep`, which is how the engine learns how many nights of traces to keep. `config` is the profile config module above, as a path relative to the worktree. Its `budgets` key is `{ [scenario]: { max, blocking? } }`, the largest median of component renders a scenario may have.

A scenario over its budget makes the night amber until its entry says `blocking: true`; then the night is red and `ticket-gate nightly status` names the merges since the last green night. A run that leaves no numbers (the build failed, the trace guards fired, the child died) is red. A run cut short at `limitS` is printed as `red (cut-short)`. A scenario that stayed within its budget, and within 10% of itself, for seven nights gets a hint to promote it to `blocking: true`. Results are kept every night and traces for the newest `keepTraces` nights. The runner takes no stack lock because the nightly already holds it; it profiles in a child process so that `limitS` can stop it.

```js
import { reactProfile } from '@ticket-gate/react/profile.mjs';

const runner = reactProfile({
  config: 'profile.config.mjs',
  runs: 1,
  scenarios: 'all',
  keepTraces: 3,
});

export const suite = { name: 'profile', runner, limitS: 2700, keep: runner.keep };
```
