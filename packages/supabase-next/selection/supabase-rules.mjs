/**
 * The Supabase Edge Functions as a selection rule. Any change under `dir` is a full run
 * except a function that has its own area (`areas`: sub-path prefix -> area), which adds only
 * that area. Runs after the triggers, so the shared function config files stay triggers.
 */
export function supabaseFunctions({ dir, areas }) {
  return {
    name: 'supabase-functions',
    stage: 'after-triggers',
    rule(path) {
      if (!path.startsWith(dir)) return null;
      const sub = path.slice(dir.length);
      for (const [prefix, area] of Object.entries(areas))
        if (sub.startsWith(prefix)) return { areas: [area] };
      return { full: 'function' };
    },
  };
}
