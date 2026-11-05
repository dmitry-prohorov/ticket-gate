import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { ROOT } from '#engine/root.mjs';
import { patchedSource } from '#engine/mutations/locate.mjs';
import { isServed, needsWebBuild, patchKey } from '#engine/mutations/served.mjs';

// The entries `next build` compiles as TypeScript. vitest, jest
// and node entries run through esbuild, which strips types, so a type error
// there is never found by mutate:check; packages/core builds with tsup.
// prettier-ignore
export const typechecked = (m) => isServed(m) && needsWebBuild(m) && /\.(ts|tsx)$/.test(m.file);

/**
 * Type checks each distinct served patch before any build.
 * `checker.check(file, source)` returns the formatted diagnostic lines of that
 * one file; `checker.read(file)` (optional) returns its text. Returns
 * Map<patchKey, { ok: true } | { ok: false, line } | { ok: null, line }>; `null`
 * means the unpatched file already fails, so the patch cannot be judged.
 * Nothing is written.
 */
export function typecheckPatches(entries, checker) {
  const out = new Map();
  const clean = new Map();
  const seen = new Set();
  const keyed = entries.filter(typechecked).map((m) => [patchKey(m), m]);
  for (const [key, m] of keyed) {
    if (seen.has(key)) continue;
    seen.add(key);
    const original = checker.read
      ? checker.read(m.file)
      : readFileSync(join(ROOT, m.file), 'utf8');
    if (!clean.has(m.file)) clean.set(m.file, checker.check(m.file, original));
    const already = clean.get(m.file);
    if (already.length > 0) {
      out.set(key, {
        ok: null,
        line: `clean ${m.file} already fails: ${already[0]}`,
      });
      continue;
    }
    let lines;
    try {
      lines = checker.check(m.file, patchedSource(original, m));
    } catch (err) {
      out.set(key, { ok: null, line: `${m.file}: ${err.message}` });
      continue;
    }
    out.set(
      key,
      lines.length > 0 ? { ok: false, line: lines[0] } : { ok: true },
    );
  }
  return out;
}

/**
 * R6: one in-memory TS program from apps/web/tsconfig.json (TypeScript resolved
 * from apps/web, the version next build uses). The patched text is served for
 * the one file through the compiler host; diagnostics of that file only. No file
 * is written and `incremental` is off, so no .tsbuildinfo appears.
 */
function tsChecker(root) {
  let ts;
  let setup;
  let program;
  const cache = new Map();
  const init = () => {
    if (setup) return setup;
    ts = createRequire(join(root, 'apps/web/package.json'))('typescript');
    const cfg = join(root, 'apps/web/tsconfig.json');
    const read = ts.readConfigFile(cfg, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      dirname(cfg),
    );
    const options = {
      ...parsed.options,
      incremental: false,
      composite: false,
      noEmit: true,
      tsBuildInfoFile: undefined,
    };
    setup = {
      options,
      names: parsed.fileNames,
      host: ts.createCompilerHost(options, true),
    };
    return setup;
  };
  return {
    read: (file) => readFileSync(join(root, file), 'utf8'),
    check(file, source) {
      const { options, names, host } = init();
      const abs = resolve(root, file);
      const same = (n) => resolve(n) === abs;
      const h = {
        ...host,
        getSourceFile(name, lang, onErr, shouldCreate) {
          if (same(name)) return ts.createSourceFile(name, source, lang, true);
          if (!cache.has(name))
            cache.set(
              name,
              host.getSourceFile(name, lang, onErr, shouldCreate),
            );
          return cache.get(name);
        },
      };
      program = ts.createProgram({
        rootNames: names.some(same) ? names : [...names, abs],
        options,
        host: h,
        oldProgram: program,
      });
      const sf = program.getSourceFile(abs);
      const diags = [
        ...program.getSyntacticDiagnostics(sf),
        ...program.getSemanticDiagnostics(sf),
      ].filter((d) => d.category === ts.DiagnosticCategory.Error);
      return diags.map((d) => {
        const at =
          d.file && d.start !== undefined
            ? d.file.getLineAndCharacterOfPosition(d.start)
            : { line: 0, character: 0 };
        return `${file}(${at.line + 1},${at.character + 1}): error TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
      });
    },
  };
}

const typecheckSummary = (id, verdicts, checks = 0) => {
  const n = (v) => verdicts.filter((x) => x === v).length;
  return `mutate:check ${id} typecheck: ${n('ok')} ok, ${n('error')} error, ${n('n/a')} n/a, ${checks} checks`;
};

/** `--typecheck`: prints one line per entry and the summary; returns the exit code. */
async function typecheckMain(spec, todo, id) {
  const real = tsChecker(ROOT);
  let checks = 0;
  const counting = {
    read: real.read,
    check: (file, source) => {
      checks++;
      return real.check(file, source);
    },
  };
  console.log(
    `typecheck: checking ${todo.length} entr${todo.length === 1 ? 'y' : 'ies'} (in memory, no file is written)`,
  );
  const tc = typecheckPatches(todo, counting);
  // Let a queued SIGINT/SIGTERM run its handler before any result is printed.
  await new Promise((r) => setTimeout(r, 25));
  const verdicts = todo.map((m) => {
    if (!typechecked(m)) {
      const why =
        isServed(m) && needsWebBuild(m)
          ? 'not a .ts/.tsx file'
          : 'not built by next build';
      console.log(`${m.id} typecheck: n/a (${why})`);
      return 'n/a';
    }
    const v = tc.get(patchKey(m));
    if (v.ok === true) {
      console.log(`${m.id} typecheck: ok`);
      return 'ok';
    }
    if (v.ok === null) {
      console.log(`${m.id} typecheck: n/a (${v.line})`);
      return 'n/a';
    }
    console.log(`${m.id} typecheck: error ${v.line}`);
    return 'error';
  });
  console.log(`\n${typecheckSummary(spec.ticket ?? id, verdicts, checks)}`);
  return verdicts.includes('error') ? 1 : 0;
}

export { tsChecker, typecheckMain, typecheckSummary };
