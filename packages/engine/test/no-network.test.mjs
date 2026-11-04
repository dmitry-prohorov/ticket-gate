// INFRA-47 5-7: the hooks make no network call (proposal 4.11). The walker reads the
// real hook entry points, follows every relative import (static, re-export, or a
// dynamic import with a literal path) and reports, for each module reached:
//   - a network builtin (http, https, http2, net, tls, dgram; with or without node:),
//   - a bare package (a dependency would be code this repo does not own),
//   - fetch( or new WebSocket,
//   - an import( whose argument is not a string literal.
// It tokenises (strings, comments, template literals, regex literals) so text that
// merely mentions these words does not count and a call inside ${ } does.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const ENGINE = join(import.meta.dirname, '..');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'no-network');

const NETWORK = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram']);

// The two non-literal imports the real closure needs: config.mjs and project.mjs load the
// consuming project's own gate.config.mjs from a local path. Anything else, or the same
// call with another argument, is reported.
const ALLOWED_DYNAMIC = [
  { file: 'config.mjs', arg: 'pathToFileURL(file).href' },
  { file: 'project.mjs', arg: 'pathToFileURL(join(root,gate.config.mjs)).href' },
];

const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
]);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new']);

/** Source text -> [{ t: 'str' | 'word' | 'punct', v }] with comments dropped. */
export function tokenize(src) {
  const out = [];
  const braces = []; // one entry per open `${`: the brace depth to return to
  let depth = 0;
  let i = 0;
  const last = () => out[out.length - 1];
  const regexAllowed = () => {
    const p = last();
    if (!p) return true;
    if (p.t === 'punct') return p.v !== ')' && p.v !== ']';
    return p.t === 'word' && REGEX_KEYWORDS.has(p.v);
  };
  const readTemplate = () => {
    // i is just past an opening backtick or a closing brace of `${ }`
    let v = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        v += src.slice(i, i + 2);
        i += 2;
      } else if (c === '`') {
        i += 1;
        out.push({ t: 'str', v });
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2;
        out.push({ t: 'str', v });
        braces.push(depth);
        depth += 1;
        out.push({ t: 'punct', v: '+' });
        return;
      } else {
        v += c;
        i += 1;
      }
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      let v = '';
      i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          v += src.slice(i, i + 2);
          i += 2;
        } else {
          v += src[i];
          i += 1;
        }
      }
      i += 1;
      out.push({ t: 'str', v });
    } else if (c === '`') {
      i += 1;
      readTemplate();
    } else if (c === '/' && regexAllowed()) {
      let inClass = false;
      i += 1;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') i += 2;
        else if (src[i] === '[') (inClass = true), (i += 1);
        else if (src[i] === ']') (inClass = false), (i += 1);
        else if (src[i] === '/' && !inClass) break;
        else i += 1;
      }
      i += 1;
      while (/[a-z]/.test(src[i] ?? '')) i += 1;
      out.push({ t: 'str', v: '/regex/' });
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j])) j += 1;
      out.push({ t: 'word', v: src.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w.]/.test(src[j])) j += 1;
      out.push({ t: 'str', v: src.slice(i, j) });
      i = j;
    } else {
      if (c === '{') depth += 1;
      if (c === '}') {
        depth -= 1;
        if (braces.length && braces[braces.length - 1] === depth) {
          braces.pop();
          i += 1;
          out.push({ t: 'punct', v: '+' });
          readTemplate();
          continue;
        }
      }
      out.push({ t: 'punct', v: c });
      i += 1;
    }
  }
  return out;
}

/** One module: its relative imports and its own findings. */
export function inspect(src, label) {
  const toks = tokenize(src);
  const specs = [];
  const findings = [];
  const spec = (value) => {
    specs.push(value);
  };
  for (let k = 0; k < toks.length; k += 1) {
    const tk = toks[k];
    const next = toks[k + 1];
    if (tk.t !== 'word') continue;
    const prev = toks[k - 1];
    const member = prev?.t === 'punct' && prev.v === '.';
    if (tk.v === 'import' && !member) {
      if (next?.t === 'str') spec(next.v);
      else if (next?.v === '(') {
        let end = k + 2;
        let parenDepth = 1;
        while (end < toks.length && parenDepth > 0) {
          if (toks[end].v === '(' && toks[end].t === 'punct') parenDepth += 1;
          if (toks[end].v === ')' && toks[end].t === 'punct') parenDepth -= 1;
          end += 1;
        }
        const arg = toks.slice(k + 2, end - 1);
        if (arg.length === 1 && arg[0].t === 'str') spec(arg[0].v);
        else {
          const text = arg.map((a) => a.v).join('');
          findings.push({ file: label, rule: 'dynamic-import', value: text });
        }
      }
    } else if (tk.v === 'from' && next?.t === 'str' && !member) {
      spec(next.v);
    } else if (tk.v === 'fetch' && next?.v === '(' && next.t === 'punct' && !member) {
      findings.push({ file: label, rule: 'fetch', value: 'fetch(' });
    } else if (tk.v === 'new' && next?.v === 'WebSocket') {
      findings.push({ file: label, rule: 'websocket', value: 'new WebSocket' });
    }
  }
  return { specs, findings };
}

