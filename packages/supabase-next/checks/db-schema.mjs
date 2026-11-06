// db-schema pack: writes a read-only, per-object snapshot of the END STATE of the local database
// (schemas public and private, plus cron.job rows), so a reader sees a table, function or policy as it is
// now without replaying the migrations. Generated, never applied, never hand-edited: the migrations stay
// the history, this is the picture.
//
// Every project value (generated header, output folder, tool name, hint commands, usage line) is an
// option of dbSchema(); a project binds them in a CLI shim or through the pack's db-schema command.
//
// run(argv) result: { code, out, err }. code 0 written, 1 error (nothing written or deleted), 2 unknown
// flag. out and err hold the lines for stdout and stderr.
//
// Dependency-free Node ESM, no build step. The dump comes from the stack's own image (docker exec), so no
// host pg_dump is needed.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const RESTRICT = /^(?:--\s*)?\\(?:un)?restrict\b/;
const HEADER =
  /^-- (?:Dumped from database version|Dumped by pg_dump version|PostgreSQL database dump(?: complete)?)/;
// prettier-ignore
const SET_LINE = /^SET (?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout|client_encoding|standard_conforming_strings|check_function_bodies|xmloption|client_min_messages|row_security|default_tablespace|default_table_access_method) = .*;$/;
const SET_CONFIG =
  /^SELECT pg_catalog\.set_config\('search_path', '', false\);$/;
const RESET_ALL = /^RESET ALL;$/;
const TOC =
  /^-- Name: (.+?); Type: (.+?); Schema: (.+?); Owner: (.*?)(?:; Tablespace: .*)?$/;

const IDENT = '"[^"]+"|[A-Za-z0-9_$]+';

function isDropped(line) {
  return (
    RESTRICT.test(line) ||
    HEADER.test(line) ||
    SET_LINE.test(line) ||
    SET_CONFIG.test(line) ||
    RESET_ALL.test(line)
  );
}

function isCommentOrBlank(line) {
  return line.trim() === '' || line.startsWith('--');
}

// Raw pg_dump text -> text without the lines that change from run to run.
// Throws on a stray statement before the first TOC entry.
export function normalise(dump, tool) {
  const lines = dump
    .split('\n')
    .filter((l) => !isDropped(l))
    .map((l) => l.replace(/[ \t]+$/, ''));
  let seenEntry = false;
  for (let i = 0; i < lines.length; i++) {
    if (isTocHeaderAt(lines, i)) seenEntry = true;
    if (!seenEntry && !isCommentOrBlank(lines[i])) {
      throw new Error(
        `unexpected line before the first entry: '${lines[i]}'. Teach normalise() about it in ${tool} if it is pg_dump noise.`,
      );
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

function isTocHeaderAt(lines, i) {
  return (
    i > 0 &&
    i < lines.length - 1 &&
    lines[i - 1] === '--' &&
    lines[i + 1] === '--' &&
    TOC.test(lines[i])
  );
}

// Normalised dump -> one record per TOC entry, in dump order. `text` is the
// whole block, the `--` lines around the header included.
export function parseToc(dump) {
  const lines = dump.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTocHeaderAt(lines, i)) starts.push(i - 1);
  }
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const block = lines.slice(start, end);
    while (
      block.length > 3 &&
      (block[block.length - 1] === '' || block[block.length - 1] === '--')
    ) {
      block.pop();
    }
    const m = TOC.exec(lines[start + 1]);
    return {
      name: m[1],
      type: m[2],
      schema: m[3],
      owner: m[4],
      text: block.join('\n'),
    };
  });
}

