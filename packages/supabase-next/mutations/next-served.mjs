// The next-served harness: `served(opts)` plus the type
// check that reports a patch which can never pass `next build` before the
// clean build, and the `--typecheck` CLI hooks.
import { ROOT } from '#engine/root.mjs';
import { served } from '#engine/mutations/served.mjs';
import {
  tsChecker,
  typecheckMain,
  typecheckPatches,
  typecheckSummary,
} from './next-typecheck.mjs';

export function nextServed(opts) {
  const base = served({ name: 'next-served', order: 1, ...opts });
  return {
    ...base,
    ioMethods: (h) => ({
      ...base.ioMethods(h),
      typecheck: (patches) => typecheckPatches(patches, tsChecker(ROOT)),
    }),
    precheck: async (entries, io) =>
      io.typecheck ? await io.typecheck(entries) : new Map(),
    typecheck: { main: typecheckMain, summary: typecheckSummary },
  };
}
