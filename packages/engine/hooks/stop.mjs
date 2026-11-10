#!/usr/bin/env node
// Stop / SubagentStop hook.
//
// Blocks exactly one failure mode, the one that cost a full dev round on
// a past ticket: an agent ticks a Definition-of-Done checkbox in a phase file
// while the configured verify command's steps are red, were skipped, or were never
// run.
//
// It is deliberately cheap. It runs no test suite; it only reads the receipt
// that the verify command wrote and checks it still describes this exact
// branch. If no DoD checkbox was newly ticked, it approves silently, so
// ordinary work in this repo never pays for it.
//
// "Newly ticked" is measured against the merge-base with main, so a tick that
// was committed is still a tick. A line is new only if the same text was not
// already ticked at the base, so moving a ticked bullet does not count.
// A committed tick is settled when the tree of the commit that last changed it
// (treeHashAt) is in .turbo/ticket-verify-history.jsonl; settled ticks skip the
// checks below except `(human)`, which every newly ticked line still gets.
//
// When a ticket's DoD is being ticked it also checks the follow-up files:
// every FU that the ticket's contract section 8.0 marks `closes` must have
// `status: done` in its follow-up file, and every `PARTIAL` one
// must stay open and carry a `PARTIAL:` note naming the ticket. Without this
// the register only stays accurate when a prompt lists the FUs by hand.
//
// A receipt with `oversize: true` (the diff outside tests, docs and generated
// files is over 1500 lines) blocks like a failing step, unless section 1 of
// each ticked ticket's contract has an `oversize-accepted: <reason>` line,
// which the tech-lead adds up front. A reason starting `move-only` additionally
// needs `moveProof.unmatched === 0` in the receipt (the configured move check).
//
// A `reused` result (a pass recorded earlier on an identical input
// digest) counts as verified, but only if its digest still matches today's
// inputs. Each one is recomputed with stepDigest against the receipt's `base`;
// a missing digest or base, or a mismatch (an env file or a tool version moved
// since the run), blocks. Nothing is written. A receipt with no `reused` result
// is judged exactly as before.

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { commandsOf } from '../config.mjs';
import { ROOT } from '../root.mjs';
import { fileIdOf, parseFile, toRow } from '../fu.mjs';
import {
  baseRef,
  lineCommit,
  readHistory,
  treeExclude,
  treeHash,
  treeHashAt,
} from '../tree.mjs';

const RECEIPT = join(ROOT, '.turbo', 'ticket-verify.json');

const approve = () => process.exit(0);
const block = (reason) => {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
};

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  /* invoked outside a hook, or no stdin: fall through and check anyway */
}

// A blocked stop re-invokes the agent, which stops again. Never block twice.
if (input.stop_hook_active) approve();

const sh = (cmd) =>
  execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

// The config is loaded dynamically, inside a try, so a missing, throwing or invalid
// gate.config.mjs (or an import of it that throws) can never crash the hook to exit 1, which
// Claude Code reads as "proceed". Without a usable config the hook cannot know which files are
// the DoD, so it falls back to a conservative scan: any newly added `- [x]` line in a markdown
// file (diff against the base, or an untracked file) blocks with exit 2; none approves.
const TICK_ADDED = /^\+\s*- \[x\]/i;
const TICK_ANY = /^\s*- \[x\]/im;
function failClosed(err) {
  let ticked = [];
  try {
    const diff = sh(`git diff ${baseRef()} -- '*.md'`)
      .split('\n')
      .filter((l) => TICK_ADDED.test(l));
    const fresh = sh("git ls-files --others --exclude-standard -- '*.md'")
      .split('\n')
      .filter(Boolean)
      .filter((f) => {
        try {
          return TICK_ANY.test(readFileSync(join(ROOT, f), 'utf8'));
        } catch {
          return false;
        }
      });
    ticked = [...diff.map((l) => l.slice(1).trim()), ...fresh];
  } catch {
    approve(); // git unavailable: never block on infrastructure
  }
  if (ticked.length === 0) approve();
  process.stderr.write(
    `ticket-gate: gate.config.mjs is unusable (${err.message}), so the DoD cannot be checked, ` +
      `and ${ticked.length} DoD checkbox(es) were ticked on this branch.\n` +
      'Fix gate.config.mjs (the error above names the problem) and run `ticket-gate verify`, or untick the box(es).\n',
  );
  process.exit(2);
}

