// DS-1..DS-12. No stack, no docker: every run reads the fixtures in
// fixtures/db-schema/ and writes under os.tmpdir().

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { GENERATED_HEADER, renderCron } from './__tests__/db-schema-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '__tests__', 'db-schema-cli.mjs');
const DUMP = join(HERE, 'fixtures/db-schema/dump.sql');
const CRON = join(HERE, 'fixtures/db-schema/cron.json');
const FIXTURE = readFileSync(DUMP, 'utf8');

const scratch = mkdtempSync(join(tmpdir(), 'db-schema-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function tmp(label) {
  counter += 1;
  const dir = join(scratch, `${label}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run({ dump = DUMP, cron = CRON, out }) {
  const r = spawnSync(
    process.execPath,
    [TOOL, `--dump=${dump}`, `--cron=${cron}`, `--out=${out}`],
    { encoding: 'utf8' },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function dumpWith(extra) {
  const file = join(tmp('dump'), 'dump.sql');
  writeFileSync(file, `${FIXTURE}\n${extra}\n`);
  return file;
}

function entry(name, type, schema, body) {
  return `--\n-- Name: ${name}; Type: ${type}; Schema: ${schema}; Owner: postgres\n--\n\n${body}\n`;
}

function files(dir, base = '') {
  const out = {};
  for (const d of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isDirectory()) Object.assign(out, files(dir, rel));
    else out[rel] = readFileSync(join(dir, rel), 'utf8');
  }
  return out;
}

function generated() {
  const out = tmp('gen');
  const r = run({ out });
  assert.equal(r.code, 0, r.stderr);
  return { out, tree: files(out) };
}

const headerLines = (text) =>
  text.split('\n').filter((l) => l.startsWith('-- Name: '));

describe('db-schema', () => {
  test('DS-1 every TOC entry lands in exactly one file', () => {
    const { tree } = generated();
    const want = headerLines(FIXTURE);
    const got = Object.entries(tree)
      .filter(([p]) => p !== 'cron/jobs.sql')
      .flatMap(([, text]) => headerLines(text));
    assert.ok(want.length >= 30, 'the fixture is too thin to bite');
    assert.equal(got.length, want.length);
    assert.deepEqual([...got].sort(), [...want].sort());
    for (const line of want) {
      const holders = Object.values(tree).filter((t) =>
        t.split('\n').includes(line),
      );
      assert.equal(
        holders.length,
        1,
        `'${line}' is in ${holders.length} files`,
      );
    }
  });

  test('DS-2 an unknown type exits 1 naming it and leaves out untouched', () => {
    const out = tmp('seeded');
    mkdirSync(join(out, 'tables'));
    writeFileSync(join(out, 'tables/public.old.sql'), 'old\n');
    const before = files(out);
    const r = run({
      dump: dumpWith(
        entry('v', 'VIEW', 'public', 'CREATE VIEW public.v AS SELECT 1;'),
      ),
      out,
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /VIEW/);
    assert.match(r.stderr, /'v'/);
    assert.deepEqual(files(out), before);
  });

  test('DS-3 an index or policy with no table exits 1 naming the entry', () => {
    const index = run({
      dump: dumpWith(
        entry(
          'nope_idx',
          'INDEX',
          'public',
          'CREATE INDEX nope_idx ON public.nope USING btree (a);',
        ),
      ),
      out: tmp('idx'),
    });
    assert.equal(index.code, 1);
    assert.match(index.stderr, /INDEX/);
    assert.match(index.stderr, /nope_idx/);

    const policy = run({
      dump: dumpWith(
        entry(
          'nope p',
          'POLICY',
          'public',
          'CREATE POLICY p ON public.nope USING (true);',
        ),
      ),
      out: tmp('pol'),
    });
    assert.equal(policy.code, 1);
    assert.match(policy.stderr, /POLICY/);
    assert.match(policy.stderr, /nope p/);
  });

  test('DS-4 no per-run noise, no trailing blanks, one final newline', () => {
    const { tree } = generated();
    const noise =
      /\\restrict|\\unrestrict|-- Dumped |-- PostgreSQL database dump|^SET |set_config/;
    for (const [path, text] of Object.entries(tree)) {
      for (const line of text.split('\n')) {
        assert.doesNotMatch(line, noise, `${path}: ${line}`);
        assert.doesNotMatch(line, /[ \t]$/, `${path}: trailing blank`);
      }
      assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), path);
    }
    assert.ok(FIXTURE.includes('\\restrict'), 'the fixture lost its noise');
  });

  test('DS-5 overloads share a file in named-signature order (argument names, not types, decide it) with their own COMMENT and ACL', () => {
    const { tree } = generated();
    const text = tree['functions/private.has_family_role.sql'];
    assert.ok(text, 'one file for both overloads');
    assert.deepEqual(
      headerLines(text).map((l) => l.replace(/^-- Name: /, '')),
      [
        'has_family_role(uuid, public.member_role[]); Type: FUNCTION; Schema: private; Owner: postgres',
        'FUNCTION has_family_role(p_family_id uuid, p_roles public.member_role[]); Type: ACL; Schema: private; Owner: postgres',
        'has_family_role(uuid); Type: FUNCTION; Schema: private; Owner: postgres',
        'FUNCTION has_family_role(p_user_family uuid); Type: COMMENT; Schema: private; Owner: postgres',
        'FUNCTION has_family_role(p_user_family uuid); Type: ACL; Schema: private; Owner: postgres',
      ],
    );
    const fixtureOrder = headerLines(FIXTURE).filter((l) =>
      l.includes('has_family_role'),
    );
    assert.match(
      fixtureOrder[0],
      /has_family_role\(uuid\)/,
      'fixture must list the overloads in the order the sort does not produce',
    );
  });

  test('DS-6 table-bound entries sit in the table file', () => {
    const { tree } = generated();
    const text = tree['tables/public.notification_prefs.sql'];
    for (const needle of [
      'Type: TABLE;',
      'Type: POLICY;',
      'Type: TRIGGER;',
      'Type: INDEX;',
      'Type: FK CONSTRAINT;',
      'Type: ROW SECURITY;',
      'Type: DEFAULT;',
      'Type: CONSTRAINT;',
      'Name: COLUMN notification_prefs.notify_parents; Type: COMMENT',
      'Name: COLUMN notification_prefs.push_enabled; Type: ACL',
      'Name: TABLE notification_prefs; Type: ACL',
      'Name: POLICY notification_prefs_all ON notification_prefs; Type: COMMENT',
      'Name: TRIGGER notification_prefs_updated_at ON notification_prefs; Type: COMMENT',
      'Name: CONSTRAINT notification_prefs_pkey ON notification_prefs; Type: COMMENT',
      'Name: SEQUENCE notification_prefs_seq_seq; Type: ACL',
      'Type: SEQUENCE OWNED BY;',
    ]) {
      assert.ok(text.includes(needle), `missing ${needle}`);
    }
    assert.equal(
      Object.keys(tree).filter((p) => p.startsWith('tables/')).length,
      1,
    );
  });

  test('DS-7 a stale file and an empty directory are removed', () => {
    const out = tmp('stale');
    mkdirSync(join(out, 'tables'));
    mkdirSync(join(out, 'x'));
    writeFileSync(join(out, 'tables/public.gone.sql'), 'gone\n');
    const r = run({ out });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(join(out, 'tables/public.gone.sql')));
    assert.ok(!existsSync(join(out, 'x')));
    assert.match(r.stdout, /1 deleted/);
  });

  test('DS-8 two runs into one directory are byte-identical', () => {
    const out = tmp('twice');
    assert.equal(run({ out }).code, 0);
    const first = files(out);
    const r = run({ out });
    assert.equal(r.code, 0);
    assert.deepEqual(files(out), first);
    assert.match(r.stdout, /0 deleted/);
  });

  test('DS-9 a dump with no table exits 1 and leaves out untouched', () => {
    const schemasOnly = join(tmp('dump'), 'dump.sql');
    writeFileSync(
      schemasOnly,
      entry('public', 'SCHEMA', '-', 'CREATE SCHEMA public;'),
    );
    const out = tmp('keep');
    mkdirSync(join(out, 'tables'));
    writeFileSync(join(out, 'tables/public.events.sql'), 'keep\n');
    const before = files(out);
    const r = run({ dump: schemasOnly, out });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /pnpm db:reset/);
    assert.deepEqual(files(out), before);
  });

  test('DS-10 renderCron sorts by jobname, doubles quotes, rejects $$', () => {
    const text = renderCron([
      { jobname: 'b', schedule: '* * * * *', command: 'select 1' },
      { jobname: "a'x", schedule: "0 '3' * * *", command: 'select 2' },
    ]);
    const lines = text
      .split('\n')
      .filter((l) => l.startsWith('select cron.schedule'));
    assert.deepEqual(lines, [
      "select cron.schedule('a''x', '0 ''3'' * * *', $$select 2$$);",
      "select cron.schedule('b', '* * * * *', $$select 1$$);",
    ]);
    assert.throws(
      () =>
        renderCron([
          {
            jobname: 'bad-job',
            schedule: '* * * * *',
            command: 'select $$x$$',
          },
        ]),
      /bad-job/,
    );
  });

  test('DS-11 schema, type and default-ACL entries follow the R4 layout', () => {
    const { tree } = generated();
    const layout =
      /^(?:schemas\/[a-z_]+|types\/[a-z_]+|tables\/[a-z_]+\.[a-z_]+|functions\/[a-z_]+\.[a-z_]+|cron\/jobs)\.sql$/;
    for (const path of Object.keys(tree)) assert.match(path, layout);
    const pub = tree['schemas/public.sql'];
    for (const needle of [
      'Type: SCHEMA; Schema: -',
      'Name: SCHEMA public; Type: COMMENT; Schema: -',
      'Name: SCHEMA public; Type: ACL; Schema: -',
      'Type: DEFAULT ACL; Schema: public',
    ]) {
      assert.ok(pub.includes(needle), `schemas/public.sql lacks ${needle}`);
    }
    assert.ok(
      tree['schemas/private.sql'].includes('Name: SCHEMA private; Type: ACL'),
    );
    const types = tree['types/public.sql'];
    for (const needle of ['Type: TYPE;', 'Type: COMMENT;', 'Type: ACL;']) {
      assert.ok(types.includes(needle), `types/public.sql lacks ${needle}`);
    }
  });

  test('DS-12 every file starts with the generated header', () => {
    const { tree } = generated();
    assert.ok(Object.keys(tree).length >= 6);
    for (const [path, text] of Object.entries(tree)) {
      assert.equal(text.split('\n')[0], GENERATED_HEADER, path);
    }
  });

  test('an unknown flag exits 2', () => {
    const r = spawnSync(process.execPath, [TOOL, '--bogus'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
  });
});
