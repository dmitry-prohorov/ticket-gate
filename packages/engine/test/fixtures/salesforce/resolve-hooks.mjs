// Node `resolve` hook for the Salesforce boundary fixture (INFRA-46). The fixture config
// keeps the bare specifiers of the 4.8 draft; this maps exactly two of them.
const ENGINE = new URL('../../../config.mjs', import.meta.url).href;
const PACK = new URL('./stub-pack.mjs', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@ticket-gate/engine')
    return { url: ENGINE, shortCircuit: true };
  if (specifier === '@ticket-gate/salesforce')
    return { url: PACK, shortCircuit: true };
  return nextResolve(specifier, context);
}
