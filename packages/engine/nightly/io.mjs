import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  isAlive,
  lockPath as defaultLockPath,
  mainCheckout as defaultMainCheckout,
} from '../lock.mjs';
import { ROOT } from '../root.mjs';

export { ROOT } from '../root.mjs';

// ---------------------------------------------------------------- real io

export function realRun(
  cmd,
  args,
  { cwd, env = {}, limitS, killSignal = 'SIGKILL', graceS = 0 } = {},
) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const take = (b) => {
      process.stdout.write(b);
      out = (out + b).slice(-20_000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    let graceTimer = null;
    const timer = limitS
      ? setTimeout(() => {
          timedOut = true;
          killGroup(killSignal);
          if (killSignal !== 'SIGKILL' && graceS > 0)
            graceTimer = setTimeout(() => killGroup('SIGKILL'), graceS * 1000);
        }, limitS * 1000)
      : null;
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, timedOut: false, out: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (timedOut && killSignal !== 'SIGKILL') killGroup('SIGKILL'); // stragglers
      resolve({ code: code ?? 1, timedOut, out });
    });
  });
}

export function realIo() {
  const main = defaultMainCheckout(ROOT);
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (s) => console.log(s),
    lockPath: defaultLockPath(ROOT),
    mainCheckout: main,
    tmpdir: tmpdir(),
    alive: isAlive,
    run: realRun,
    caffeinate: (pid) => {
      try {
        spawn('caffeinate', ['-i', '-w', String(pid)], {
          detached: true,
          stdio: 'ignore',
        })
          .on('error', () => {})
          .unref();
      } catch {
        // not macOS: no sleep inhibitor
      }
    },
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c);
    },
    copyFile: (a, b) => {
      mkdirSync(dirname(b), { recursive: true });
      copyFileSync(a, b);
    },
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    exists: (p) => existsSync(p),
  };
}
