import { execFileSync, spawnSync } from 'node:child_process';
import { firstError } from './summary.mjs';
import { registryHooks } from './mutations/gate.mjs';
import { commandsOf } from './config.mjs';
import { GATE } from './project.mjs';
import { ROOT } from './root.mjs';

const precheckIo = {
  run(cmd) {
    const r = spawnSync('bash', ['-c', cmd], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  },
  log: (line) => console.log(line),
  branch: () =>
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim(),
  registry: () => registryHooks(GATE)?.entries?.() ?? new Map(),
  baseRegistry: (base) => registryHooks(GATE)?.entriesAt?.(base) ?? new Map(),
};

/** `--ticket=ID` from an argv, else undefined. */
const ticketArg = (argv) =>
  argv.find((a) => a.startsWith('--ticket='))?.slice('--ticket='.length) ||
  undefined;

/**
 * `ticket-gate verify --precheck`: the checks that most often turn a green wave
 * red, in about two minutes, without a stack. Writes nothing under .turbo/ and
 * is never a gate result. Returns the exit code.
 */
export async function runPrecheck(
  { base, ticket = ticketArg(process.argv.slice(2)) },
  io = precheckIo,
) {
  const started = Date.now();
  const live = (reg) =>
    new Set(
      [...reg.entries()]
        .filter(([, v]) => !v.entry?.retired)
        .map(([k]) => k.split('/')[0]),
    );
  let baseKeys = new Set();
  try {
    baseKeys = new Set(io.baseRegistry(base).keys());
  } catch {
    baseKeys = new Set();
  }
  const reg = io.registry();
  const added = [...reg.keys()]
    .filter((k) => !baseKeys.has(k))
    .map((k) => k.split('/')[0]);
  const fromBranch =
    registryHooks(GATE)?.ticketFromBranch?.(io.branch()) ?? null;
  const known = live(reg);
  const ids = [
    ...new Set(
      ticket ? [ticket] : [...(fromBranch ? [fromBranch] : []), ...added],
    ),
  ].filter((id) => known.has(id));
  const named = ticket ?? fromBranch ?? ids[0] ?? '<ID>';
  const ctx = { base, ids, named };
  const checks = GATE.precheck.flatMap((c) =>
    (typeof c === 'function' ? c(ctx) : [c]).map((e) => ({
      id: e.id,
      cmd: typeof e.cmd === 'function' ? e.cmd({ base }) : e.cmd,
      fix: e.fix.replace('<ID>', named),
    })),
  );
  const failed = [];
  for (const c of checks) {
    const r = io.run(c.cmd);
    if (r.code === 0) {
      io.log(`precheck ${c.id}: ok`);
    } else {
      failed.push(c.id);
      io.log(`precheck ${c.id}: FAIL ${firstError(r.out)}. Fix: ${c.fix}`);
    }
  }
  const secs = Math.round((Date.now() - started) / 1000);
  io.log(
    `precheck: ${checks.length - failed.length} ok, ${failed.length} failed (${secs}s). Not a gate result: run ${commandsOf(GATE).verify}.`,
  );
  return failed.length > 0 ? 1 : 0;
}
