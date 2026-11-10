import { total } from '../src/cart.mjs';

/** The checkout page: the text a customer sees for a cart. */
export const checkoutPage = (lines) => `Total: ${(total(lines) / 100).toFixed(2)}`;
