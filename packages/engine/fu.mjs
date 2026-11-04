import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_COMMANDS } from './config.mjs';

export const ID_RE = /^FU(\d+)([a-z]?)(?: \(([^)]+)\))?$/;
export const KEYS = ['id', 'status', 'severity', 'owner', 'fixed-in'];

const WORDS = /^(true|false|yes|no|on|off|null|y|n)$/i;

export function fileIdOf(id) {
  const m = /^(FU\d+[a-z]?)(?: \((.+)\))?$/.exec(id);
  if (!m) return id;
  return m[2] === undefined ? m[1] : `${m[1]}-${m[2]}`;
}

export function idOfFileId(fileId) {
  const m = /^(FU\d+[a-z]?)(?:-(.+))?$/.exec(fileId);
  if (!m) return fileId;
  return m[2] === undefined ? m[1] : `${m[1]} (${m[2]})`;
}

function needsQuote(value) {
  return (
    !/^[A-Za-z(]/.test(value) ||
    value.includes(': ') ||
    value.includes(' #') ||
    /[\t\r\n]/.test(value) ||
    /[:\s]$/.test(value) ||
    WORDS.test(value)
  );
}

function decode(raw, lineNo) {
  if (raw.startsWith('"')) {
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      throw new Error(`line ${lineNo} does not parse: bad double-quoted value`);
    }
    if (typeof v !== 'string')
      throw new Error(`line ${lineNo} does not parse: not a string`);
    return v;
  }
  if (raw.startsWith("'"))
    throw new Error(
      `line ${lineNo}: single quotes are not supported; use double quotes`,
    );
  return raw;
}

export function parseFile(text) {
  if (!text.startsWith('---\n')) throw new Error('no frontmatter');
  const lines = text.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) throw new Error('no frontmatter: closing --- is missing');
  const data = {};
  const keys = [];
  for (let i = 1; i < close; i++) {
    const m = /^([a-z][a-z-]*): (.+)$/s.exec(lines[i]);
    if (!m) throw new Error(`line ${i + 1} does not parse`);
    if (m[1] in data) throw new Error(`line ${i + 1}: repeated key ${m[1]}`);
    data[m[1]] = decode(m[2], i + 1);
    keys.push(m[1]);
  }
  let body = lines.slice(close + 1).join('\n');
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return { data, keys, body };
}

export function serialiseFile({ id, status, severity, owner, fixedIn, body }) {
  const values = {
    id,
    status,
    severity,
    owner,
    'fixed-in': fixedIn,
  };
  let out = '---\n';
  for (const key of KEYS) {
    const value = values[key];
    if (value === undefined || value === null || value === '') continue;
    out += `${key}: ${needsQuote(value) ? JSON.stringify(value) : value}\n`;
  }
  return `${out}---\n${body}\n`;
}

const notTrailing = (id) =>
  new Error(`${id}: Owner/Fixed in not trailing; migrate by hand`);

export function parseRow(line) {
  const m =
    /^- \[( |x)\] \*\*(FU\d+[a-z]?(?: \([^)]+\))?)\*\*(?: \(([^)]*)\))? (.*)$/.exec(
      line,
    );
  if (!m) throw new Error(`not a row: ${line.slice(0, 60)}`);
  const [, box, id, severity, rest] = m;
  const count = (s) => rest.split(s).length - 1;
  const fAt = rest.indexOf('. Fixed in: ');
  const oAt = rest.indexOf('. Owner: ');
  const trailing =
    count('Fixed in:') === (fAt === -1 ? 0 : 1) &&
    count('Owner:') === (oAt === -1 ? 0 : 1) &&
    (fAt === -1 || oAt === -1 || oAt < fAt);
  if (!trailing) throw notTrailing(id);
  let work = rest;
  let fixedIn;
  if (fAt !== -1) {
    fixedIn = work.slice(fAt + '. Fixed in: '.length);
    work = work.slice(0, fAt + 1);
  }
  let owner;
  if (oAt !== -1) {
    owner = work.slice(oAt + '. Owner: '.length);
    work = work.slice(0, oAt + 1);
  }
  const row = { id, status: box === 'x' ? 'done' : 'open' };
  if (severity !== undefined) row.severity = severity;
  if (owner !== undefined) row.owner = owner;
  if (fixedIn !== undefined) row.fixedIn = fixedIn;
  row.body = work;
  return row;
}

export function toRow(text) {
  const { data, body } = parseFile(text);
  return (
    `- [${data.status === 'done' ? 'x' : ' '}] **${data.id}**` +
    (data.severity ? ` (${data.severity})` : '') +
    ` ${body}` +
    (data.owner ? ` Owner: ${data.owner}` : '') +
    (data['fixed-in'] ? ` Fixed in: ${data['fixed-in']}` : '')
  );
}

