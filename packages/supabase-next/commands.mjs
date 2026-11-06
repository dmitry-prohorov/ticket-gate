// The commands the supabase-next pack adds to the engine CLI through packCommands. A command
// exists only when its option is given to supabaseNext; the check modules load on first use.
const isText = (v) => typeof v === 'string' && v !== '';

const PREFLIGHT_KEYS = [
  ['webEnv', 'file'],
  ['webEnv', 'missing'],
  ['anonKey', 'file'],
  ['anonKey', 'name'],
];

export const DB_SCHEMA_DEFAULTS = Object.freeze({
  out: 'supabase/schema',
  tool: 'ticket-gate db-schema',
  name: 'db-schema',
  usage: 'usage: ticket-gate db-schema [--dump=PATH] [--cron=PATH] [--out=DIR]',
  start: 'supabase start',
  reset: 'supabase db reset',
});

/** `{ [name]: (args, { root, gate }) => Promise<number> }` for the options that were given. */
export function packCommandsFor({ stackPreflight: preflight, dbSchema: schema } = {}) {
  const commands = {};
  if (preflight !== undefined) {
    if (!PREFLIGHT_KEYS.every(([k, f]) => isText(preflight[k]?.[f])))
      throw new TypeError(
        'supabase-next: stackPreflight needs webEnv { file, missing } and anonKey { file, name }',
      );
    commands['stack-preflight'] = async (args, { root, gate }) => {
      const { stackPreflight } = await import('./checks/stack-preflight.mjs');
      const services = gate.stacks?.supabase?.services ?? {};
      return stackPreflight({
        usage: `usage: ticket-gate stack-preflight --steps=<${Object.keys(services).join(',')}> [--wait=<sec>]`,
        ...preflight,
        services,
        root,
      }).main(args);
    };
  }
  if (schema !== undefined) {
    if (!isText(schema.header))
      throw new TypeError(
        'supabase-next: dbSchema needs header, the first line of every generated file',
      );
    commands['db-schema'] = async (args, { root }) => {
      const { dbSchema } = await import('./checks/db-schema.mjs');
      const r = dbSchema({ ...DB_SCHEMA_DEFAULTS, ...schema, root }).run(args);
      for (const l of r.out) console.log(l);
      for (const l of r.err) console.error(l);
      return r.code;
    };
  }
  return commands;
}
