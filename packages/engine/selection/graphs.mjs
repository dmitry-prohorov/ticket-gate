/**
 * The union of graph sources. One source with no `expand` behaves exactly as that
 * source. Dependency-free Node ESM.
 */
export function unionGraph(sources, root, cfg) {
  const graphs = sources.map((s) => s.graph(root, cfg));
  return {
    get unresolved() {
      for (const g of graphs) if (g.unresolved) return g.unresolved;
      return null;
    },
    reach(path) {
      const areas = new Set();
      const specs = new Set();
      const merge = (r) => {
        for (const a of r.areas) areas.add(a);
        for (const s of r.specs) specs.add(s);
      };
      const paths = [path, ...graphs.flatMap((g) => g.expand?.(path) ?? [])];
      for (const g of graphs) for (const p of paths) merge(g.reach(p));
      return { areas, specs };
    },
    expand: (path) => graphs.flatMap((g) => g.expand?.(path) ?? []),
    evaluates: (path) => graphs.some((g) => g.evaluates?.(path) ?? false),
    evaluationSet: () =>
      [...new Set(graphs.flatMap((g) => g.evaluationSet?.() ?? []))].sort(),
    newlyEvaluatedLoadTime(changed, readBase) {
      const out = new Set();
      for (const g of graphs)
        for (const p of g.newlyEvaluatedLoadTime?.(changed, readBase) ?? [])
          out.add(p);
      return out;
    },
    importersOf: (file) => [
      ...new Set(graphs.flatMap((g) => g.importersOf?.(file) ?? [])),
    ],
  };
}
