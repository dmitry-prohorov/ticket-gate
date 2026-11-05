// Sessions and harnesses (entry kinds and setup): which session runs an entry, and
// how a patch is put on disk and taken off again. The pure grouping and
// attribution functions disjointGroups/attribute (proposal 4.7a) join this
// file; none names a platform.
import { patchedSource } from './locate.mjs';
import { tail, verdict } from './verdict.mjs';

/**
 * Applies each patch in order on the progressively patched text of its file.
 * Each file's original is recorded once in `state.live` and `state.restore`
 * puts every live file back. A `find` that no longer occurs once throws and
 * leaves the tree as it was.
 */
export function applyPatch(patches, io, state) {
  const live = (state.live ??= new Map());
  const texts = new Map();
  const fresh = [];
  try {
    for (const m of patches) {
      if (!texts.has(m.file)) {
        const original = io.readFile(m.file);
        texts.set(m.file, original);
        if (!live.has(m.file)) {
          live.set(m.file, original);
          fresh.push(m.file);
        }
      }
      try {
        texts.set(m.file, patchedSource(texts.get(m.file), m));
      } catch (err) {
        if (patches.length === 1) throw err;
        throw new Error(
          `${m.id}: find no longer occurs once with the other patches applied`,
        );
      }
    }
  } catch (err) {
    for (const file of fresh) live.delete(file);
    throw err;
  }
  state.restore = () => restorePatch(state, io);
  try {
    for (const [file, text] of texts) io.writeFile(file, text);
  } catch (err) {
    try {
      restorePatch(state, io);
    } catch {
      /* the write error is the one to report */
    }
    throw err;
  }
}

/** Writes every live file back and checks it; a no-op when nothing is live. */
export function restorePatch(state, io) {
  if (!state.live) {
    state.restore = null;
    return;
  }
  let failed = null;
  for (const [file, original] of state.live) {
    try {
      io.writeFile(file, original);
      if (io.readFile(file) !== original)
        throw new Error(`restore of ${file} is not byte-identical`);
    } catch (err) {
      failed ??= err;
    }
  }
  state.live.clear();
  state.restore = null;
  if (failed) throw failed;
}

/**
 * The inline fallback harness: runs every patch no other harness claims, one at
 * a time. Rebuild rules (`ctx.rulesFor`) bracket the run: the flag is set while
 * the patch is live, and the build runs again once the file is back.
 */
export const localHarness = {
  name: 'local',
  order: 0,
  inline: true,
  claims: () => true,
  async runOne(m, io, state, ctx) {
    const rules = ctx.rulesFor(m);
    let result;
    try {
      for (const rule of rules) state[rule.flag] = true;
      applyPatch([m], io, state);
      for (const rule of rules) {
        const b = await io[rule.io]();
        if (b.code !== 0)
          throw new Error(`${rule.cmd} failed after apply: ${tail(b.out)}`);
      }
      result = verdict(m, await io.run(m.test));
    } catch (err) {
      result = {
        id: m.id,
        status: 'error',
        detail: String(err?.message ?? err),
      };
    } finally {
      try {
        restorePatch(state, io);
      } catch (err) {
        const detail = `RESTORE FAILED: ${err.message}. Run ${ctx.setup.commands.restoreHint}`;
        if (result) result = { ...result, status: 'error', detail };
        else result = { id: m.id, status: 'error', detail };
      }
      state.restore = null;
    }
    for (const rule of rules) {
      // The built output must match the source again before the next mutation.
      const b = await io[rule.io]();
      if (b.code === 0) state[rule.flag] = false;
      else {
        ctx.fatal = `${rule.cmd} failed after restoring ${m.file}: ${rule.drift}. Run ${rule.cmd}`;
        result = { id: m.id, status: 'error', detail: ctx.fatal };
      }
    }
    return result;
  },
};

