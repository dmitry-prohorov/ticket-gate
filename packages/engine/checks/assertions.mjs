#!/usr/bin/env node
/**
 * The assertion ratchet in engine shape: counts the configured needles per spec,
 * sums them per area (a spec counts toward every area in its line-1 header), and compares with the
 * configured baseline file. Every project value (paths, counters, areas, commands, messages) comes
 * from the config passed to `assertions(cfg)`; this module names none.
 *
 * - A drop in an area fails unless the mutation registry covers it: the receipt is green and
 *   complete for this tree, and every dropped spec is named by the `from` of a live entry of that
 *   ticket (`unguarded` included).
 * - Any other change (a rise, a new or changed spec) is `stale`; the update command fixes it.
 * Never edit the baseline by hand.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { listFiles, readText } from '../graph/js.mjs';
import {
  entriesDigest,
  entriesFor,
  loadRegistry,
  ticketTreeHash,
} from '../mutations/registry.mjs';

const count = (text, needle) => text.split(needle).length - 1;

/** @param {object} cfg the assertions config @param {string} root repo root */
function countSpecs(cfg, root) {
  const { dir, match, header } = cfg.specs;
  const out = {};
  const files = listFiles(root, dir, (p) => match.test(p)).map((p) =>
    p.slice(dir.length + 1),
  );
  for (const name of files) {
    const text = readText(root, `${dir}/${name}`) ?? '';
    const m = header.exec(text.split('\n', 1)[0].replace(/\r$/, ''));
    const entry = { areas: m ? m[1] : '' };
    for (const k of Object.keys(cfg.counters))
      entry[k] = count(text, cfg.counters[k]);
    out[name] = entry;
  }
  return out;
}

function areaTotals(cfg, specs) {
  const out = {};
  for (const a of cfg.areas)
    out[a] = Object.fromEntries(Object.keys(cfg.counters).map((k) => [k, 0]));
  for (const s of Object.values(specs)) {
    for (const a of s.areas.split(', ')) {
      if (!out[a]) continue;
      for (const k of Object.keys(cfg.counters)) out[a][k] += s[k];
    }
  }
  return out;
}

function compare(cfg, baseline, specs) {
  const prev = baseline.areas ?? {};
  const nowAreas = areaTotals(cfg, specs);
  const drops = [];
  const rises = [];
  for (const area of cfg.areas) {
    for (const counter of Object.keys(cfg.counters)) {
      const was = prev[area]?.[counter] ?? 0;
      const now = nowAreas[area][counter];
      if (now < was) drops.push({ area, counter, was, now });
      if (now > was) rises.push({ area, counter, was, now });
    }
  }
  const specChanges = [];
  const old = baseline.specs ?? {};
  for (const name of Object.keys({ ...old, ...specs }).sort()) {
    if (JSON.stringify(old[name]) !== JSON.stringify(specs[name]))
      specChanges.push(name);
  }
  return { drops, rises, specChanges };
}

/** Baseline specs in a dropped area that are gone or have a lower counter. */
function culpritsOf(cfg, baseline, specs, drops) {
  const areas = new Set(drops.map((d) => d.area));
  const out = [];
  for (const [name, b] of Object.entries(baseline.specs ?? {})) {
    if (!b.areas.split(', ').some((a) => areas.has(a))) continue;
    const now = specs[name];
    const lostArea = b.areas
      .split(', ')
      .some((a) => areas.has(a) && !now?.areas.split(', ').includes(a));
    if (
      !now ||
      lostArea ||
      Object.keys(cfg.counters).some((k) => now[k] < b[k])
    )
      out.push(`${cfg.from}${name}`);
  }
  return out;
}

function receiptProblem(cfg, receipt, io) {
  if (receipt === null) return `no mutation receipt (${cfg.receipt})`;
  if (receipt.ok !== true) return 'receipt not green';
  if (receipt.partial !== false) return 'receipt is partial';
  if (receipt.source !== 'registry') return 'receipt is from a --file run';
  if (receipt.treeHash !== io.treeHash()) return 'receipt is for another tree';
  const own = entriesFor(loadRegistry(io.root, io.setup), receipt.ticket);
  if (entriesDigest(own) !== receipt.entriesDigest) return 'mutations changed';
  return { own };
}

function coverage(cfg, baseline, specs, receipt, io) {
  const { drops } = compare(cfg, baseline, specs);
  const culprits = culpritsOf(cfg, baseline, specs, drops);
  const r = receiptProblem(cfg, receipt, io);
  if (typeof r === 'string')
    return { covered: false, why: r, missing: culprits };
  const named = new Set();
  for (const [, e] of r.own) if (!e.retired && e.from) named.add(e.from);
  const missing = culprits.filter((spec) => !named.has(spec));
  if (missing.length > 0)
    return {
      covered: false,
      why: 'no mutation names the dropped spec',
      missing,
    };
  return { covered: true, why: null, missing: [] };
}

function readBaseline(path) {
  if (!existsSync(path)) return { baseline: null };
  try {
    const b = JSON.parse(readFileSync(path, 'utf8'));
    if (!b || typeof b !== 'object' || !b.areas || !b.specs)
      throw new Error('missing areas or specs');
    return { baseline: b };
  } catch (e) {
    return { error: e.message };
  }
}