let GATE;
let step;
try {
  const { loadGateConfig } = await import('../config.mjs');
  GATE = await loadGateConfig();
  step = await import('../digest.mjs');
} catch (err) {
  failClosed(err);
}
const {
  AFFECTED_NIGHTLY,
  NIGHTLY_MAX_AGE_MS,
  VERIFIED_STATUSES,
  inputState,
  specDigest,
  stepDigest,
} = step;
const { dod } = GATE;
const CMD = commandsOf(GATE); // the commands a message tells the agent to run (gate.config.mjs `commands`)
const FU = GATE.followUps; // { dir, pointer? }; absent: the project keeps no register
const FU_DIR = FU ? join(ROOT, FU.dir) : null;
// "outside <dirs>": the paths `.ticket-gate/tree.json` leaves out of the tree hash.
const OUTSIDE = treeExclude().length
  ? ` outside ${treeExclude().join(', ')}`
  : '';
const escapeRegExp = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HUMAN = new RegExp(escapeRegExp(dod.human), 'i');
const dodContract = (id) => join(ROOT, dod.contract.replace('{id}', id));
const dodGlobs = dod.files.map((g) => `':(glob)${g}'`).join(' ');

// Each ticked line, with the ticket id of the `## <ID> <title>` heading above it.
const tickedLines = (text) => {
  const out = [];
  let id = null;
  const rows = text.split('\n');
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i].trim();
    const heading = /^## (\S+)/.exec(l);
    if (heading) id = heading[1];
    else if (/^- \[x\]/i.test(l))
      out.push({ id, line: i + 1, text: l.replace(/^- \[x\]\s*/i, '') });
  }
  return out;
};

