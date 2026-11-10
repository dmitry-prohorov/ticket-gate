import { profiler } from './profiler/cli.mjs';

const BUILD_TEXT = ['command', 'unmangle', 'start', 'noBuildLabel'];

/** Binds the profiler to one project's config; see the README. */
export function profile(cfg) {
  if (cfg.lock !== false && (typeof cfg.lock !== 'string' || cfg.lock === ''))
    throw new TypeError('profile: lock must be a stack lock owner or false');
  if (
    BUILD_TEXT.some((k) => typeof cfg.build?.[k] !== 'string') ||
    !Number.isInteger(cfg.build?.port)
  )
    throw new TypeError(
      `profile: build needs ${BUILD_TEXT.join(', ')} and an integer port`,
    );
  return profiler(cfg);
}

/** A Vite app aliases react-dom/client to react-dom/profiling and sets esbuild.keepNames itself; a wrong build is caught by the trace guards. */
export const viteProfiling = ({ cmd, preview }) => ({
  command: cmd,
  unmangle: 'esbuild.keepNames in the Vite config',
  start: preview,
  port: 4173,
  noBuildLabel: 'unknown (existing server on :4173)',
});
export { reactProfile } from './profiler/nightly.mjs';
