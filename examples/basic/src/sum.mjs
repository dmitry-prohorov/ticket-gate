/** Adds two numbers; refuses anything that is not a finite number. */
export function sum(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError('sum takes two numbers');
  return a + b;
}
