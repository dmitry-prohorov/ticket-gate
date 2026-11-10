import { posix } from 'node:path';

/**
 * A workspace package as a resolver: `name` -> `${dir}/src/index.ts`, `name/sub` through the
 * package.json exports map (dist/ mirrors src/), else the same path under src/.
 * @param {string} name package name, e.g. '@scope/pkg'
 * @param {string} dir package directory relative to the repo root
 */
export function workspaceExports(name, dir) {
  const src = `${dir}/src`;
  // One exports map per graph (ctx), not per process: config.mjs builds this resolver once.
  const maps = new WeakMap();
  const target = (sub, ctx) => {
    if (!maps.has(ctx)) {
      let exp = {};
      try {
        exp = JSON.parse(ctx.readText(`${dir}/package.json`)).exports ?? {};
      } catch {
        exp = {};
      }
      maps.set(ctx, exp);
    }
    const e = maps.get(ctx)[`./${sub}`];
    const t = typeof e === 'string' ? e : (e?.types ?? e?.import);
    const m =
      typeof t === 'string' ? /^\.\/dist\/(.+?)(\.d\.ts|\.js)$/.exec(t) : null;
    return m ? m[1] : null;
  };
  return {
    name: `workspace ${name}`,
    resolve(spec, _from, ctx) {
      if (spec === name) {
        const file = posix.join(src, 'index.ts');
        return ctx.exists(file) ? { file } : { unresolved: true };
      }
      if (!spec.startsWith(`${name}/`)) return null;
      const sub = spec.slice(name.length + 1);
      const mapped = target(sub, ctx);
      let out = ctx.viaTs(`./${mapped ?? sub}`, `${src}/_.ts`);
      if (!out && mapped) out = ctx.viaTs(`./${sub}`, `${src}/_.ts`);
      return out ?? { unresolved: true };
    },
  };
}
