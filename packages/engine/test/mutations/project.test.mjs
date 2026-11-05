import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(
  new URL('../../mutations/project.mjs', import.meta.url),
);

// A fresh process per case: the module keeps the bound Setup in a module variable.
const run = (body) =>
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { bindSetup, projectSetup } from ${JSON.stringify(PROJECT)};\n${body}`,
    ],
    { encoding: 'utf8' },
  );

test('PS-1 projectSetup throws until a setup is bound, then returns it', () => {
  const before = run(
    "try { projectSetup(); console.log('returned'); } catch (e) { console.log(e.message); }",
  );
  assert.match(before, /no setup bound/);
  assert.match(before, /ticket-gate mutate/);
  assert.match(before, /bindSetup\(setupOf\(gate\)\)/);

  const after = run(
    "const s = { marker: 1 }; console.log(bindSetup(s) === s, projectSetup() === s);",
  );
  assert.equal(after.trim(), 'true true');
});
