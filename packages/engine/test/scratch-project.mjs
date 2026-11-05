// Test helper (not a test): plan.mjs and review-map.mjs top-level-await load gate.config.mjs
// from the working directory. A test that only needs the planner functions (every config is
// passed in) chdirs into a throwaway project with a synthetic config first, then imports them
// lazily, so it runs in any checkout of the engine, with or without a config of its own.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONFIG_URL = pathToFileURL(
  join(import.meta.dirname, "..", "config.mjs"),
).href;

const DEFAULT_CONFIG = `import { defineGate, step } from '${CONFIG_URL}';
export default defineGate({ steps: [step({ id: 'a', when: true, cmd: 'x', reuse: false })] });
`;

/**
 * chdir into a temp project holding gate.config.mjs (`config` is its source; the default is one
 * step); returns its cleanup.
 */
export function enterScratchProject(config = DEFAULT_CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), "gate-scratch-"));
  writeFileSync(join(dir, "gate.config.mjs"), config);
  process.chdir(dir);
  return () => {
    process.chdir(tmpdir());
    rmSync(dir, { recursive: true, force: true });
  };
}
