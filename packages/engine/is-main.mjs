// Entry-point guard that survives a symlinked install. pnpm and `.bin` run a module through a
// symlink: process.argv[1] is the link, import.meta.url is the real path, so comparing the two as
// URLs never matches and the script silently does nothing. Compare real paths instead.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True when `url` (an import.meta.url) is the script this process is running. */
export function isMain(url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}
