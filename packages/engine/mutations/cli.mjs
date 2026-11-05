import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { safeKillGroup } from '../kill-group.mjs';
import { takeOrExit } from '../lock.mjs';
import { ROOT } from '../root.mjs';
import { baseRef, treeEntries, treeHash } from '../tree.mjs';
import { inFlight, realIo } from './exec.mjs';
import { projectSetup } from './project.mjs';
import { rotateMain } from './rotate.mjs';
import {
  addArea,
  compareKeys,
  entriesDigest,
  entriesFor,
  loadRegistry,
  ticketTreeHash,
  toSpec,
} from './registry.mjs';
import {
  deferredLine,
  finalOutcome,
  interruptHandler,
  ruleMatches,
  runMutations,
  summaryLine,
} from './run.mjs';
import { selectChanged, splitServed } from './select.mjs';
import { validateSpec } from './validate.mjs';

// How long a child gets to act on a forwarded signal before its group is KILLed.
const SIGNAL_GRACE_MS = 5000;

function usage(msg, setup = projectSetup()) {
  const cmd = setup.commands.mutate;
  console.error(
    `${msg}\nusage: ${cmd} <ID> [--only=M1,M2] [--dry-run] [--file=PATH] [--digest] [--typecheck]\n       ${cmd} --registry (--ids=<ID>/<Mn>,... | --all | --changed[=<base>]) [--dry-run] [--typecheck]\n       ${cmd} --rotate --ledger=<dir> [--budget-min=<n>] [--batch=<n>] [--deadline=<ISO>] [--sha=<sha>]`,
  );
  process.exit(2);
}

// Entries to run, as [key, entry][]; exits 2 on any usage or registry problem.
function selectEntries(args, flag, setup) {
  const registryMode = args.includes('--registry');
  const changed = args
    .find((a) => a === '--changed' || a.startsWith('--changed='))
    ?.slice('--changed='.length);
  if (changed !== undefined && !registryMode)
    usage('--changed needs --registry');
  const reg = loadRegistry(ROOT, setup);
  if (reg.errors.length) {
    console.error(
      `${setup.dir}/ is invalid:\n  - ${reg.errors.join('\n  - ')}\nRun ${setup.commands.checkMutations} for the full report.`,
    );
    process.exit(2);
  }
  if (registryMode) {
    for (const f of ['only', 'file', 'digest'])
      if (args.some((a) => a === `--${f}` || a.startsWith(`--${f}=`)))
        usage(`--${f} does not combine with --registry`);
    let ids = flag('ids')?.split(',').filter(Boolean);
    let deferred = [];
    const defer = args.includes('--defer-playwright');
    if (defer && changed === undefined)
      usage('--defer-playwright needs --changed');
    if (changed !== undefined) {
      if (ids || args.includes('--all'))
        usage('--changed does not combine with --ids or --all');
      try {
        ids = selectChanged({ base: changed || baseRef() }, setup).map(
          (s) => s.key,
        );
        if (defer) {
          const split = splitServed(
            ids.map((key) => ({ key })),
            reg.entries,
            setup,
          );
          deferred = split.deferred.map((s) => s.key);
          ids = split.run.map((s) => s.key);
        }
      } catch (err) {
        console.error(
          `mutate:check: the changed-entry selection failed: ${err.message}\nRun ${setup.commands.checkMutations}, fix what it reports, then re-run.`,
        );
        process.exit(1);
      }
      if (ids.length === 0)
        return {
          registryMode,
          pairs: [],
          id: 'registry',
          mode: 'changed',
          empty: true,
          deferred,
        };
    }
    if (!ids && !args.includes('--all'))
      usage('--registry needs --ids=<ID>/<Mn>,..., --all or --changed');
    if (ids && args.includes('--all')) usage('--ids and --all are exclusive');
    let pairs;
    if (ids) {
      const bad = ids.filter((k) => !reg.entries.has(k));
      if (bad.length) usage(`--ids names unknown key(s): ${bad.join(', ')}`);
      const retired = ids.filter((k) => reg.entries.get(k).entry.retired);
      if (retired.length)
        usage(`--ids names retired key(s): ${retired.join(', ')}`);
      pairs = [...new Set(ids)]
        .sort(compareKeys)
        .map((k) => [k, reg.entries.get(k).entry]);
    } else
      pairs = [...reg.entries.keys()]
        .sort(compareKeys)
        .map((k) => [k, reg.entries.get(k).entry]);
    const spec = toSpec(pairs, 'registry', setup);
    if (spec.mutations.length === 0) usage(`no live entries in ${setup.dir}/`);
    return {
      registryMode,
      pairs,
      spec,
      id: 'registry',
      mode: changed !== undefined ? 'changed' : ids ? 'ids' : 'all',
      deferred,
      ...(changed !== undefined ? { base: changed || baseRef() } : {}),
    };
  }
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) usage('missing ticket id');
  const file = flag('file');
  let pairs;
  let source = 'registry';
  if (file) {
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) usage(`no entries file at ${abs}`);
    const tmp = { entries: new Map(), errors: [] };
    addArea(tmp.entries, tmp.errors, file, readFileSync(abs, 'utf8'));
    const foreign = [...tmp.entries.keys()].filter(
      (k) => !k.startsWith(`${id}/`),
    );
    if (tmp.errors.length || foreign.length) {
      console.error(
        `${file} is invalid:\n  - ${[...tmp.errors, ...foreign.map((k) => `key ${k} does not start with ${id}/`)].join('\n  - ')}`,
      );
      process.exit(2);
    }
    pairs = entriesFor(tmp, id);
    source = `file:${relative(ROOT, abs)}`;
  } else pairs = entriesFor(reg, id);
  if (pairs.length === 0) usage(`no live entries for ${id} in ${setup.dir}/`);
  return { registryMode, pairs, source, id };
}