/** Walk the closure of `entries` (absolute paths) under `root`. */
export function walk(entries, root) {
  const seen = new Set();
  const findings = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const label = relative(root, file);
    if (!existsSync(file)) {
      findings.push({ file: label, rule: 'missing', value: file });
      continue;
    }
    const { specs, findings: own } = inspect(readFileSync(file, 'utf8'), label);
    for (const f of own) {
      if (
        f.rule === 'dynamic-import' &&
        ALLOWED_DYNAMIC.some((a) => a.file === f.file && a.arg === f.value)
      )
        continue;
      findings.push(f);
    }
    for (const s of specs) {
      if (s.startsWith('.')) {
        queue.push(resolve(dirname(file), s));
        continue;
      }
      const bare = s.replace(/^node:/, '');
      const top = bare.split('/')[0];
      if (NETWORK.has(top)) findings.push({ file: label, rule: 'network-module', value: s });
      else if (!s.startsWith('node:') && !builtinModules.includes(top))
        findings.push({ file: label, rule: 'bare-package', value: s });
    }
  }
  return { findings, files: [...seen].map((f) => relative(root, f)).sort() };
}

const hookEntries = (root) => {
  const dir = join(root, 'hooks');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => join(dir, f));
};

test('INFRA-47 5-7a real hook closures import no network module', () => {
  const entries = hookEntries(ENGINE);
  assert.ok(entries.length >= 2, 'expected the Stop and PreToolUse hooks');
  const { findings, files } = walk(entries, ENGINE);
  assert.deepEqual(
    findings,
    [],
    'A hook (or a module it imports) reaches the network or loads code this repo does not own. ' +
      'Hooks run on every tool call and must stay offline (proposal 4.11).',
  );
  for (const must of ['hooks/stop.mjs', 'hooks/pre-tool-use.mjs', 'config.mjs', 'tree.mjs'])
    assert.ok(files.includes(must), `walker never reached ${must}: it would pass on nothing`);
});

const fixture = (name) => walk(hookEntries(join(FIXTURES, name)), join(FIXTURES, name));

test('INFRA-47 5-7b planted direct node:https fails', () => {
  const { findings } = fixture('dirty-direct');
  assert.deepEqual(findings.map((f) => [f.rule, f.value]), [['network-module', 'node:https']]);
});

test('INFRA-47 5-7c planted transitive node:net fails', () => {
  const { findings, files } = fixture('dirty-transitive');
  assert.ok(files.includes('lib/a.mjs'));
  assert.deepEqual(findings.map((f) => [f.file, f.rule, f.value]), [
    ['lib/a.mjs', 'network-module', 'node:net'],
  ]);
});

test('INFRA-47 5-7d planted fetch call fails', () => {
  const { findings } = fixture('dirty-fetch');
  assert.deepEqual(findings.map((f) => f.rule), ['fetch']);
});

test('INFRA-47 5-7e clean fixture passes', () => {
  const { findings, files } = fixture('clean');
  assert.deepEqual(findings, []);
  assert.deepEqual(files, ['hooks/hook.mjs', 'lib/a.mjs']);
});

test('INFRA-47 5-7 the walker catches the remaining shapes in source', () => {
  const rules = (src) => inspect(src, 'x.mjs').findings.map((f) => f.rule);
  assert.deepEqual(rules('const m = await import(name);'), ['dynamic-import']);
  assert.deepEqual(rules('const m = await import(`./${name}.mjs`);'), ['dynamic-import']);
  assert.deepEqual(rules('const s = `${fetch(u)}`;'), ['fetch']);
  assert.deepEqual(rules('const s = new WebSocket(u);'), ['websocket']);
  assert.deepEqual(rules("const r = /['\"]/; const x = fetch(u);"), ['fetch']);
  assert.deepEqual(rules("const a = x.fetch(u); // fetch(\n/* new WebSocket */"), []);
  assert.deepEqual(inspect("import('./a.mjs'); export * from './b.mjs'; import './c.mjs';", 'x').specs, [
    './a.mjs',
    './b.mjs',
    './c.mjs',
  ]);
  const bare = walk([join(FIXTURES, 'clean/hooks/hook.mjs')], join(FIXTURES, 'clean'));
  assert.deepEqual(bare.findings, []);
});

test('INFRA-47 5-7 the project-config import is allowed only in config.mjs with its exact argument', () => {
  const src = 'await import(pathToFileURL(file).href);';
  const f = inspect(src, 'config.mjs').findings;
  assert.equal(f.length, 1);
  assert.ok(ALLOWED_DYNAMIC.some((a) => a.file === f[0].file && a.arg === f[0].value));
  assert.ok(!ALLOWED_DYNAMIC.some((a) => a.file === 'other.mjs'));
  const other = inspect('await import(pathToFileURL(url).href);', 'config.mjs').findings[0];
  assert.ok(!ALLOWED_DYNAMIC.some((a) => a.file === other.file && a.arg === other.value));
});

test('INFRA-47 5-7 a dynamic import with a non-literal argument is reported through walk', () => {
  const { findings } = fixture('dirty-dynamic');
  assert.deepEqual(findings.map((f) => [f.file, f.rule, f.value]), [['lib/a.mjs', 'dynamic-import', 'name']]);
});

test('INFRA-47 5-7 walk allows the project-config import only in config.mjs with its exact argument', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-nonet-'));
  try {
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks/hook.mjs'), "import '../config.mjs';\n");
    writeFileSync(join(root, 'config.mjs'), 'export const l = (file) => import(pathToFileURL(file).href);\n');
    assert.deepEqual(walk([join(root, 'hooks/hook.mjs')], root).findings, []);
    writeFileSync(join(root, 'config.mjs'), 'export const l = (url) => import(pathToFileURL(url).href);\n');
    assert.deepEqual(
      walk([join(root, 'hooks/hook.mjs')], root).findings.map((f) => [f.file, f.rule]),
      [['config.mjs', 'dynamic-import']],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INFRA-47 5-7 a bare package and a bare network builtin fail', () => {
  assert.deepEqual(fixture('dirty-bare').findings.map((f) => [f.rule, f.value]), [['bare-package', 'undici']]);
  assert.deepEqual(fixture('dirty-bare-http').findings.map((f) => [f.rule, f.value]), [['network-module', 'http']]);
});