export function compareIds(a, b) {
  const pa = ID_RE.exec(a);
  const pb = ID_RE.exec(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (Number(pa[1]) !== Number(pb[1])) return Number(pa[1]) - Number(pb[1]);
  if (pa[2] !== pb[2]) return pa[2] < pb[2] ? -1 : 1;
  const sa = pa[3] ?? '';
  const sb = pb[3] ?? '';
  if (sa === sb) return 0;
  if (sa === '') return -1;
  if (sb === '') return 1;
  return sa < sb ? -1 : 1;
}

function cut(s, n) {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

export function summaryOf(body, max) {
  return cut(body.split(/\.(?:\s|$)/)[0].replaceAll('`', ''), max);
}

export function readFollowUps(dir) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

function parseArgs(args, valueFlags, boolFlags) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) {
      if (i + 1 >= args.length) return { error: `${a} needs a value` };
      flags[a] = args[++i];
    } else if (boolFlags.includes(a)) flags[a] = true;
    else if (a.startsWith('--')) return { error: `unknown flag ${a}` };
    else positional.push(a);
  }
  return { flags, positional };
}

const usage = (fuCmd) =>
  `usage: ${fuCmd} list [--all] [--status open|done] [--owner <s>] | show <id> | next | close <id> --by <TICKET> --sha <sha>`;

/**
 * `dir` is where the files are; `label` (default `dir`) is how messages name it; `fuCmd` is the
 * command a message tells the reader to run (the project's `commands.fu`).
 */