async function main() {
  const setup = projectSetup();
  const args = process.argv.slice(2);
  if (args.includes('--rotate')) return rotateMain(args, setup);
  const flag = (name) =>
    args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const dry = args.includes('--dry-run');
  const typecheck = args.includes('--typecheck');
  const typechecker = setup.harnesses.find((h) => h.typecheck)?.typecheck;
  if (typecheck && !typechecker)
    usage('--typecheck: no harness of this setup type-checks patches', setup);
  if (typecheck)
    for (const f of ['only', 'digest', 'defer-playwright'])
      if (args.some((a) => a === `--${f}` || a.startsWith(`--${f}=`)))
        usage(`--${f} does not combine with --typecheck`);
  const sel = selectEntries(args, flag, setup);
  const { registryMode, pairs, id } = sel;
  if (sel.deferred?.length) console.log(deferredLine(sel.deferred));
  if (sel.empty && typecheck) {
    console.log(typechecker.summary(id, []));
    return;
  }
  if (sel.empty) {
    console.log(
      `${summaryLine('registry', [])} (${sel.deferred?.length ? 'nothing left to run in the gate' : 'the diff touches no live registry entry'})`,
    );
    return;
  }
  const onlyKeys = flag('only')
    ?.split(',')
    .filter(Boolean)
    .map((o) => (o.includes('/') ? o : `${id}/${o}`));
  if (!registryMode) {
    for (const [key, e] of pairs)
      if (e.retired) console.log(`${key} skipped (retired)`);
  }
  if (args.includes('--digest')) {
    console.log(`entriesDigest: ${entriesDigest(pairs)}`);
    console.log(`treeHash: ${ticketTreeHash(setup)}`);
    return;
  }
  const spec = registryMode ? sel.spec : toSpec(pairs, id, setup);
  if (spec.mutations.length === 0)
    usage(`no live entries for ${id} in ${setup.dir}/`);
  const errors = validateSpec(
    spec,
    (p) => readFileSync(join(ROOT, p), 'utf8'),
    setup,
  );
  if (errors.length) {
    console.error(
      `${id} is invalid:\n  - ${errors.join('\n  - ')}\nFix the entries; nothing was run.`,
    );
    process.exit(2);
  }
  if (onlyKeys) {
    const unknown = onlyKeys.filter(
      (o) => !spec.mutations.some((m) => m.id === o),
    );
    if (unknown.length)
      usage(`--only names unknown id(s): ${unknown.join(', ')}`);
  }
  const todo = onlyKeys
    ? spec.mutations.filter((m) => onlyKeys.includes(m.id))
    : spec.mutations;
  const tests = new Set(todo.map((m) => m.test));
  console.log(
    `plan: ${todo.length} mutation(s), ${tests.size} distinct test command(s) (each run once unmutated first)`,
  );
  for (const m of todo) {
    const note = setup.kinds.get(m.kind)?.planNote?.(m);
    const rebuilds = setup.rebuild
      .filter((rule) => ruleMatches(rule, m))
      .map((rule) => `  ${rule.note}`)
      .join('');
    console.log(
      `  ${m.id}  ${m.kind}  ${m.protects ?? ''}  ${m.test}${note ? `  ${note}` : ''}${rebuilds}`,
    );
  }
  if (dry) return;
  if (typecheck) {
    // Exits 130/143 on a signal; nothing is written, so nothing needs restoring.
    process.on('SIGINT', () => process.exit(130));
    process.on('SIGTERM', () => process.exit(143));
    process.exit(await typechecker.main(spec, todo, id));
  }
  // One run on the local stack at a time; children inherit the owner id.
  takeOrExit('mutate:check');

  const before = treeHash();
  const beforeEntries = new Map(treeEntries());
  const state = {};
  let io;
  let interrupted = false;
  // Runs once: restore, lean reset if sql is applied, exit 130 (SIGINT) or 143.
  const onInterrupt = async (sig) => {
    if (interrupted) return;
    interrupted = true;
    await interruptHandler(state, io, process.exit, sig, setup);
  };
  // Children run in their own process groups, so a signal (a terminal Ctrl-C,
  // or kill <pid>) reaches only the tool. Forward it to every child group; the
  // child's close then reaches onInterrupt. With no child running, stop now.
  const onSignal = (sig) => {
    if (state.interrupted) return;
    state.interrupted = sig;
    for (const c of inFlight) {
      try {
        process.kill(-c.pid, sig);
      } catch {
        /* already gone */
      }
    }
    if (inFlight.size === 0) void onInterrupt(sig);
    // A child can swallow the forwarded signal (a shell takes a SIGINT that lands
    // while it forks and then waits on nothing). Give it the grace the time-limit
    // path gives, then KILL its group; the child's exit settles the run.
    else
      setTimeout(() => {
        for (const c of inFlight) safeKillGroup(c.pid, 'SIGKILL');
      }, SIGNAL_GRACE_MS).unref();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  io = realIo(onlyKeys, state, onInterrupt, setup);
  const report = await runMutations(spec, io, setup);
  if (report.refused) {
    console.error(report.refused);
    process.exit(2);
  }
  for (const r of report.results) {
    const m = spec.mutations.find((x) => x.id === r.id);
    console.log(`${r.id} ${r.status.padEnd(8)} ${m.protects ?? ''}  ${m.test}`);
    if (r.status !== 'killed') {
      console.log(`    ${r.detail.split('\n').join('\n    ')}`);
    } else {
      const last = r.detail.split('\n').at(-1);
      if (last.startsWith('restored by reset ')) console.log(`    ${last}`);
    }
  }
  if (report.fatal) {
    console.error(
      report.serveFatal
        ? `\n${report.fatal}\nNothing was mutated; fix the build or start, then re-run.`
        : `\n${report.fatal}\n${setup.commands.afterFatal}`,
    );
  } else {
    console.log(
      `\n${summaryLine(spec.ticket ?? id, report.results, report.rerun, report.builds)}${report.partial ? ' (partial: ok is false)' : ''}`,
    );
  }

  const after = treeHash();
  let names = [];
  if (after !== before) {
    const afterEntries = new Map(treeEntries());
    names = [
      ...new Set([...beforeEntries.keys(), ...afterEntries.keys()]),
    ].filter((p) => beforeEntries.get(p) !== afterEntries.get(p));
    if (!report.fatal)
      console.error(
        `restore left the tree changed: ${names.join(', ')}. Run git diff on them and restore by hand; no receipt written.`,
      );
  }
  const outcome = finalOutcome(report, names);
  if (!outcome.writeReceipt) process.exit(outcome.code);
  const receiptPath = join(
    ROOT,
    registryMode ? setup.receipts.registry : setup.receipts.ticket,
  );
  mkdirSync(dirname(receiptPath), { recursive: true });
  const common = {
    at: new Date().toISOString(),
    results: report.results,
    ok: report.ok,
    ...(report.groups ? { groups: report.groups } : {}),
  };
  const receipt = registryMode
    ? {
        mode: sel.mode,
        ...(sel.base ? { base: sel.base } : {}),
        keys: pairs.map(([k]) => k).sort(compareKeys),
        treeHash: after,
        at: common.at,
        partial: false,
        results: common.results,
        ok: common.ok,
        ...(common.groups ? { groups: common.groups } : {}),
      }
    : {
        ticket: id,
        source: sel.source,
        entriesDigest: entriesDigest(pairs),
        treeHash: ticketTreeHash(setup),
        at: common.at,
        partial: report.partial,
        results: common.results,
        ok: common.ok,
        ...(common.groups ? { groups: common.groups } : {}),
      };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  if (outcome.code !== 0)
    console.error(
      'mutate:check not ok: a survivor means the test does not bite yet. Strengthen it and re-run.',
    );
  process.exit(outcome.code);
}

export { main };
