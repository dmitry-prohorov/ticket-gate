// Stub Salesforce pack for the INFRA-46 boundary test. Pure data and functions: no fs,
// no process spawning, no network. The real pack is INFRA-52..54.
import { globRe, step } from '../../../config.mjs';

const SF_GLOBS = ['force-app/**', 'sfdx-project.json'];
const ORG = 'gate';
const FULL_CMD = `sf apex run test -o ${ORG} --test-level RunLocalTests --wait 30`;

const unitName = (naming, cls) => naming[0].replace('{Class}', cls);

function apexSelector({ naming = ['{Class}Test'], full = [] } = {}) {
  const fullRes = full.map(globRe);
  return {
    select(ctx) {
      const hit = ctx.paths.find((p) => fullRes.some((re) => re.test(p)));
      if (hit)
        return { mode: 'full', why: `${hit} needs a full Apex run`, units: [] };
      const units = [];
      for (const p of ctx.paths) {
        const m = /\/(?:classes\/(\w+)\.cls|triggers\/(\w+)\.trigger)$/.exec(p);
        if (m)
          units.push({
            id: unitName(naming, m[1] ?? m[2]),
            inputs: [p],
          });
      }
      return {
        mode: 'affected',
        why: units.length
          ? 'changed Apex classes and triggers'
          : 'no Apex changed',
        units,
      };
    },
    cmd(units, sel) {
      if (sel?.mode === 'full' || units.length === 0) return FULL_CMD;
      return `sf apex run test -o ${ORG} --tests ${units
        .map((u) => u.id)
        .join(',')} --wait 30`;
    },
  };
}

export default function salesforce({ org } = {}) {
  const alias = org?.alias ?? ORG;
  const mk =
    (id, cmd, defaults) =>
    (opts = {}) =>
      step({
        id,
        when: opts.when ?? defaults.when,
        cmd,
        reuse: { deny: [] },
        ...(opts.stack ? { stack: opts.stack } : {}),
        ...(opts.units ? { units: opts.units } : {}),
      });
  return {
    name: 'salesforce',
    version: '0.0.0-stub',
    stack: {
      start: 'sf org create scratch ...',
      health: () => `sf org display -o ${alias} --json`,
      lock: { path: '.turbo/org-gate.lock' },
    },
    steps: {
      codeAnalyzer: mk('code-analyzer', 'sf code-analyzer run', {
        when: SF_GLOBS,
      }),
      lwcJest: mk('lwc-jest', 'npx sfdx-lwc-jest', { when: false }),
      bundleVitest: mk('bundle-vitest', 'npx vitest run', { when: false }),
      deploy: mk('deploy', 'sf project deploy start -o gate', {
        when: SF_GLOBS,
      }),
      apexTests: mk('apex', FULL_CMD, { when: SF_GLOBS }),
      flowTests: mk('flow-tests', 'sf flow run test -o gate', { when: false }),
      agentTests: mk('agent-tests', 'sf agent test run -o gate', {
        when: false,
      }),
    },
    selectors: { apexTests: apexSelector },
    reviewRules: [],
  };
}
