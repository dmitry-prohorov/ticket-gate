// PJ-1: the engine ships no project default; an entry called without a config fails loudly.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SelectionConfigError } from '../../selection/define.mjs';
import { select } from '../../selection/select.mjs';

test('PJ-1 an engine entry called without a config throws SelectionConfigError naming gate.config', () => {
  assert.throws(
    () => select({ root: process.cwd(), changed: [] }),
    (err) =>
      err instanceof SelectionConfigError &&
      err.message.includes('gate.config'),
  );
});
