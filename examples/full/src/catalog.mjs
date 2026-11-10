const PRICES = { apple: 50, pear: 70, plum: 30 };

/** The price of one item in cents; an unknown sku throws. */
export function priceOf(sku) {
  if (!(sku in PRICES)) throw new RangeError(`unknown sku ${sku}`);
  return PRICES[sku];
}

export const skus = () => Object.keys(PRICES);
