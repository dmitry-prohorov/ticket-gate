// The project modules this pack calls, injected by supabaseNext({ tools }) in index.mjs
// (gate.config.mjs passes them). The pack imports nothing outside tools/gate/ and node:.
// Keys: nightly, checkMutations, mutationSelect, mutateCheck, e2eAreas (module
// namespaces, or any object with the same named exports) and e2eSelect (an async
// function resolving to that module: it imports typescript, so it loads lazily).
let bound = null;

export function bindTools(tools) {
  bound = tools;
}

export const tools = new Proxy(
  {},
  {
    get(_, key) {
      if (!bound)
        throw new Error(
          'supabase-next: no project tools bound. Construct the pack first: supabaseNext({ tools }) in gate.config.mjs.',
        );
      return bound[key];
    },
  },
);
