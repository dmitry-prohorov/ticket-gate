import { priceOf } from './catalog.mjs';

/** The total of a cart in cents: the sum of each line, less 10% from 10 items on. */
export function total(lines) {
  const items = lines.reduce((n, l) => n + l.qty, 0);
  const sum = lines.reduce((s, l) => s + priceOf(l.sku) * l.qty, 0);
  if (items >= 10) return Math.round(sum * 0.9);
  return sum;
}