const ticks = []; // { file, line, id, text }; id is null under no `## <ID>` heading
let base = 'HEAD';
try {
  base = baseRef(GATE.base);
  const files = sh(`git ls-files -- ${dodGlobs}`).split('\n').filter(Boolean);
  const untracked = sh(
    `git ls-files --others --exclude-standard -- ${dodGlobs}`,
  )
    .split('\n')
    .filter(Boolean);
  const dodFiles = [...files, ...untracked];
  // A glob that matches no file would read no DoD at all: a silent open (3-10).
  if (dodFiles.length === 0) failClosed(new Error('dod.files matches no file'));
  for (const f of dodFiles) {
    let now = '';
    try {
      now = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    let before = '';
    try {
      before = sh(`git show ${base}:${f}`);
    } catch {
      /* file is new on this branch: every tick in it is new */
    }
    const wasTicked = new Set(tickedLines(before).map((t) => t.text));
    for (const { id, line, text } of tickedLines(now)) {
      if (wasTicked.has(text)) continue;
      ticks.push({ file: f, line, id, text });
    }
  }
} catch {
  approve(); // not a git repo, or git unavailable: never block on infrastructure
}

if (ticks.length === 0) approve();

const tickedHeader = (list) =>
  `${list.length} DoD checkbox(es) were ticked on this branch:\n` +
  list.map((t) => `  ${t.file}: ${t.text}`).join('\n');

// A bullet marked `(human)` (device runs, Maestro flows, staging, tags) is never an agent's to tick,
// settled or not.
// prettier-ignore
const humanOnly = ticks.filter((t) => HUMAN.test(t.text));
if (humanOnly.length) {
  block(
    `${tickedHeader(ticks)}\n\n` +
      'These bullets are human steps and may not be ticked by an agent:\n' +
      humanOnly.map((t) => `  ${t.file}: ${t.text}`).join('\n') +
      '\n\nUntick them and list them under "Human steps" in the PR body.',
  );
}

// `- **FU<n>** closes: ...` in a contract's section 8.0; the FU itself is one file in the follow-ups folder.
// A tick committed on a tree that an earlier green verify run hashed is settled: that run
// already verified it. Every error here leaves the tick unsettled (never approve on a failure).
function settle(ticks, base) {
  const hashes = new Set(readHistory().map((e) => e.treeHash));
  if (hashes.size === 0 || base === 'HEAD') return ticks;
  const hashAt = new Map();
  return ticks.filter((t) => {
    const commit = lineCommit(t.file, t.line);
    if (commit === null) return true;
    if (!hashAt.has(commit)) hashAt.set(commit, treeHashAt(commit, base));
    // prettier-ignore
    return !hashes.has(hashAt.get(commit));
  });
}
let unsettled;
try {
  unsettled = settle(ticks, base);
} catch {
  unsettled = ticks;
}
// prettier-ignore
if (unsettled.length === 0) approve();
const ticked = tickedHeader(unsettled);
// prettier-ignore
const tickedTickets = new Set(unsettled.filter((t) => t.id).map((t) => t.id));
// prettier-ignore
const headlessTick = unsettled.some((t) => !t.id);

const FU_ID = 'FU\\d+[a-z]?(?: \\([^)]+\\))?';
const CONTRACT_FU = new RegExp(`^- \\*\\*(${FU_ID})\\*\\* (closes|PARTIAL)\\b`);

// The FU's file in the follow-ups folder, or null when it does not exist.
function followUpText(fu) {
  try {
    return readFileSync(join(FU_DIR, `${fileIdOf(fu)}.md`), 'utf8');
  } catch {
    return null;
  }
}

const followUpProblems = [];
for (const id of FU ? tickedTickets : []) {
  let contract;
  try {
    contract = readFileSync(dodContract(id), 'utf8');
  } catch {
    continue; // a ticket that skipped phase A has no contract to check
  }
  let in80 = false;
  for (const raw of contract.split('\n')) {
    if (/^#{1,4} /.test(raw)) in80 = /^#{3,4} 8\.0\b/.test(raw);
    const m = in80 && CONTRACT_FU.exec(raw.trim());
    if (!m) continue;
    const [, fu, verdict] = m;
    const where = `${dod.contract.replace('{id}', id)} section 8.0 says ${fu} ${verdict}`;
    const file = `${FU.dir}/${fileIdOf(fu)}.md`;
    const text = followUpText(fu);
    if (text === null) {
      followUpProblems.push(`${where}, but ${file} does not exist.`);
      continue;
    }
    let status;
    try {
      status = parseFile(text).data.status;
    } catch (e) {
      followUpProblems.push(
        `${where}, but its file does not parse: ${e.message}.`,
      );
      continue;
    }
    if (verdict === 'closes') {
      if (status !== 'done')
        followUpProblems.push(`${where}, but its file says status: ${status}.`);
    } else if (status !== 'open') {
      followUpProblems.push(
        `${where}, but its file says status: ${status} (PARTIAL items stay open).`,
      );
    } else if (!new RegExp(`PARTIAL: ${id}\\b`).test(toRow(text))) {
      followUpProblems.push(
        `${where}, but its file has no "PARTIAL: ${id} ..." note.`,
      );
    }
  }
}

if (followUpProblems.length) {
  block(
    `${ticked}\n\n` +
      'The follow-up files do not match what the contract says this ticket closes:\n' +
      followUpProblems.map((p) => `  ${p}`).join('\n') +
      `\n\nUpdate ${FU.dir}/: run \`${CMD.fu} close <FU> --by <ID> --sha <sha>\` for each \`closes\` FU, and add a ` +
      "`PARTIAL: <ID> ...` note to each `PARTIAL` one's body. If a fix was not made, mark it " +
      '`declined` in section 8.0 with the reason instead.',
  );
}

let receipt;
try {
  receipt = JSON.parse(readFileSync(RECEIPT, 'utf8'));
} catch {
  block(
    `${ticked}\n\n` +
      'No verification receipt exists. The verify command must pass before a ticket is ' +
      'declared done.\n\n' +
      `Run \`${CMD.verify}\`, paste its output into the PR body, and only then leave the ` +
      'checkboxes ticked. If a box depends on a human-only step, untick it and list it under ' +
      '"Human steps" instead.',
  );
}

if (receipt.treeHash !== treeHash()) {
  block(
    `${ticked}\n\n` +
      `The verification receipt is stale: it was written at ${receipt.ranAt}, and the branch ` +
      `has changed since: a changed, added, deleted or re-moded file${OUTSIDE}. ` +
      'Committing or staging alone does not do this. Whatever changed last was never verified.\n\n' +
      `Re-run \`${CMD.verify}\` and update the summary lines in the PR body.`,
  );
}

const notVerified = (receipt.results ?? []).filter(
  (r) => !VERIFIED_STATUSES.includes(r.status),
);
if (!receipt.ok || notVerified.length) {
  block(
    `${ticked}\n\n` +
      `The last \`${CMD.verify}\` run did not verify every required step:\n` +
      notVerified
        .map((r) => `  [${r.status.toUpperCase()}] ${r.cmd}: ${r.summary}`)
        .join('\n') +
      '\n\nA skipped step is not a passed step. Run it (install the stack or tool it needs) ' +
      'before declaring the ticket done. A turbo task cancelled by an upstream failure is not ' +
      'a pass: check every task, not just the first summary line.',
  );
}

// A reused result is a pass on identical inputs: prove they are still identical.
const sameInputs = (r) =>
  stepDigest(r.id, r.cmd, { base: receipt.base }) === r.digest;
for (const r of (receipt.results ?? []).filter((x) => x.status === 'reused')) {
  let match = false;
  try {
    match =
      typeof r.digest === 'string' &&
      typeof receipt.base === 'string' &&
      sameInputs(r);
  } catch {
    /* git or digest failure: never approve on it */
  }
  if (!match) {
    block(
      `${ticked}\n\n` +
        `reused step ${r.id} no longer matches its inputs (an env file or a tool version changed): re-run \`${CMD.verify}\``,
    );
  }
}

// Any step's result may come from a partial (affected) run, whatever the step's id: a nightly-backed
// step records a mode, selected specs and a knownRed list. A result with no mode is a full run,
// judged as above.
for (const r of (receipt.results ?? []).filter((x) => typeof x.id === 'string')) {
  const mode = r.mode ?? 'full';
  if (mode !== 'full' && mode !== 'affected') {
    block(`${ticked}\n\nunknown ${r.id} mode ${mode}: re-run \`${CMD.verify}\``);
  }
  const inside = (r.knownRed ?? []).filter((f) =>
    (r.selected ?? []).includes(f),
  );
  if (inside.length) {
    block(
      `${ticked}\n\n` +
        inside
          .map(
            (f) =>
              `knownRed spec ${f} is inside this branch's selection: it must run and pass`,
          )
          .join('\n'),
    );
  }
  if (mode === 'affected') {
    if (
      !AFFECTED_NIGHTLY.includes(r.nightly?.status) ||
      !(
        Date.parse(r.nightly?.checkedAt) - Date.parse(r.nightly?.ranAt) <=
        NIGHTLY_MAX_AGE_MS
      )
    ) {
      block(
        `${ticked}\n\n${r.id} ran in affected mode without a fresh green or amber nightly: re-run \`${CMD.verify}\` (it falls back to full)`,
      );
    }
    const specs = r.specs ?? [];
    const uncovered = (r.selected ?? []).filter(
      (f) =>
        !specs.some(
          (s) => s.file === f && ['pass', 'reused'].includes(s.status),
        ),
    );
    if (uncovered.length) {
      block(
        `${ticked}\n\n` +
          uncovered
            .map((f) => `affected ${r.id} did not pass selected spec ${f}`)
            .join('\n') +
          `\n\nRe-run \`${CMD.verify}\`.`,
      );
    }
    let state = null;
    try {
      state = inputState({ base: receipt.base });
    } catch {
      /* git failure: every reused spec then fails to match */
    }
    for (const s of specs.filter((x) => x.status === 'reused')) {
      let match = false;
      try {
        match =
          state !== null &&
          typeof s.digest === 'string' &&
          Array.isArray(s.inputs) &&
          specDigest(s.file, s.inputs, { state }) === s.digest;
      } catch {
        /* a throw counts as no match */
      }
      if (!match) {
        block(
          `${ticked}\n\nreused ${r.id} spec ${s.file} no longer matches its inputs: re-run \`${CMD.verify}\``,
        );
      }
    }
  }
}

// The diff is too big to have been reviewed as one ticket (the review map).
const OVERSIZE_ACCEPTED = dod.oversize;
const MOVE_ONLY = /^move-only/;
const reasonsOf = (id) => {
  if (!id) return [];
  try {
    const lines = readFileSync(dodContract(id), 'utf8').split('\n');
    const start = lines.findIndex((l) => /^## 1\.\s/.test(l));
    if (start < 0) return [];
    const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    return lines
      .slice(start, end < 0 ? undefined : end)
      .map((l) => l.trim())
      .filter((l) => OVERSIZE_ACCEPTED.test(l))
      .map((l) => l.replace(/^(?:- )?oversize-accepted:\s*/, ''));
  } catch {
    return [];
  }
};
// A `move-only` waiver also needs the receipt's move proof at 0.
const accepted = (id) => {
  const reasons = reasonsOf(id);
  if (reasons.length === 0) return false;
  if (reasons.some((r) => MOVE_ONLY.test(r)))
    return receipt.moveProof?.unmatched === 0;
  return true;
};
if (receipt.oversize === true) {
  const unaccepted = [...tickedTickets].filter((id) => !accepted(id));
  if (unaccepted.length || headlessTick) {
    block(
      `${ticked}\n\n` +
        `The diff is ${receipt.size?.lines ?? 'over 1500'} changed lines outside tests, docs and generated files, over the 1500 cap. ` +
        `Ticket(s) without a waiver: ${[...unaccepted, ...(headlessTick ? ['(a ticked line with no ticket heading)'] : [])].join(', ')}.\n\n` +
        `Split the ticket (${GATE.reviewMap.splitHint}). If a split is impossible, the ` +
        'tech-lead (not a dev) adds the line `oversize-accepted: <reason>` to section 1 of ' +
        `${dod.contract.replace('{id}', '<ID>')}, then re-run \`${CMD.verify}\`.` +
        ([...unaccepted].some((id) => reasonsOf(id).length)
          ? `\n\nA move-only waiver needs moveProof.unmatched === 0 (receipt has ${receipt.moveProof?.unmatched ?? 'none'}): run ${CMD.moveCheck}`
          : ''),
    );
  }
}

approve();
