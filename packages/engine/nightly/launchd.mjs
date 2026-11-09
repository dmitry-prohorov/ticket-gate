import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './io.mjs';
import { nightlyDirOf } from './record.mjs';

export function renderPlist(template, { repo, node }) {
  return template.replaceAll('__REPO__', repo).replaceAll('__NODE__', node);
}

/** The launchd scheduler adapter: `install` writes the plist and prints the commands. */
export function launchd({ label, template, wake }) {
  return {
    name: 'launchd',
    install(io, dir) {
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
  cfg.scheduler.install(io, nightlyDirOf(io));
}
