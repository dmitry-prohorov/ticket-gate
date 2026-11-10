// The `unguarded` mutation kind: a guard no test bites, kept on the books with a reason and never
// run. It exists for the assertions ratchet, where its `from` covers a dropped spec.
import { dirname } from 'node:path';

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @param {{ from: RegExp, fromHint: string, prefix?: string }} options `from` is what an entry's
 *   `from` must match, `fromHint` names that shape in the error, and `prefix` is prepended to
 *   `from` to choose the area file.
 */
export function unguardedKind({ from, fromHint, prefix = '' }) {
  return {
    name: 'unguarded',
    runs: false,
    fields: ['title', 'why', 'from'],
    shape(e) {
      const out = [];
      for (const f of ['title', 'why', 'from'])
        if (!isStr(e[f])) out.push(`${f} must be a non-empty string`);
      return out;
    },
    // `from` is checked on an entry of any kind.
    strays(e) {
      return e.from !== undefined && !from.test(String(e.from))
        ? [`from must match ${fromHint}`]
        : [];
    },
    area: (e, dir) => `${dir}/${dirname(`${prefix}${e.from}`)}.json`,
  };
}