const claimedTwice = (entry, claimants) =>
  new Error(
    `mutations config: ${entry.id} is claimed by both ${claimants[0].name} and ${claimants[1].name}`,
  );

/**
 * The session that runs an entry: a non-patch kind's own `session`, or the
 * harness claiming a patch (localHarness claims every patch nobody else does).
 * Throws when two harnesses claim one entry.
 */
export function sessionOf(entry, setup) {
  if (entry.kind !== 'patch') return setup.kinds.get(entry.kind)?.session;
  const claimants = setup.harnesses.filter(
    (h) => h !== localHarness && h.claims(entry),
  );
  if (claimants.length > 1) throw claimedTwice(entry, claimants);
  return claimants[0] ?? localHarness;
}

// ---- grouping and attribution (pure; no io, no platform name) -------------

const shares = (a, b) => a.some((x) => b.includes(x));
const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;
const soloGroup = (entry, why) => ({
  key: entry.id,
  entries: [entry],
  solo: why,
});

// prettier-ignore
function compatible(a, b) {
  if (shares(a.tests, b.tests)) return false;
  if (shares(a.cover, b.tests) || shares(b.cover, a.tests)) return false;
  if (a.span.file === b.span.file && overlaps(a.span, b.span)) return false;
  return true;
}

/**
 * Greedy first-fit grouping in input order. A member joins a group only when
 * it is compatible with every member: no shared test, no test of one covering
 * the other's site, no overlapping lines in one file. `testsOf(entry)` is the
 * tests that own the entry (null: unparsable); `coverOf(entry)` is
 * `{ cover, span }` (null: no coverage). Both fall back to a solo group.
 */
export function disjointGroups(entries, testsOf, coverOf) {
  const out = [];
  const open = [];
  for (const entry of entries) {
    const tests = testsOf(entry);
    if (tests == null) {
      out.push(soloGroup(entry, 'tests unparsable'));
      continue;
    }
    const facts = coverOf(entry);
    if (facts == null) {
      out.push(soloGroup(entry, 'no coverage'));
      continue;
    }
    const m = { entry, tests, cover: facts.cover, span: facts.span };
    const home = open.find((g) => g.members.every((o) => compatible(o, m)));
    if (home) {
      home.members.push(m);
      home.entries.push(entry);
    } else {
      const g = { key: entry.id, entries: [entry], members: [m] };
      open.push(g);
      out.push(g);
    }
  }
  return out;
}

const holds = (span, c) =>
  span.file === c.file && span.start <= c.line && c.line <= span.end;

/**
 * Maps one run of a group back to its members. `{ solo }` means the run cannot
 * be attributed and each member must be run alone. A compile error that lands
 * in exactly one member's span marks that member an error and returns the rest
 * to be deployed again.
 */
// prettier-ignore
export function attribute(group, run) {
  if (!run.complete) return { solo: 'run cut short' };
  const members = group.members;
  if (run.compile) {
    const owners = members.filter((m) => holds(m.span, run.compile));
    if (owners.length !== 1) return { solo: 'compile error not attributable' };
    return {
      results: [
        {
          id: owners[0].entry.id,
          status: 'error',
          detail: `compile: ${run.compile.message}`,
        },
      ],
      redeploy: members.filter((m) => m !== owners[0]),
    };
  }
  for (const row of run.rows) {
    if (row.outcome !== 'fail') continue;
    const owner = members.find((m) => m.tests.includes(row.test));
    if (owner === undefined) return { solo: `row owned by no member: ${row.test}` };
  }
  const results = members.map((m) => {
    const own = run.rows.filter((r) => m.tests.includes(r.test));
    const id = m.entry.id;
    if (own.some((r) => r.outcome === 'fail'))
      return { id, status: 'killed', detail: 'a covering test failed' };
    if (own.length > 0)
      return { id, status: 'survived', detail: 'every covering test passed' };
    return { id, status: 'error', detail: 'no rows' };
  });
  return { results };
}
