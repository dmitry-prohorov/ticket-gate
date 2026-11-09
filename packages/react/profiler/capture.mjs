// Browser capture for the React profiler: context, DevTools hook stub, trace.
import { createRequire } from 'node:module';

export const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'blink.user_timing',
];

/** Loads Playwright's chromium from the package.json that depends on it. */
export function resolveChromium(playwrightFrom) {
  const require = createRequire(playwrightFrom);
  return require('@playwright/test').chromium;
}

/** A fresh context with the stub hook, and its first page. The caller signs in. */
export async function openContext(browser, context) {
  const ctx = await browser.newContext(context);
  // React sets ProfileMode on the root, and so writes the Components track, only when a
  // DevTools hook exists. A disabled stub turns that on without injecting a backend.
  await ctx.addInitScript(() => {
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { isDisabled: true };
  });
  const page = await ctx.newPage();
  return { context: ctx, page };
}

/** Traces `act` into `file`. */
export async function captureRun(browser, page, act, file) {
  await browser.startTracing(page, {
    path: file,
    categories: TRACE_CATEGORIES,
  });
  await act();
  await browser.stopTracing();
}
