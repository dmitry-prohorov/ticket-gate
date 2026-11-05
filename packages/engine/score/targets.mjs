// Which changed paths the score gate mutates. Pure: the project's scope, extra
// and excluded patterns arrive in `cfg`.

/**
 * The module a test file stands for: `foo.test.ts` or `foo.<case>.test.ts` -> the
 * longest existing `foo[.<case>].ts` beside it; null for anything else.
 */
export function testedModule(path, exists) {
  const m = /^(.*\/)([^/]+?)\.test\.ts$/.exec(path);
  if (!m) return null;
  const parts = m[2].split('.');
  for (let n = parts.length; n >= 1; n--) {
    const p = `${m[1]}${parts.slice(0, n).join('.')}.ts`;
    if (exists(p)) return p;
  }
  return null;
}

/**
 * Changed paths that the gate mutates, sorted; deleted files drop out. A changed
 * (or deleted) test file selects the module beside it, so a weakened test is judged
 * by the regressed-mutant rule even when the module itself did not change.
 * `cfg` carries `scope` (RegExp), `extra` (paths) and `excluded` (RegExp).
 */
export function mutationTargets(paths, exists, cfg) {
  return [...new Set(paths)]
    .map((p) => testedModule(p, exists) ?? p)
    .filter((p) => p.endsWith('.ts'))
    .filter((p) => cfg.scope.test(p) || cfg.extra.includes(p))
    .filter((p) => !cfg.excluded.test(p))
    .filter((p) => exists(p))
    .filter((p, i, all) => all.indexOf(p) === i)
    .sort();
}
