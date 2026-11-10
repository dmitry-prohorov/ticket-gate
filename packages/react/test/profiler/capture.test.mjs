// Browser capture with fakes: the order of calls is the contract, no browser starts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TRACE_CATEGORIES,
  captureRun,
  openContext,
  resolveChromium,
} from '../../profiler/capture.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('CA-1 openContext installs the disabled DevTools hook before any page', async () => {
  const calls = [];
  let script;
  const browser = {
    newContext: async (opts) => {
      calls.push(['newContext', opts]);
      return {
        addInitScript: async (fn) => {
          calls.push(['addInitScript']);
          script = fn;
        },
        newPage: async () => {
          calls.push(['newPage']);
          return {};
        },
      };
    },
  };
  await openContext(browser, { viewport: { width: 1, height: 1 } });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['newContext', 'addInitScript', 'newPage'],
  );
  assert.deepEqual(calls[0][1], { viewport: { width: 1, height: 1 } });
  const had = Object.hasOwn(globalThis, 'window');
  const before = globalThis.window;
  globalThis.window = {};
  try {
    script();
    assert.deepEqual(globalThis.window.__REACT_DEVTOOLS_GLOBAL_HOOK__, {
      isDisabled: true,
    });
  } finally {
    if (had) globalThis.window = before;
    else delete globalThis.window;
  }
});

test('CA-2 captureRun traces act between start and stop', async () => {
  const calls = [];
  const browser = {
    startTracing: async (page, o) => calls.push(['start', page, o]),
    stopTracing: async () => calls.push(['stop']),
  };
  const page = { id: 'p' };
  await captureRun(browser, page, async () => calls.push(['act']), 'out.json');
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['start', 'act', 'stop'],
  );
  assert.equal(calls[0][1], page);
  assert.deepEqual(calls[0][2], { path: 'out.json', categories: TRACE_CATEGORIES });
});

test('PR-1 Playwright resolves from the project and is no package dependency', () => {
  const chromium = resolveChromium(join(REPO, 'package.json'));
  assert.equal(typeof chromium.launch, 'function');
  const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.ok(root.devDependencies['@playwright/test'], 'a root devDependency');
  for (const p of ['engine', 'react', 'supabase-next']) {
    const pkg = JSON.parse(
      readFileSync(join(REPO, 'packages', p, 'package.json'), 'utf8'),
    );
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ])
      assert.equal(
        pkg[field]?.['@playwright/test'],
        undefined,
        `${p} lists @playwright/test in ${field}`,
      );
  }
});