function readReceipt(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const dropLine = (d) => `  ${d.area} ${d.counter}: was ${d.was}, now ${d.now}`;

/**
 * @param {object} cfg
 * @param {string} root
 * @param {{ baselinePath?: string, receiptPath?: string, treeHash?: () => string, update?: boolean }} [opts]
 * @returns {{ code: 0 | 1 | 2, lines: string[], wrote: boolean }}
 */
function checkE2eAssertions(cfg, root, opts = {}) {
  const { name, commands } = cfg;
  const baselinePath = opts.baselinePath ?? join(root, cfg.baseline);
  const receiptPath = opts.receiptPath ?? join(root, cfg.receipt);
  const io = {
    root,
    treeHash: opts.treeHash ?? (() => ticketTreeHash(cfg.setup)),
    setup: cfg.setup,
  };
  const specs = countSpecs(cfg, root);
  const write = () => {
    const doc = {
      comment: cfg.comment,
      areas: areaTotals(cfg, specs),
      specs,
    };
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`);
    return true;
  };
  const refuseUpdate = (cov) => ({
    code: 1,
    wrote: false,
    lines: [
      `${name}: --update refused, the drop is not covered: ${cov.why}`,
      ...cov.missing.map((m) => `  missing: ${m}`),
      `Run ${commands.mutate} green on this tree with a mutation from field (or "unguarded") for each spec above, then retry.`,
    ],
  });

  const { baseline, error } = readBaseline(baselinePath);
  if (error)
    return {
      code: 2,
      wrote: false,
      lines: [
        `${name}: unreadable baseline ${baselinePath}: ${error}`,
        `Restore it with git checkout -- ${cfg.baseline}, or delete it and run ${commands.update}.`,
      ],
    };
  if (baseline === null) {
    if (opts.update) {
      write();
      return {
        code: 0,
        wrote: true,
        lines: [`${name}: baseline written (none existed)`],
      };
    }
    return {
      code: 2,
      wrote: false,
      lines: [
        `${name}: no baseline at ${baselinePath}. Run ${commands.update}.`,
      ],
    };
  }

  const { drops, rises, specChanges } = compare(cfg, baseline, specs);
  const equal =
    drops.length === 0 && rises.length === 0 && specChanges.length === 0;
  if (equal)
    return {
      code: 0,
      wrote: false,
      lines: [
        `${name}: ${Object.keys(specs).length} specs, ${cfg.areas.length} areas match the baseline`,
      ],
    };

  if (drops.length > 0) {
    const cov = coverage(cfg, baseline, specs, readReceipt(receiptPath), io);
    if (opts.update) {
      if (!cov.covered) return refuseUpdate(cov);
      write();
      return {
        code: 0,
        wrote: true,
        lines: [`${name}: baseline updated (drop covered)`],
      };
    }
    if (cov.covered)
      return {
        code: 0,
        wrote: false,
        lines: [
          `${name}: assertion drop`,
          ...drops.map(dropLine),
          `covered by the mutation receipt; run ${commands.update}`,
        ],
      };
    return {
      code: 1,
      wrote: false,
      lines: [
        `${name}: assertion drop not covered`,
        ...drops.map(dropLine),
        `why: ${cov.why}`,
        ...cov.missing.map((m) => `  missing: ${m}`),
        `Fix: add a mutation with a from field (or an "unguarded" entry) for each missing spec in the registry (${cfg.registry}), run ${commands.mutate} green on this tree, then ${commands.update}.`,
      ],
    };
  }

  if (opts.update) {
    write();
    return {
      code: 0,
      wrote: true,
      lines: [`${name}: baseline updated`],
    };
  }
  return {
    code: 1,
    wrote: false,
    lines: [
      `${name}: stale baseline (assertions or specs changed with no drop)`,
      ...rises.map(dropLine),
      ...specChanges.map((n) => `  spec changed: ${n}`),
      `Fix: ${commands.update} (no receipt needed), then commit ${cfg.baseline}.`,
    ],
  };
}

/**
 * @param {object} cfg
 * @param {{ root: string, args: string[] }} opts
 * @returns {{ code: 0 | 1 | 2, lines: string[], out: string[], err: string[] }}
 */
function checkArgs(cfg, { root, args }) {
  const opts = { update: false };
  let bad = null;
  for (const a of args) {
    if (a === '--update') opts.update = true;
    else if (a.startsWith('--baseline=')) opts.baselinePath = a.slice(11);
    else if (a.startsWith('--receipt=')) opts.receiptPath = a.slice(10);
    else bad = a;
  }
  if (bad) {
    const err = [
      `${cfg.name}: unknown argument ${bad}. Usage: ${cfg.commands.usage} [--update] [--baseline=<path>] [--receipt=<path>]`,
    ];
    return { code: 2, lines: err, out: [], err };
  }
  const r = checkE2eAssertions(cfg, root, opts);
  const out = r.code === 0 ? [r.lines.join('\n')] : [];
  const err = r.code === 0 ? [] : [r.lines.join('\n')];
  return { code: r.code, lines: [...out, ...err], out, err };
}

/** @param {AssertionsConfig} cfg @returns {Assertions} */
export function assertions(cfg) {
  return {
    COUNTERS: cfg.counters,
    countSpecs: (root) => countSpecs(cfg, root),
    areaTotals: (specs) => areaTotals(cfg, specs),
    compare: (baseline, specs) => compare(cfg, baseline, specs),
    coverage: (baseline, specs, receipt, io) =>
      coverage(cfg, baseline, specs, receipt, io),
    checkE2eAssertions: (root, opts) => checkE2eAssertions(cfg, root, opts),
    check: (args) => checkArgs(cfg, args),
  };
}
