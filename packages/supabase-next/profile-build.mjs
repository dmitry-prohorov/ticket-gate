const NEXT = 'npx --no-install next';

/** The profiling build of a Next.js app in the `app` directory. */
export const nextProfiling = ({ app }) => ({
  command: `cd ${app} && ${NEXT} build --profile --no-mangling`,
  unmangle: '--no-mangling',
  start: `cd ${app} && ${NEXT} start`,
  port: 3000,
  noBuildLabel: 'unknown (existing server on :3000)',
});
