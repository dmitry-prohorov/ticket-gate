import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listFiles } from '../graph/js.mjs';
import { projectSelection } from './project.mjs';

/**
 * Every spec declares known areas on line 1, no new ticket-named spec, the smoke cap, then each
 * config check (route table, drift guards).
 * @param {string} root repo root @returns {string[]} one problem per line, sorted
 */
export function checkE2eAreas(root, cfg = projectSelection()) {
  const problems = [];
  const known = cfg.areas === null ? null : new Set(cfg.areas);
  const { dir, match, header, ticketNamed, grandfathered, smokeMax } =
    cfg.specs;
  const specs = listFiles(root, dir, (p) => match.test(p));
  let smoke = 0;
  for (const p of specs) {
    const name = p.slice(dir.length + 1);
    const text = readFileSync(join(root, p), 'utf8');
    const m = header.exec(text.split('\n', 1)[0].replace(/\r$/, ''));
    if (!m) problems.push(`missing-header ${name}`);
    else if (known)
      for (const id of m[1].split(', '))
        if (!known.has(id)) problems.push(`unknown-area ${name} ${id}`);
    const base = name.split('/').pop();
    if (ticketNamed?.test(base) && !grandfathered.has(base))
      problems.push(`ticket-named ${name}`);
    smoke += text.split(`'@smoke'`).length - 1;
  }
  if (smoke > smokeMax) problems.push(`smoke-cap ${smoke}`);

  let entries = 0;
  for (const check of cfg.checks) {
    const out = check.run(root);
    problems.push(...out.problems);
    entries += out.entries ?? 0;
  }
  problems.sort();
  Object.defineProperty(problems, 'counts', {
    value: { specs: specs.length, entries },
  });
  return problems;
}
