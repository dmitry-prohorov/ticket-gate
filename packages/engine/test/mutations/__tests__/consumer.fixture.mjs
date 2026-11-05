// A consumer fixture for the ported mutation tests: the Setup a project would hand
// to `resolveSetup`, written with the demo names of demo.fixture.mjs. The moved tests
// call the engine with the default `projectSetup()`, so the helpers bind this one at
// import (`bindSetup(resolveSetup(consumerConfig()))`). Nothing here names a real
// consumer; the values are the shape of a Next + Supabase monorepo.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { resolveSetup } from '../../../mutations/kinds.mjs';
import { bindSetup } from '../../../mutations/project.mjs';
import * as pack from '../../../../supabase-next/mutations/pack.mjs';
import { DEMO, demoRebuild } from './demo.fixture.mjs';

export const REGISTRY_DIR = 'tools/mutation-registry';
export const REGISTRY_RECEIPT_REL = '.turbo/mutation-registry.json';
export const ENTRY_FIELDS = Object.freeze([
  'kind',
  'protects',
  'object',
  'file',
  'within',
  'find',
  'replace',
  'apply',
  'restore',
  'test',
  'testFile',
  'testName',
  'from',
  'title',
  'why',
  'retired',
  'reaimed',
]);

const SERVED = /(?:-F|--filter)[ =]web\b.*\bplaywright test\b/;

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

// Patch entries: tools/<f> files get their own area; everything else its directory.
function area(entry) {
  const dir = dirname(entry.file);
  if (dir === 'tools') {
    const base = basename(entry.file);
    const ext = extname(base);
    return `${REGISTRY_DIR}/tools/${ext ? base.slice(0, -ext.length) : base}.json`;
  }
  if (dir === '.') return `${REGISTRY_DIR}/_root.json`;
  return `${REGISTRY_DIR}/${dir}.json`;
}

/** A guard no test bites, kept on the books with a reason; never run. */
const unguarded = {
  name: 'unguarded',
  runs: false,
  fields: ['from', 'title', 'why'],
  shape(e) {
    const out = [];
    for (const f of ['from', 'title', 'why'])
      if (!isStr(e[f])) out.push(`${f} must be a non-empty string`);
    return out;
  },
  // `from` is checked on an entry of any kind (it was, before the kind dispatch).
  strays(e) {
    return e.from !== undefined && !/^e2e\/.+\.spec\.ts$/.test(String(e.from))
      ? ['from must match e2e/<...>.spec.ts']
      : [];
  },
  area: (e, dir = REGISTRY_DIR) =>
    `${dir}/${dirname(`apps/web/${e.from}`)}.json`,
};

const gitAt = (root, args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const lineOf = (text, needle) => {
  const i = text.indexOf(needle);
  return i === -1 ? 1 : text.slice(0, i).split('\n').length;
};

// The registry before it moved to tools/mutation-registry/: one
// docs/tasks/contracts/<ID>.mutations.json per ticket (not `.old.`).
const legacy = {
  files(root) {
    let names;
    try {
      names = readdirSync(join(root, 'docs/tasks/contracts'));
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.mutations.json') && !n.includes('.old.'))
      .sort()
      .map((n) => `docs/tasks/contracts/${n}`);
  },
  /** { entries: Map<key, { path, line, entry }>, errors } of the legacy files at a git ref. */
  atRef(ref, root) {
    const entries = new Map();
    const errors = [];
    const paths = gitAt(root, [
      'ls-tree',
      '-r',
      '-z',
      '--name-only',
      ref,
      '--',
      'docs/tasks/contracts',
    ])
      .split('\0')
      .filter(Boolean)
      .filter((p) => p.endsWith('.mutations.json') && !p.includes('.old.'));
    for (const p of paths) {
      const text = gitAt(root, ['show', `${ref}:${p}`]);
      let spec;
      try {
        spec = JSON.parse(text);
      } catch (err) {
        errors.push(`${p}: not valid JSON (${err.message})`);
        continue;
      }
      const ticket = basename(p).replace(/\.mutations\.json$/, '');
      for (const m of spec?.mutations ?? []) {
        if (typeof m?.id !== 'string') continue;
        const { id, ...entry } = m;
        const key = `${ticket}/${id}`;
        if (entries.has(key)) {
          errors.push(`${p}: duplicate key ${key}`);
          continue;
        }
        entries.set(key, {
          path: p,
          line: lineOf(text, `"id": "${id}"`),
          entry,
        });
      }
    }
    return { entries, errors };
  },
};

export function consumerConfig() {
  return {
    dir: REGISTRY_DIR,
    receipts: {
      ticket: '.turbo/mutation-check.json',
      registry: REGISTRY_RECEIPT_REL,
    },
    area,
    fieldOrder: ENTRY_FIELDS,
    legacy,
    rebuild: [demoRebuild],
    childEnv: { drop: [DEMO.dropEnv] },
    reuseEnv: { [DEMO.reuseEnv]: '1' },
    kinds: { unguarded },
    commands: {
      mutate: 'pnpm mutate:check',
      checkMutations: 'pnpm check:mutations',
      // A backtick literal, as the real config writes its shim path.
      checkMutationsScript: `node tools/check-mutations.mjs`,
      afterFatal: 'run pnpm db:reset',
      restoreHint: 'git checkout on the file or pnpm db:reset',
    },
    packs: [
      {
        name: 'supabase-next',
        mutationKinds: pack.mutationKinds,
        mutationHarnesses: pack.mutationHarnesses({
          port: 3000,
          env: DEMO.serverEnv,
          build: 'pnpm -F web build',
          start: 'pnpm -F web start',
          skipBuild: 'apps/web/e2e/',
          claims: SERVED,
          defer: {
            label: 'Playwright-backed',
            to: 'the nightly rotation (tools/nightly-e2e.mjs)',
          },
        }),
      },
    ],
  };
}

/** Resolve and bind the consumer Setup; the helpers call this once at import. */
export const bindConsumer = () => bindSetup(resolveSetup(consumerConfig()));
