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
  ratchet <name> [args] | ratchet --all [--update]
                              run a configured ratchet; --all runs every ratchet with group "check"
  mutate <ID> | --registry (--ids=|--all|--changed) [--dry-run --typecheck --digest --only --file --defer]
                              | --rotate --ledger=<dir> [--budget-min= --batch= --deadline= --sha=]
                              prove a ticket's registry guards bite (needs mutations in gate.config.mjs)
  mutations check [--fix]     validate (and repair) the mutation registry
  mutations select [--affected --paths=]   list the registry entries a diff selects
  select [--test-list | --replay=REV --count=N | --for=FILES | --drift=REPORT | --load-time] | select check
                              pick the e2e specs a diff reaches, or check the spec headers (needs selection in gate.config.mjs)
  score --base=REF [--files= --report= --base-report=]   judge a mutation report (needs score in gate.config.mjs)
  cache-report [<session>|<path.jsonl>] [--json]   price the cache use of a Claude Code session
  docs-stale                  list the docs pages whose sources changed (needs docs in gate.config.mjs)
  <pack command> [args]       a command a pack adds through packCommands`;

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

async function score(args) {
  const { GATE, ROOT } = await import('../project.mjs');
  if (!GATE.score) {
    warn('mutation: FAIL score is not configured: add a score key to gate.config.mjs');
    return 2;
  }
  const { runScore } = await import('../score/cli.mjs');
  return runScore(args, GATE.score, ROOT);
}

async function select(args) {
  const { GATE, ROOT } = await import('../project.mjs');
  if (!GATE.selection) {
    warn('select: FAIL selection is not configured: add a selection key to gate.config.mjs');
    return 2;
  }
  if (args[0] === 'check') {
    const { checkE2eAreas } = await import('../selection/check.mjs');
    const problems = checkE2eAreas(ROOT, GATE.selection);
    if (problems.length > 0) {
      warn(`${problems.join('\n')}\n\nselect check: fix each line above.`);
      return 1;
    }
    say(`select check: ${problems.counts.specs} specs, ${problems.counts.entries} entries ok`);
    return 0;
  }
  const { main } = await import('../selection/cli.mjs');
  return main(args, GATE.selection);
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
  const code = Number.isInteger(result.code) ? result.code : 2;
  (code === 0 ? say : warn)(result.lines.join('\n'));
  if (code !== result.code) warn(`ratchet ${name}: exit 2 (code not an integer)`);
  process.exitCode = code;
  return Number(process.exitCode);
}

/** Run every ratchet with group "check", in config order; resolves to the worst exit code. */
async function ratchetAll(args) {
  const { GATE, ROOT: root } = await import('../project.mjs');
  const list = Object.entries(GATE.ratchets ?? {}).filter(([, e]) => e.group === 'check');
  if (list.length === 0) {
    warn('ratchet --all: no ratchet has group "check"; set group: \'check\' on a ratchet in gate.config.mjs');
    return 2;
  }
  let worst = 0;
  const failed = [];
  for (const [name, entry] of list) {
    let code;
    try {
      const result = await entry.check({
        root,
        args,
        update: args.includes('--update'),
        baseline: entry.baseline ?? null,
      });
      code = Number.isInteger(result.code) ? result.code : 2;
      if (code !== result.code) result.lines = [...(result.lines ?? []), 'exit 2 (code not an integer)'];
      (code === 0 ? say : warn)(result.lines.join('\n'));
      (code === 0 ? say : warn)(`ratchet ${name}: ${code === 0 ? 'ok' : `exit ${code}`}`);
    } catch (e) {
      code = 2;
      warn(`ratchet ${name}: exit 2 (threw: ${e.message})`);
    }
    if (code !== 0) failed.push(name);
    worst = Math.max(worst, code);
  }
  const tail = failed.length > 0 ? `: ${failed.join(', ')}` : '';
  (worst === 0 ? say : warn)(`ratchet --all: ${list.length} ran, ${failed.length} failed${tail}`);
  return worst;
}

async function cacheReport(args) {
  const { ROOT } = await import('../root.mjs');
  const { runCacheReport } = await import('../checks/cache-report.mjs');
  let result;
  try {
    result = runCacheReport({ root: ROOT, args });
  } catch (e) {
    warn(`cache-report: ${e.message}`);
    return 1;
  }
  (result.code === 0 ? say : warn)(result.lines.join('\n'));
  return result.code;
}

async function docsStale(args) {
  const { GATE, ROOT: root } = await import('../project.mjs');
  if (!GATE.docs) {
    warn('docs-stale: FAIL docs is not configured: add docs.stamped to gate.config.mjs');
    return 2;
  }
  const { docsStale: stale } = await import('../checks/docs-stale.mjs');
  const { stamped, ext, exclude } = GATE.docs;
  const result = stale({
    root,
    dirs: stamped,
    ...(ext !== undefined ? { ext } : {}),
    ...(exclude !== undefined ? { exclude } : {}),
  });
  say(result.lines.join('\n'));
  return result.code;
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
  if (cmd === 'score') return score(rest);
  if (cmd === 'select') return select(rest);
  if (cmd === 'hook') return hook(rest[0]);
  if (cmd === 'fu') return fu(rest);
  if (cmd === 'ratchet') return rest[0] === '--all' ? ratchetAll(rest.slice(1)) : ratchet(rest[0], rest.slice(1));
  if (cmd === 'cache-report') return cacheReport(rest);
  if (cmd === 'docs-stale') return docsStale(rest);
  // No gate.config.mjs means no pack commands: fall through to the unknown-command line.
  const { GATE, ROOT: root } = await import('../project.mjs').catch((e) => {
    // Only a missing gate.config.mjs means "no pack commands"; a missing import inside it is the user's error.
    if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !e.url?.endsWith('/gate.config.mjs')) throw e;
    return { GATE: { packCommands: {} }, ROOT: process.cwd() };
  });
  const own = Object.hasOwn(GATE.packCommands, cmd) ? GATE.packCommands[cmd] : undefined;
  if (own) return Number((await own.run(rest, { root, gate: GATE })) ?? 0);
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
