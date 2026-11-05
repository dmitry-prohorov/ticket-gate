#!/usr/bin/env node
// The engine CLI: one entry for every gate command. Commands load the project's gate.config.mjs
// (found by walking up from the working directory) only when they need it, so `--help` and the
// hook spawn work anywhere.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../is-main.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = ['stop', 'pre-tool-use'];
const USAGE = `usage: ticket-gate <command> [args]
  verify [flags]              run the steps the diff requires
  hook stop|pre-tool-use      run a hook (stdin and exit code pass through)
  review-map [--base=REF] [--full]
  move-check [--base=REF]     prove a move-only diff (exit 1 while lines are unmatched)
  fu list|show|next|close|check [args]
  ratchet <name> [args]       run a configured ratchet (--update where it has one)
  mutate <ID> | --registry (--ids=|--all|--changed) [--dry-run --typecheck --digest --only --file --defer]
                              | --rotate --ledger=<dir> [--budget-min= --batch= --deadline= --sha=]
                              prove a ticket's registry guards bite (needs mutations in gate.config.mjs)
  mutations check [--fix]     validate (and repair) the mutation registry
  mutations select [--affected --paths=]   list the registry entries a diff selects`;

const say = (s) => console.log(s);
const warn = (s) => console.error(s);

function hook(event) {
  if (!HOOKS.includes(event)) {
    warn(
      `ticket-gate: hook takes ${HOOKS.join(' or ')}, got ${event}\n${USAGE}`,
    );
    return 2;
  }
  const child = join(HERE, '..', 'hooks', `${event}.mjs`);
  const r = spawnSync(process.execPath, [child], { stdio: 'inherit' });
  return r.status ?? 1;
}

async function fu(args) {
  const { GATE, ROOT } = await import('../project.mjs');
  const { commandsOf } = await import('../config.mjs');
  const fuCmd = commandsOf(GATE).fu;
  const cfg = GATE.followUps;
  if (!cfg) {
    warn('fu: followUps.dir is not configured');
    return 2;
  }
  const fuLib = await import('../fu.mjs');
  if (args[0] === 'check')
    return fuLib.runCheck(ROOT, cfg, { out: say, err: warn, fuCmd });
  return fuLib.run(args, {
    dir: join(ROOT, cfg.dir),
    label: cfg.dir,
    fuCmd,
    out: say,
    err: warn,
  });
}

async function mutation(cmd, args) {
  const { GATE } = await import('../project.mjs');
  const { runMutationCommand } = await import('../mutations/gate.mjs');
  return runMutationCommand(cmd, args, GATE, { out: say, err: warn });
}

async function ratchet(name, args) {
  const { GATE, ROOT: root } = await import('../project.mjs');
  const entry = GATE.ratchets?.[name];
  if (!entry) {
    warn(
      `ratchet: unknown ${name ?? '(no name)'}; configured: ${Object.keys(GATE.ratchets ?? {}).join(', ') || 'none'}`,
    );
    return 2;
  }
  const baseline = entry.baseline ?? null;
  const result = await entry.check({
    root,
    args,
    update: args.includes('--update'),
    baseline,
  });
  (result.code === 0 ? say : warn)(result.lines.join('\n'));
  process.exitCode = result.code;
  return Number(process.exitCode);
}

/** Dispatch `argv` (without node and the script); resolves to the exit code. */
export async function run(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h') return (say(USAGE), 0);
  if (cmd === undefined) return (say(USAGE), 2);
  if (cmd === 'verify') {
    await (await import('../cli.mjs')).main(rest);
    return 0;
  }
  if (cmd === 'review-map') {
    (await import('../review-map.mjs')).main(rest);
    return 0;
  }
  if (cmd === 'move-check') {
    const { main } = await import('../move-proof.mjs');
    const { commandsOf } = await import('../config.mjs');
    const { GATE } = await import('../project.mjs');
    main({ moveCheck: commandsOf(GATE).moveCheck, args: rest });
    return 0;
  }
  if (cmd === 'mutate') return mutation('mutate', rest);
  if (cmd === 'mutations') {
    const sub = rest[0];
    if (sub !== 'check' && sub !== 'select') {
      warn(`ticket-gate: mutations takes check or select, got ${sub ?? '(nothing)'}\n${USAGE}`);
      return 2;
    }
    return mutation(`mutations ${sub}`, rest.slice(1));
  }
  if (cmd === 'hook') return hook(rest[0]);
  if (cmd === 'fu') return fu(rest);
  if (cmd === 'ratchet') return ratchet(rest[0], rest.slice(1));
  warn(`ticket-gate: unknown command ${cmd}\n${USAGE}`);
  return 2;
}

/** Run `cmd` with this process's arguments when `url` is the script being executed. */
export async function runAs(url, cmd) {
  if (!isMain(url)) return;
  process.exitCode = await run([cmd, ...process.argv.slice(2)]);
}

if (isMain(import.meta.url))
  process.exitCode = await run(process.argv.slice(2));
