// Option forms over the engine's ratchet module: the project passes values (globs, limits, texts) and
// these functions build the engine ratchets from them. No project value lives here.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createModuleSize,
  createSkillRefs,
  isDir,
} from '../ratchet.mjs';
import { globMatch } from './surface.mjs';

/** Existing files under root that match any glob: posix relative paths, unique, sorted. */
export function expandSources(root, sources) {
  const out = new Set();
  const walk = (rel, into) => {
    for (const e of readdirSync(join(root, rel))) {
      if (e === 'node_modules') continue;
      const p = rel ? `${rel}/${e}` : e;
      if (isDir(join(root, p))) walk(p, into);
      else into.push(p);
    }
  };
  for (const glob of sources) {
    if (!glob.includes('*')) {
      if (existsSync(join(root, glob)) && !isDir(join(root, glob)))
        out.add(glob);
      continue;
    }
    const segs = glob.split('/');
    const start = segs
      .slice(
        0,
        segs.findIndex((s) => s.includes('*')),
      )
      .join('/');
    if (!isDir(join(root, start))) continue;
    const all = [];
    walk(start, all);
    for (const p of all) if (globMatch(glob, p)) out.add(p);
  }
  return [...out].sort();
}

export function moduleSize({ baseline, ...rest }) {
  return createModuleSize({ ...rest, baselineRel: baseline });
}

export function skillRefs({ sources, ...rest }) {
  const sourceFiles = (root) => expandSources(root, sources);
  return { ...createSkillRefs({ ...rest, sourceFiles }), sourceFiles };
}
