// Shape check of a mutation-testing-report-schema report (majors 1 and 2).
// Only the fields the score rules read are checked; the first problem wins.
export const SCHEMA_VERSION = /^[12](?:\.(?:0|[1-9]\d*)){0,2}$/;

export const STATUSES = new Set([
  'Killed',
  'Survived',
  'NoCoverage',
  'CompileError',
  'RuntimeError',
  'Timeout',
  'Ignored',
  'Pending',
]);

const isLine = (n) => Number.isInteger(n) && n >= 1;
const isObject = (v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v) =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

function mutantProblem(m) {
  if (!STATUSES.has(m?.status))
    return `status ${JSON.stringify(m?.status)} is not a schema status`;
  if (typeof m.mutatorName !== 'string') return 'mutatorName is not a string';
  if (m.replacement !== undefined && typeof m.replacement !== 'string')
    return 'replacement is not a string';
  for (const end of ['start', 'end'])
    for (const axis of ['line', 'column'])
      if (!isLine(m.location?.[end]?.[axis]))
        return `location.${end}.${axis} is not a positive integer`;
  if (m.coveredBy !== undefined && !isStringArray(m.coveredBy))
    return 'coveredBy is not an array of strings';
  return null;
}

/** The first way `report` departs from the schema, or null. */
export function schemaProblem(report) {
  if (!isObject(report)) return 'is not a JSON object';
  if (
    typeof report.schemaVersion !== 'string' ||
    !SCHEMA_VERSION.test(report.schemaVersion)
  )
    return `schemaVersion ${JSON.stringify(report.schemaVersion)} is not a supported mutation-testing-report-schema version (1.x or 2.x)`;
  if (!isObject(report.files)) return 'files is missing';
  for (const [path, file] of Object.entries(report.files)) {
    const where = `files[${JSON.stringify(path)}]`;
    if (!Array.isArray(file?.mutants))
      return `${where}.mutants is not an array`;
    for (const [i, m] of file.mutants.entries()) {
      const p = mutantProblem(m);
      if (p) return `${where}.mutants[${i}]: ${p}`;
    }
  }
  if (report.testFiles !== undefined) {
    if (!isObject(report.testFiles)) return 'testFiles is not an object';
    for (const [path, tf] of Object.entries(report.testFiles)) {
      const ok =
        Array.isArray(tf?.tests) &&
        tf.tests.every(
          (t) => typeof t?.id === 'string' && typeof t?.name === 'string',
        );
      if (!ok)
        return `testFiles[${JSON.stringify(path)}].tests is not an array of { id, name }`;
    }
  }
  return null;
}
