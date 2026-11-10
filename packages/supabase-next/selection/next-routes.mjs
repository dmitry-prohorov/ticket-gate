import { listFiles } from '#engine/graph/js.mjs';

// ---------------------------------------------------------------- graph root and check

/** @param {string} relToApp path relative to the app dir; '*' = shell entry, null = orphan */
export function routeAreaIn(table, relToApp) {
  let best = null;
  for (const [prefix, area] of table) {
    if (!relToApp.startsWith(prefix)) continue;
    if (best === null || prefix.length > best[0].length) best = [prefix, area];
  }
  return best ? best[1] : null;
}

/**
 * The Next app router as a graph Root and a Check: entries() maps each route file to its area,
 * run() reports an unmapped route (orphan) and counts the entries.
 */
export function nextAppRoutes({ appDir, entryRe, routeAreas }) {
  const routes = (root) =>
    listFiles(root, appDir, (p) =>
      entryRe.test(p.slice(appDir.length + 1)),
    ).map((file) => ({
      file,
      area: routeAreaIn(routeAreas, file.slice(appDir.length + 1)),
    }));
  return {
    name: 'next-routes',
    entries: (root) => routes(root).filter((e) => e.area !== null),
    run(root) {
      const all = routes(root);
      return {
        problems: all
          .filter((e) => e.area === null)
          .map((e) => `orphan-route ${e.file.slice(appDir.length + 1)}`),
        entries: all.length,
      };
    },
  };
}