function stripQuotes(s) {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

// "schema.table" or "table" (optionally quoted) at the start of s.
function leadingTable(s, defaultSchema) {
  const m = new RegExp(`^(?:(${IDENT})\\.)?(${IDENT})`).exec(s.trim());
  if (!m) return null;
  return {
    schema: m[1] ? stripQuotes(m[1]) : defaultSchema,
    table: stripQuotes(m[2]),
  };
}

function tablePath(schema, table) {
  return `tables/${schema}.${table}.sql`;
}

// Raw pg_dump text -> Map<relPath, content> under OUT_REL. Throws on an entry
// it cannot place (never a silent drop) and on a dump with no table.
export function splitDump(dump, { header, tool, reset }) {
  const entries = parseToc(normalise(dump, tool));
  const tables = new Set();
  const owned = new Map();
  for (const e of entries) {
    if (e.type === 'TABLE') tables.add(`${e.schema}.${e.name}`);
    if (e.type === 'SEQUENCE OWNED BY') {
      const m = /OWNED BY ([^;\s]+)/.exec(e.text);
      const t = m
        ? leadingTable(m[1].replace(/\.[^."]+$/, ''), e.schema)
        : null;
      if (t) owned.set(`${e.schema}.${e.name}`, t);
    }
  }

  const tableFor = (e, t) => {
    if (!t || !tables.has(`${t.schema}.${t.table}`)) {
      throw new Error(`no table for ${e.type} '${e.name}'`);
    }
    return tablePath(t.schema, t.table);
  };
  const onTable = (e, rest) => {
    const m = /(?:^| )ON (.+)$/.exec(rest);
    return tableFor(e, m ? leadingTable(m[1], e.schema) : null);
  };
  const ownerOfSequence = (e, name) =>
    tableFor(e, owned.get(`${e.schema}.${name}`));
  const unknown = (e) => {
    throw new Error(`unknown TOC type '${e.type}' for '${e.name}'`);
  };

  // COMMENT and ACL are routed by the prefix of the object they describe.
  const routeDescribed = (e) => {
    const sp = e.name.indexOf(' ');
    const kind = sp < 0 ? e.name : e.name.slice(0, sp);
    const rest = sp < 0 ? '' : e.name.slice(sp + 1);
    switch (kind) {
      case 'SCHEMA':
        return { path: `schemas/${rest}.sql` };
      case 'TYPE':
        return { path: `types/${e.schema}.sql` };
      case 'TABLE':
        return { path: tableFor(e, { schema: e.schema, table: rest }) };
      case 'COLUMN':
        return {
          path: tableFor(e, {
            schema: e.schema,
            table: stripQuotes(rest.split('.')[0]),
          }),
        };
      case 'SEQUENCE':
        return { path: ownerOfSequence(e, rest) };
      case 'FUNCTION':
        return {
          path: `functions/${e.schema}.${rest.split('(')[0]}.sql`,
          sig: rest,
        };
      case 'POLICY':
      case 'TRIGGER':
      case 'CONSTRAINT':
        return { path: onTable(e, rest) };
      default:
        return unknown(e);
    }
  };

  const route = (e) => {
    switch (e.type) {
      case 'SCHEMA':
        return { path: `schemas/${e.name}.sql` };
      case 'DEFAULT ACL':
        return { path: `schemas/${e.schema}.sql` };
      case 'TYPE':
        return { path: `types/${e.schema}.sql` };
      case 'TABLE':
        return { path: tablePath(e.schema, e.name) };
      case 'DEFAULT':
      case 'CONSTRAINT':
      case 'FK CONSTRAINT':
      case 'TRIGGER':
      case 'POLICY':
        return {
          path: tableFor(e, {
            schema: e.schema,
            table: stripQuotes(
              new RegExp(`^(${IDENT})`).exec(e.name)?.[1] ?? '',
            ),
          }),
        };
      case 'ROW SECURITY':
        return { path: tableFor(e, { schema: e.schema, table: e.name }) };
      case 'INDEX': {
        const m = new RegExp(
          `^CREATE (?:UNIQUE )?INDEX .*? ON (?:ONLY )?((?:${IDENT})(?:\\.(?:${IDENT}))?)`,
          'm',
        ).exec(e.text);
        return { path: tableFor(e, m ? leadingTable(m[1], e.schema) : null) };
      }
      case 'SEQUENCE':
      case 'SEQUENCE OWNED BY':
        return { path: ownerOfSequence(e, e.name) };
      case 'FUNCTION': {
        // The header names the argument types only; COMMENT and ACL headers
        // carry names too. ALTER FUNCTION ... OWNER TO has the latter form.
        const name = e.name.split('(')[0];
        const alter = /^ALTER FUNCTION \S+?(\(.*\)) OWNER TO /m.exec(e.text);
        return {
          path: `functions/${e.schema}.${name}.sql`,
          sig: alter ? `${name}${alter[1]}` : e.name,
        };
      }
      case 'COMMENT':
      case 'ACL':
        return routeDescribed(e);
      default:
        return unknown(e);
    }
  };

  const byPath = new Map();
  for (const e of entries) {
    const { path, sig } = route(e);
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push({ sig, type: e.type, name: e.name, text: e.text });
  }

  const files = new Map();
  for (const [path, items] of byPath) {
    let texts;
    if (path.startsWith('functions/')) {
      const bySig = new Map();
      for (const it of items) {
        if (!bySig.has(it.sig)) bySig.set(it.sig, []);
        bySig.get(it.sig).push(it);
      }
      for (const list of bySig.values()) {
        const orphan = list.find((it) => it.type !== 'FUNCTION');
        if (!list.some((it) => it.type === 'FUNCTION') && orphan) {
          throw new Error(`no function for ${orphan.type} '${orphan.name}'`);
        }
      }
      const group = [...bySig].map(([sig, list]) => ({
        sig,
        list: list.map((it) => it.text),
      }));
      group.sort((a, b) => (a.sig < b.sig ? -1 : a.sig > b.sig ? 1 : 0));
      texts = group.flatMap((g) => g.list);
    } else {
      texts = items.map((it) => it.text);
    }
    files.set(path, `${header}\n\n${texts.join('\n\n')}\n`);
  }
  // prettier-ignore
  if (![...files.keys()].some((p) => p.startsWith('tables/'))) throw new Error(`the dump has no table: run ${reset} first`);
  return files;
}

// cron.job rows -> content of cron/jobs.sql.
export function renderCron(rows, header) {
  const q = (s) => s.replaceAll("'", "''");
  const byJob = [...rows];
  byJob.sort((a, b) =>
    a.jobname < b.jobname ? -1 : a.jobname > b.jobname ? 1 : 0,
  );
  const stmts = byJob.map((row) => {
    // prettier-ignore
    if (row.command.includes('$$')) throw new Error(`cron job '${row.jobname}' command contains $$`);
    return `select cron.schedule('${q(row.jobname)}', '${q(row.schedule)}', $$${row.command}$$);`;
  });
  return `${[header, ...(stmts.length ? ['', stmts.join('\n\n')] : [])].join('\n')}\n`;
}

function listFiles(dir, base = '') {
  const out = [];
  for (const d of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

function pruneEmptyDirs(dir, base = '') {
  for (const d of readdirSync(join(dir, base), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const rel = base ? `${base}/${d.name}` : d.name;
    pruneEmptyDirs(dir, rel);
    if (readdirSync(join(dir, rel)).length === 0) rmdirSync(join(dir, rel));
  }
}

// Makes outDir hold exactly `files` (Map<relPath, content>).
export function writeSnapshot(outDir, files) {
  mkdirSync(outDir, { recursive: true });
  const stale = listFiles(outDir)
    .filter((rel) => !files.has(rel))
    .sort();
  for (const rel of stale) rmSync(join(outDir, rel));
  const written = [...files.keys()].sort();
  for (const rel of written) {
    const target = join(outDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, files.get(rel));
  }
  pruneEmptyDirs(outDir);
  return { written, deleted: stale };
}

function projectId(root) {
  const toml = readFileSync(join(root, 'supabase/config.toml'), 'utf8');
  const m = /^project_id\s*=\s*"([^"]+)"/m.exec(toml);
  if (!m) throw new Error('no project_id in supabase/config.toml');
  return m[1];
}

function dockerExec(root, args, start, reset) {
  const container = `supabase_db_${projectId(root)}`;
  try {
    return execFileSync('docker', ['exec', container, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `could not read the database from container ${container}: ${String(err.stderr || err.message).trim()}. Is the stack up? Run ${start}, then ${reset}.`,
    );
  }
}

export function readDumpFromStack(root, start, reset) {
  return dockerExec(
    root,
    [
      'pg_dump',
      '-U',
      'postgres',
      '--schema-only',
      '--schema=public',
      '--schema=private',
    ],
    start,
    reset,
  );
}

export function readCronFromStack(root, start, reset) {
  const out = dockerExec(
    root,
    [
      'psql',
      '-U',
      'postgres',
      '-tAc',
      "select coalesce(json_agg(j), '[]'::json) from (select jobname, schedule, command from cron.job order by jobname) j",
    ],
    start,
    reset,
  ).trim();
  return JSON.parse(out === '' ? '[]' : out);
}

// Builds every file in memory; nothing touches disk until this returned.
export function buildSnapshot(dump, cronRows, opts) {
  const files = splitDump(dump, opts);
  files.set('cron/jobs.sql', renderCron(cronRows, opts.header));
  return files;
}

function parseArgs(argv) {
  const opts = {};
  for (const a of argv) {
    const m = /^--(dump|cron|out)=(.+)$/.exec(a);
    if (!m) return null;
    opts[m[1]] = m[2];
  }
  return opts;
}

// root: the repo folder; out: snapshot folder relative to root; header: first line of every file;
// tool: the CLI path named in the normalise() message; name: the prefix of every output line;
// usage: the line printed on an unknown flag; start, reset: the hint commands in error messages.
export function dbSchema({
  root,
  out,
  header,
  tool,
  name,
  usage,
  start,
  reset,
}) {
  const opts = { header, tool, reset };
  return {
    renderCron: (rows) => renderCron(rows, header),
    buildSnapshot: (dump, cron) => buildSnapshot(dump, cron, opts),
    run(argv) {
      const args = parseArgs(argv);
      if (!args) return { code: 2, out: [], err: [usage] };
      const started = Date.now();
      try {
        const dump = args.dump
          ? readFileSync(args.dump, 'utf8')
          : readDumpFromStack(root, start, reset);
        const cron = args.cron
          ? JSON.parse(readFileSync(args.cron, 'utf8'))
          : readCronFromStack(root, start, reset);
        const files = buildSnapshot(dump, cron, opts);
        const outDir = args.out ?? join(root, out);
        const { written, deleted } = writeSnapshot(outDir, files);
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        return {
          code: 0,
          out: [
            `${name}: ${written.length} files written, ${deleted.length} deleted in ${secs}s`,
          ],
          err: [],
        };
      } catch (err) {
        return { code: 1, out: [], err: [`${name}: ${err.message}`] };
      }
    },
  };
}
