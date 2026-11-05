// INFRA-57 section 5 org fixture: a synthetic grouped Harness (the real
// Salesforce one is INFRA-61). Built only from the section 2 names:
//   open  = one fake deploy plus a coverage map (1 deploy, 1 run)
//   group = disjointGroups over opened.facts
//   run   = per group applyPatch -> fake deploy (compile errors scripted per
//           file:line) -> fake rows -> attribute -> emit, falling back to solo
//           runs on { solo }
//   close = one fake deploy
// Nothing here reads the engine's run order: the test asserts it.
import {
  applyPatch,
  attribute,
  disjointGroups,
  restorePatch,
} from '../../../mutations/harness.mjs';
import { resolveSetup } from '../../../mutations/kinds.mjs';

export const ORG_FILES = Object.freeze({
  'org/a.js': 'a1\na2\na3\na4\na5\na6\n',
  'org/b.js': 'b1\nb2\nb3\n',
  'org/c.js': 'c1\nc2\n',
});
export const TEST_CMD = 'org-suite';
export const marker = (id) => `MARK_${id}`;

/** A patch entry the org harness claims; its replacement is a unique marker. */
export const orgEntry = (id, file, find, extra = {}) => ({
  id,
  protects: `org ${id}`,
  kind: 'patch',
  file,
  find,
  replace: marker(id),
  test: TEST_CMD,
  ...extra,
});

/**
 * script = {
 *   tests:  { <id>: string[] }                    tests that own the entry
 *   cover:  { <id>: { cover, span } | null }      coverage facts (null: none)
 *   fails:  { <test>: string[] }                  the test fails while any marker is in the tree
 *   compile:[{ file, line, message, marker }]     deploy fails while file holds marker
 *   orphan: [{ marker, test }]                    an extra failing row nobody owns
 *   cut:    string[]                              the run is incomplete while a marker is in the tree
 *   red:    string[]                              test commands whose baseline is red
 *   duringDeploy: async ({ io, state, files, setup }) => void   runs inside a group deploy
 * }
 */
export function orgWorld(script = {}) {
  const files = new Map(Object.entries(ORG_FILES));
  const counts = { deploys: 0, runs: 0 };
  const log = [];
  const seen = { facts: undefined, ready: undefined };
  const state = {};
  const io = {
    readFile: (p) => files.get(p),
    writeFile: (p, s) => files.set(p, s),
    state,
  };
  const facts = {
    tests: new Map(Object.entries(script.tests ?? {})),
    cover: new Map(Object.entries(script.cover ?? {})),
  };
  const tree = () => [...files.values()].join('\n');
  const world = { files, counts, log, seen, io, state, facts };

  const deploy = async (patched) => {
    counts.deploys++;
    if (patched)
      await script.duringDeploy?.({ io, state, files, setup: world.setup });
    const c = (script.compile ?? []).find((x) =>
      files.get(x.file)?.includes(x.marker),
    );
    return c ? { file: c.file, line: c.line, message: c.message } : undefined;
  };
  const runTests = (tests) => {
    counts.runs++;
    const text = tree();
    const rows = tests.map((test) => ({
      test,
      outcome: (script.fails?.[test] ?? []).some((m) => text.includes(m))
        ? 'fail'
        : 'pass',
    }));
    for (const o of script.orphan ?? [])
      if (text.includes(o.marker)) rows.push({ test: o.test, outcome: 'fail' });
    return {
      rows,
      complete: !(script.cut ?? []).some((m) => text.includes(m)),
    };
  };
  const attempt = async (members) => {
    applyPatch(
      members.map((m) => m.entry),
      io,
      state,
    );
    let out;
    try {
      const compile = await deploy(true);
      const run = compile
        ? { rows: [], complete: true, compile }
        : runTests(members.flatMap((m) => m.tests));
      out = attribute(
        {
          key: members[0].entry.id,
          entries: members.map((m) => m.entry),
          members,
        },
        run,
      );
    } finally {
      restorePatch(state, io);
    }
    return out;
  };
  const soloMember = (entry) => ({
    entry,
    tests: facts.tests.get(entry.id) ?? [],
    cover: [],
    span: facts.cover.get(entry.id)?.span ?? {
      file: entry.file,
      start: 1,
      end: 1,
    },
  });
  const failed = (m, detail) => ({ id: m.entry.id, status: 'error', detail });

  const harness = {
    name: 'org',
    order: 1,
    claims: (e) => e.file.startsWith('org/'),
    open: async () => {
      log.push('open');
      counts.deploys++;
      counts.runs++;
      const baselines = new Map([[TEST_CMD, { code: 0, out: '' }]]);
      for (const t of script.red ?? [])
        baselines.set(t, { code: 1, out: 'red' });
      return { baselines, facts };
    },
    group: (entries, opened) => {
      log.push('group');
      seen.facts = opened.facts;
      seen.ready = entries.map((e) => e.id);
      return disjointGroups(
        entries,
        (e) => opened.facts.tests.get(e.id) ?? null,
        (e) => opened.facts.cover.get(e.id) ?? null,
      );
    },
    run: async (groups, _io, emit) => {
      log.push('run');
      for (const g of groups) {
        let todo =
          g.solo === undefined ? g.members : [soloMember(g.entries[0])];
        while (todo.length > 0) {
          const out = await attempt(todo);
          if (out.solo === undefined) {
            for (const r of out.results) emit(r, g.key);
            todo = out.redeploy ?? [];
          } else if (todo.length === 1) {
            emit(failed(todo[0], out.solo), g.key);
            todo = [];
          } else {
            for (const m of todo) {
              const one = await attempt([m]);
              if (one.solo !== undefined) emit(failed(m, one.solo), g.key);
              else for (const r of one.results) emit(r, g.key);
            }
            todo = [];
          }
        }
      }
      return {};
    },
    close: async () => {
      log.push('close');
      counts.deploys++;
      return {};
    },
  };
  world.harness = harness;
  world.setup = resolveSetup({
    packs: [{ name: 'org', mutationKinds: {}, mutationHarnesses: [harness] }],
  });
  return world;
}
