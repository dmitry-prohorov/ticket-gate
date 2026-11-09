import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './io.mjs';
import { nightlyDirOf } from './record.mjs';

export function renderPlist(template, { repo, node }) {
  return template.replaceAll('__REPO__', repo).replaceAll('__NODE__', node);
}

/**
 * The launchd scheduler adapter (macOS only): `install` writes the plist and prints the
 * commands, or returns exit code 2 with one line on any other platform.
 */
export function launchd({ label, template, wake, platform = process.platform }) {
  return {
    name: 'launchd',
    install(io, dir) {
      if (platform !== 'darwin') {
        console.error(
          `nightly: FAIL the launchd scheduler needs macOS (this is ${platform}); set nightly.scheduler to another adapter, or call nightly run from your own scheduler`,
        );
        return 2;
      }
      const text = readFileSync(join(ROOT, template), 'utf8');
      const plist = join(dir, `${label}.plist`);
      io.writeFile(
        plist,
        renderPlist(text, { repo: io.mainCheckout, node: process.execPath }),
      );
      const dest = `~/Library/LaunchAgents/${label}.plist`;
      console.log(`Wrote ${plist}. Nothing was loaded; run these yourself:`);
      console.log(`  cp ${plist} ${dest}`);
      console.log(`  launchctl bootstrap gui/$(id -u) ${dest}`);
      console.log(`  sudo pmset repeat wakeorpoweron MTWRFSU ${wake}:00`);
    },
  };
}

export function install(io, cfg) {
  return cfg.scheduler.install(io, nightlyDirOf(io));
}
