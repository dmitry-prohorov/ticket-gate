import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../root.mjs';
import { projectSetup } from './project.mjs';
import { CARET_FILTER, CARET_HINT, locate } from './registry.mjs';

/** Schema errors, one string each. [] when valid. Nothing runs before this. */
export function validateSpec(spec, readFile, setup = projectSetup()) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.mutations))
    return ['file must be an object with a "mutations" array'];
  if (spec.mutations.length === 0) errors.push('"mutations" is empty');
  const seen = new Set();
  for (const [i, m] of spec.mutations.entries()) {
    const at = `mutation #${i + 1}${m?.id ? ` (${m.id})` : ''}`;
    if (!m || typeof m !== 'object') {
      errors.push(`${at}: not an object`);
      continue;
    }
    if (typeof m.id !== 'string' || m.id === '') errors.push(`${at}: no id`);
    else if (seen.has(m.id)) errors.push(`${at}: duplicate id ${m.id}`);
    else seen.add(m.id);
    if (typeof m.test !== 'string' || m.test.trim() === '')
      errors.push(`${at}: "test" must be a non-empty command`);
    else if (CARET_FILTER.test(m.test)) errors.push(`${at}: ${CARET_HINT}`);
    const kind = setup.kinds.get(m.kind);
    if (kind?.runs && kind.validate) {
      errors.push(...kind.validate(m, readFile).map((e) => `${at}: ${e}`));
    } else if (m.kind === 'patch') {
      if (m.restore !== undefined)
        errors.push(`${at}: "restore" is only for sql mutations`);
      if (
        typeof m.file !== 'string' ||
        typeof m.find !== 'string' ||
        m.find === ''
      )
        errors.push(`${at}: patch needs "file" and a non-empty "find"`);
      else if (typeof m.replace !== 'string')
        errors.push(`${at}: patch needs a string "replace" (may be empty)`);
      else {
        let src = null;
        try {
          src = readFile(m.file);
        } catch {
          errors.push(`${at}: file ${m.file} does not exist`);
        }
        if (src !== null) {
          const n = locate(src, m.find, m.within).count;
          if (n !== 1)
            errors.push(
              `${at}: "find" occurs ${n} times in ${m.file}, must be exactly 1 (stale or ambiguous mutation: update "find")`,
            );
        }
      }
    } else {
      const names = [...setup.kinds.values()]
        .filter((k) => k.runs && k.name !== 'patch')
        .map((k) => k.name)
        .concat('patch');
      errors.push(
        `${at}: kind must be ${names.map((n) => `"${n}"`).join(' or ')}`,
      );
    }
  }
  return errors;
}

/** Reads and validates; throws with every error listed. */
export function loadSpec(
  path,
  readFile = (p) => readFileSync(join(ROOT, p), 'utf8'),
) {
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  const errors = validateSpec(spec, readFile);
  if (errors.length)
    throw new Error(
      `${path} is invalid:\n  - ${errors.join('\n  - ')}\nFix the mutations file; nothing was run.`,
    );
  return spec;
}
