// gate.config.mjs of a Salesforce repo (draft; flag spellings to verify with `sf <cmd> --help` in INFRA-52/53)
import { defineGate, step } from '@ticket-gate/engine';
import salesforce from '@ticket-gate/salesforce';

const sf = salesforce({
  packageDirs: [{ path: 'force-app', default: true }], // more dirs: { path, dependsOn: ['force-app'] }
  uiBundles: 'force-app/main/default/uiBundles/*', // each has its own package.json, vite.config.ts, Vitest
  org: {
    alias: 'gate',
    definition: 'config/project-scratch-def.json',
    maxAgeDays: 5,
  },
});

export default defineGate({
  base: 'origin/main',
  dod: {
    files: ['docs/tasks/phase-*.md'],
    contract: 'docs/tasks/contracts/{id}.md',
  },
  packs: [sf],
  stacks: { org: sf.stack }, // start / health / lock / reset
  steps: [
    step({ id: 'deps', when: true, cmd: 'npm ci', reuse: false }),
    sf.steps.codeAnalyzer({
      config: 'code-analyzer.yml',
      engines: ['pmd', 'eslint', 'flow', 'regex'],
      rules: [
        'soql-in-loop',
        'dml-in-loop',
        'without-sharing-unjustified',
        'auraenabled-no-user-mode',
      ],
    }),
    sf.steps.lwcJest({ when: ['force-app/**/lwc/**'] }),
    sf.steps.bundleVitest({ when: ['force-app/**/uiBundles/**'] }),
    step({ id: 'check', when: true, cmd: 'npm run check', reuse: false }), // ratchets, skill-refs, sync --check
    sf.steps.deploy({ stack: 'org' }), // sf project deploy start -o gate
    sf.steps.apexTests({
      stack: 'org',
      units: sf.selectors.apexTests({
        naming: ['{Class}Test', '{Class}_Test'],
        map: 'config/apex-test-map.json',
        full: [
          'force-app/**/objects/**',
          'force-app/**/permissionsets/**',
          'force-app/**/customMetadata/**',
          'sfdx-project.json',
        ],
      }),
      coverage: { org: 75, perClass: 85 },
    }), // full = RunLocalTests
    sf.steps.flowTests({ stack: 'org', when: ['force-app/**/flows/**'] }),
    sf.steps.agentTests({
      stack: 'org',
      specs: 'specs/agents/*.yaml',
      when: ['force-app/**/aiAuthoringBundles/**', 'force-app/**/bots/**'],
    }),
  ],
  stopOnRedBefore: ['deploy'],
  reviewMap: {
    rules: [
      ...sf.reviewRules, // HUMAN: permissionsets, profiles, sharingRules, objects/**/fields with encryption,
      // namedCredentials, remoteSiteSettings, connectedApps, cspTrustedSites, any added
      // `without sharing`, `@AuraEnabled`, `WITH SYSTEM_MODE`, string-built Database.query
      // GATED: classes/triggers logic; flows; aiAuthoringBundles. MACHINE: tests, lwc markup, docs
    ],
    humanLines: [
      {
        match: 'force-app/**/flows/*.flow-meta.xml',
        line: 'open in Flow Builder on the scratch org: sf org open -o gate',
      },
    ],
    sizeExcluded: ['**/*.test.js', '**/__tests__/**', 'docs/**'],
  },
  roles: {
    'dev-data': {
      owns: [
        'force-app/**/{objects,permissionsets,sharingRules,customMetadata}/**',
      ],
      axis: 'SEC-',
    },
    'dev-apex': { owns: ['force-app/**/{classes,triggers}/**'], axis: 'CORE-' },
    'dev-declarative': {
      owns: ['force-app/**/{flows,aiAuthoringBundles,experiences}/**'],
      axis: 'BUG-',
    },
    'dev-ui': { owns: ['force-app/**/{lwc,uiBundles}/**'], axis: 'UI-' },
  },
  skills: { lock: 'skills.lock' }, // sf-skills@<sha>: dev-apex -> platform-apex-generate, platform-apex-test-generate,
  // platform-apex-test-run, platform-soql-query; dev-data -> platform-custom-object-generate,
  // platform-custom-field-generate, platform-permission-set-generate,
  // platform-sharing-owd-configure, platform-sharing-rules-generate;
  // dev-declarative -> automation-flow-generate, agentforce-generate, agentforce-test;
  // dev-ui -> experience-lwc-generate, experience-lwc-security-validate,
  // experience-ui-bundle-frontend-generate; dev-infra -> dx-code-analyzer-run,
  // dx-code-analyzer-custom-rule-create, dx-scratch-def-configure
});