export function run(
  argv,
  { dir, out, err, label = dir, fuCmd = DEFAULT_COMMANDS.fu },
) {
  const USAGE = usage(fuCmd);
  const [cmd, ...args] = argv;
  const load = () => {
    const items = [];
    for (const f of readFollowUps(dir)) {
      try {
        items.push({ ...f, ...parseFile(f.text) });
      } catch (e) {
        err(`${label}/${f.name}: ${e.message}`);
        return null;
      }
    }
    return items;
  };
  const find = (items, id) =>
    items.find(
      (f) =>
        f.data.id === id ||
        f.name === `${id}.md` ||
        fileIdOf(id) + '.md' === f.name,
    );

  if (cmd === 'list') {
    const p = parseArgs(args, ['--status', '--owner'], ['--all']);
    if (p.error || p.positional.length) {
      err(p.error ?? USAGE);
      return 2;
    }
    const status = p.flags['--status'];
    if (status !== undefined && status !== 'open' && status !== 'done') {
      err('--status must be open or done');
      return 2;
    }
    const items = load();
    if (!items) return 1;
    const owner = p.flags['--owner']?.toLowerCase();
    items
      .filter((f) =>
        status === undefined
          ? p.flags['--all'] || f.data.status === 'open'
          : f.data.status === status,
      )
      .filter(
        (f) =>
          owner === undefined ||
          (f.data.owner ?? '').toLowerCase().includes(owner),
      )
      .sort((a, b) => compareIds(a.data.id, b.data.id))
      .forEach((f) =>
        out(
          [
            f.data.id,
            f.data.severity ?? '-',
            cut(f.data.owner ?? '-', 60),
            summaryOf(f.body, 100),
          ].join('\t'),
        ),
      );
    return 0;
  }

  if (cmd === 'show') {
    if (args.length !== 1) {
      err(USAGE);
      return 2;
    }
    const items = load();
    if (!items) return 1;
    const f = find(items, args[0]);
    if (!f) {
      err(`show: no follow-up ${args[0]} in ${label}/`);
      return 1;
    }
    out(f.text.replace(/\n$/, ''));
    return 0;
  }

  if (cmd === 'next') {
    if (args.length) {
      err(USAGE);
      return 2;
    }
    let max = 0;
    for (const f of readFollowUps(dir)) {
      const m = /^FU(\d+)/.exec(f.name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    out(`FU${max + 1}`);
    return 0;
  }

  if (cmd === 'close') {
    const p = parseArgs(args, ['--by', '--sha'], []);
    if (
      p.error ||
      p.positional.length !== 1 ||
      !p.flags['--by'] ||
      !p.flags['--sha']
    ) {
      err(p.error ?? 'close needs <id> --by <TICKET> --sha <sha>');
      return 2;
    }
    const items = load();
    if (!items) return 1;
    const f = find(items, p.positional[0]);
    if (!f) {
      err(`close: no follow-up ${p.positional[0]} in ${label}/`);
      return 1;
    }
    const { data } = f;
    const alreadyDone = data.status === 'done';
    if (alreadyDone) {
      err(`close: ${data.id} is already done (fixed-in: ${data['fixed-in']})`);
      return 1;
    }
    const fixedIn = `${p.flags['--by']} (${p.flags['--sha']}).`;
    const path = join(dir, f.name);
    writeFileSync(
      path,
      serialiseFile({
        id: data.id,
        status: 'done',
        severity: data.severity,
        owner: data.owner,
        fixedIn,
        body: f.body,
      }),
    );
    out(`closed ${data.id}: ${fixedIn}`);
    return 0;
  }

  err(USAGE);
  return 2;
}

const STATUSES = ['open', 'done'];
const POINTER_ROW = /^- \[[ xX]\] \*\*FU/m;

/** Numbers named in the README sentence that says which ids were minted twice. */
function grandfathered(readme) {
  const head = readme.split(/^## Collisions \/ ambiguities/m)[0];
  const sentence =
    head.split('\n').find((l) => /minted twice|used twice/.test(l)) ?? '';
  const nums = new Set();
  for (const m of sentence.matchAll(/FU(\d+)(?:-FU(\d+))?/g)) {
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    for (let n = lo; n <= hi; n++) nums.add(n);
  }
  return nums;
}

/** `dir` is the register folder as the messages name it; `pointerPath` the pointer page's path. */
export function checkFollowUps({
  files,
  readme,
  pointer,
  dir,
  pointerPath,
  fuCmd = DEFAULT_COMMANDS.fu,
}) {
  const errors = [];
  const README = `${dir}/README.md`;
  const at = (name) => `${dir}/${name}`;
  if (readme === null) errors.push(`${README} is missing`);
  const exempt = grandfathered(readme ?? '');
  const seen = new Map(); // number -> [{ id, suffixed }]

  for (const { name, text } of files) {
    let parsed;
    try {
      parsed = parseFile(text);
    } catch (e) {
      errors.push(
        `${at(name)}: ${e.message}; start the file with a --- frontmatter block as ${README} shows.`,
      );
      continue;
    }
    const { data, keys } = parsed;
    for (const key of keys) {
      if (!KEYS.includes(key))
        errors.push(
          `${at(name)}: unknown key "${key}"; allowed keys are ${KEYS.join(', ')}.`,
        );
    }
    const { id, status } = data;
    if (!STATUSES.includes(status))
      errors.push(
        `${at(name)}: status is ${status === undefined ? 'missing' : `"${status}"`}; use "open" or "done".`,
      );
    if (status === 'open' && data.owner === undefined)
      errors.push(
        `${at(name)}: open with no "owner:": add "owner: <ticket or role>" (or "owner: none" with a reason).`,
      );
    if (status === 'done' && data['fixed-in'] === undefined)
      errors.push(
        `${at(name)}: done with no "fixed-in:": add "fixed-in: <ticket> (<sha>)" or say why it was closed without a fix (\`${fuCmd} close\` sets it).`,
      );

    const m = id === undefined ? null : ID_RE.exec(id);
    if (!m) {
      errors.push(
        `${at(name)}: id ${id === undefined ? 'is missing' : `"${id}"`} does not look like FU<n>, FU<n><letter> or FU<n> (<ticket>).`,
      );
      continue;
    }
    if (name !== `${fileIdOf(id)}.md`)
      errors.push(
        `${at(name)}: the file is named for the wrong id; id ${id} belongs in ${fileIdOf(id)}.md (rename the file or fix the id).`,
      );

    const num = Number(m[1]);
    const suffixed = Boolean(m[3]);
    if (exempt.has(num)) continue;
    const list = seen.get(num) ?? [];
    const dup = list.find(
      (o) =>
        o.id === id ||
        (o.id.replace(/ \(.*\)$/, '') === id.replace(/ \(.*\)$/, '') &&
          (!o.suffixed || !suffixed)),
    );
    if (dup)
      errors.push(
        `${at(name)}: ${id} duplicates ${dup.id}: take the id \`${fuCmd} next\` prints, or disambiguate both as FUnn (<ticket>) and record the collision in ${README}.`,
      );
    list.push({ id, suffixed });
    seen.set(num, list);
  }

  if (pointer !== null && POINTER_ROW.test(pointer))
    errors.push(
      `${pointerPath} holds a follow-up row: rows live one per file in ${dir}/; move it there (\`${fuCmd} next\` gives the id) and leave the page a pointer.`,
    );
  return errors;
}

/** The `check:follow-ups` command: `followUps` is the config slot; returns the exit code. */
export function runCheck(
  root,
  followUps,
  { out, err, fuCmd = DEFAULT_COMMANDS.fu },
) {
  const read = (rel) =>
    existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null;
  const errors = checkFollowUps({
    files: readFollowUps(join(root, followUps.dir)),
    readme: read(`${followUps.dir}/README.md`),
    pointer: followUps.pointer ? read(followUps.pointer) : null,
    dir: followUps.dir,
    pointerPath: followUps.pointer,
    fuCmd,
  });
  if (errors.length === 0) {
    out('check:follow-ups OK');
    return 0;
  }
  err(`check:follow-ups FAILED (${errors.length}):`);
  for (const e of errors) err(`  ${e}`);
  return 1;
}
