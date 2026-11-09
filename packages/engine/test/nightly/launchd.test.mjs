// The launchd adapter's platform guard and the install exit code.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { launchd } from '../../nightly/launchd.mjs';
import { ROOT } from '../../root.mjs';
import { main } from '../../nightly/run.mjs';

const OPTS = { label: 'demo.nightly', wake: '00:55' };
const io = (written) => ({
  mainCheckout: '/repo',
  writeFile: (p, c) => written.push([p, c]),
});

test('LD-1 launchd on another platform writes nothing, prints one line and returns 2', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const log = t.mock.method(console, 'log', () => {});
  const written = [];
  const s = launchd({ ...OPTS, template: 'missing.plist', platform: 'linux' });
  assert.equal(s.install(io(written), '/dir'), 2);
  assert.deepEqual(written, []);
  assert.equal(log.mock.callCount(), 0);
  assert.equal(err.mock.callCount(), 1);
  assert.match(
    err.mock.calls[0].arguments[0],
    /^nightly: FAIL the launchd scheduler needs macOS \(this is linux\);/,
  );
});

test('LD-2 launchd on macOS writes the rendered plist and prints the three commands', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const dir = mkdtempSync(join(tmpdir(), 'ld2-'));
  const tpl = join(dir, 'tpl.plist');
  writeFileSync(tpl, '__REPO__');
  const written = [];
  const s = launchd({ ...OPTS, template: relative(ROOT, tpl), platform: 'darwin' });
  assert.equal(s.install(io(written), '/dir'), undefined);
  assert.deepEqual(written, [['/dir/demo.nightly.plist', '/repo']]);
  assert.match(log.mock.calls.at(-1).arguments[0], /pmset repeat wakeorpoweron MTWRFSU 00:55:00$/);
  assert.equal(existsSync(tpl) && readFileSync(tpl, 'utf8'), '__REPO__');
});

test("LD-3 main returns the scheduler's code, and 0 when it returns nothing", async () => {
  const config = (code) => ({
    commands: { run: 'r', install: 'i' },
    scheduler: { name: 's', install: () => code },
  });
  const w = { env: {}, mainCheckout: '/repo' };
  assert.equal(await main(['--install'], config(2), w), 2);
  assert.equal(await main(['--install'], config(undefined), w), 0);
});
