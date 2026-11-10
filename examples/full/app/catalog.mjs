import { priceOf, skus } from '../src/catalog.mjs';

/** The catalog page: one line per item. */
export const catalogPage = () => skus().map((s) => `${s} ${priceOf(s)}`).join('\n');
