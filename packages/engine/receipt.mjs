import { join } from 'node:path';
import { VERIFIED_STATUSES } from './digest.mjs';
import { ROOT } from './root.mjs';

export const RECEIPT = join(ROOT, '.turbo', 'ticket-verify.json');

/** The receipt written to .turbo/ticket-verify.json. `size` is the review map's size block. */
export function buildReceipt({
  treeHash,
  ranAt,
  ok,
  results,
  size,
  base,
  shadow = null,
  moveProof = null,
}) {
  return {
    treeHash,
    ranAt,
    base,
    ok,
    results,
    size: { lines: size.lines, level: size.level },
    oversize: size.level === 'oversize',
    shadow,
    moveProof,
  };
}

/** True iff every result has a verified status (pass, human, reused); an unknown status is not ok. */
export function receiptOk(results) {
  return results.every((r) => VERIFIED_STATUSES.includes(r.status));
}
