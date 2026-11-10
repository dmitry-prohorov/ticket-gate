// The supabase-next stack-preflight check (via a test-only CLI binding). Everything goes through an injected io: no
// docker, no stack, no network. Only SP-B1 and SP-C1 spawn a process (bash, node).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  NO_WEB_ENV,
  REQUIRED,
  checkStack,
  parseArgs,
  classify,
  parseDockerPs,
  projectId,
  runBounded,
  waitReady,
} from './__tests__/stack-preflight-cli.mjs';

const P = 'demo-project';
const UP = 'Up 5 minutes (healthy)';
const ALL = ['db', 'kong', 'auth', 'rest', 'realtime', 'inbucket', 'pg_meta'];

const psText = (over = {}, pid = P, base = ALL) => {
  const m = new Map(base.map((s) => [s, UP]));
  for (const [k, v] of Object.entries(over)) {
    if (v === null) m.delete(k);
    else m.set(k, v);
  }
  return [...m].map(([s, v]) => `supabase_${s}_${pid}\t${v}`).join('\n');
};

function fakeIo(over = {}) {
  const io = {
    projectId: () => P,
    dockerPs: async () => ({ ok: true, text: psText() }),
    probe: async () => 200,
    tcp: async () => true,
    portHolder: async () => null,
    hasWebEnv: () => true,
    anonKey: () => 'anon',
    ...over,
  };
  return io;
}
const stack = (text, extra = {}) =>
  fakeIo({ dockerPs: async () => ({ ok: true, text }), ...extra });
const E2E = { steps: ['e2e'] };

test('SP-0 healthy stack: no problems, no warnings, for every step id', async () => {
  const r = await checkStack(
    { steps: ['db', 'seed', 'integration', 'e2e'] },
    fakeIo(),
  );
  assert.deepEqual(r, { problems: [], warnings: [], transient: false });
});

test('SP-1 no containers: exactly the stopped line, no endpoint lines', async () => {
  const io = stack('', { probe: async () => null, tcp: async () => false });
  const r = await checkStack({ steps: ['db', 'integration', 'e2e'] }, io);
  assert.deepEqual(r.problems, [
    'the stack is stopped: run `pnpm supabase start`',
  ]);
});

test('SP-2 db created / exited / unhealthy past grace name the status; unhealthy within grace is transient', async () => {
  for (const status of [
    'Created',
    'Exited (137) 3 minutes ago',
    'Up 5 minutes (unhealthy)',
  ]) {
    const r = await checkStack(E2E, stack(psText({ db: status })));
    assert.equal(r.problems.length, 1, status);
    assert.match(r.problems[0], /^service db is /);
    assert.ok(r.problems[0].includes(`(${status})`), r.problems[0]);
    assert.ok(
      r.problems[0].endsWith('run `pnpm supabase stop && pnpm supabase start`'),
    );
    assert.equal(r.transient, false);
  }
  const fresh = await checkStack(
    E2E,
    stack(psText({ db: 'Up 20 seconds (unhealthy)' })),
  );
  assert.equal(fresh.transient, true);
  assert.equal(fresh.problems.length, 1);
  assert.doesNotMatch(fresh.problems[0], /stop/);
});

test('SP-3 unhealthy auth names docker restart with the injected project id', async () => {
  const bad = 'Up 5 minutes (unhealthy)';
  let r = await checkStack(E2E, stack(psText({ auth: bad })));
  assert.deepEqual(r.problems, [
    `service auth is unhealthy (${bad}): run \`docker restart supabase_auth_demo-project\``,
  ]);
  r = await checkStack(
    E2E,
    stack(psText({ auth: bad }, 'other'), { projectId: () => 'other' }),
  );
  assert.deepEqual(r.problems, [
    `service auth is unhealthy (${bad}): run \`docker restart supabase_auth_other\``,
  ]);
});

test('SP-3b a missing required service names stop and start', async () => {
  const r = await checkStack(E2E, stack(psText({ realtime: null })));
  assert.deepEqual(r.problems, [
    'service realtime is missing (no container): run `pnpm supabase stop && pnpm supabase start`',
  ]);
});

test('SP-4 imgproxy and pooler absent or unhealthy, all required healthy: silent', async () => {
  const text = `${psText()}\nsupabase_pooler_${P}\tUp 5 minutes (unhealthy)`;
  const r = await checkStack(E2E, stack(text));
  assert.deepEqual(r, { problems: [], warnings: [], transient: false });
});

test('SP-5 studio unhealthy: one warning, zero problems', async () => {
  const text = `${psText()}\nsupabase_studio_${P}\tUp 5 minutes (unhealthy)`;
  const r = await checkStack(E2E, stack(text));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, [
    'warning: service studio is unhealthy (Up 5 minutes (unhealthy)); no gate step needs it',
  ]);
});

test('SP-6 docker ps not answering: exactly the Docker line', async () => {
  const io = fakeIo({ dockerPs: async () => ({ ok: false, text: '' }) });
  const r = await checkStack({ steps: ['db', 'e2e'] }, io);
  assert.deepEqual(r.problems, [
    'Docker is not running (docker ps did not answer in 5 s): start Docker, then run `pnpm supabase start`',
  ]);
});

test('SP-7 API, REST, :54322 and Mailpit each down give their own line with their command', async () => {
  const cases = [
    [
      'integration',
      { probe: async (u) => (u.includes('auth/v1') ? null : 200) },
      'Supabase API (http://127.0.0.1:54321/auth/v1/health) does not answer: run `pnpm supabase stop && pnpm supabase start`',
    ],
    [
      'integration',
      { probe: async (u) => (u.includes('rest/v1') ? null : 200) },
      'REST (http://127.0.0.1:54321/rest/v1/) does not answer: run `pnpm supabase stop && pnpm supabase start`',
    ],
    [
      'db',
      { tcp: async () => false },
      'Postgres (127.0.0.1:54322) does not answer: run `pnpm supabase stop && pnpm supabase start`',
    ],
    [
      'e2e',
      { probe: async () => null },
      'Mailpit (http://127.0.0.1:54324/livez) does not answer: `docker restart supabase_inbucket_demo-project`',
    ],
  ];
  for (const [step, over, line] of cases) {
    const r = await checkStack({ steps: [step] }, fakeIo(over));
    assert.deepEqual(r.problems, [line], step);
  }
});

test('SP-8 REST answering 401 is a problem; the anon key is sent', async () => {
  const seen = [];
  const io = fakeIo({
    probe: async (url, headers) => {
      seen.push([url, headers]);
      return url.includes('rest/v1') ? 401 : 200;
    },
  });
  const r = await checkStack({ steps: ['integration'] }, io);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^REST \(/);
  const rest = seen.find(([u]) => u.includes('rest/v1'));
  assert.equal(rest[1].apikey, 'anon');
});

test('SP-9 :3000 held names the pid and the cwd', async () => {
  const io = fakeIo({ portHolder: async () => ({ pid: 4242, cwd: '/x/fp' }) });
  const r = await checkStack(E2E, io);
  assert.deepEqual(r.problems, [
    'port 3000 is held by pid 4242 (cwd /x/fp): stop that server; the gate starts its own',
  ]);
});

test('SP-10 no apps/web/.env.local on an e2e plan: the noWebEnv text', async () => {
  const r = await checkStack(E2E, fakeIo({ hasWebEnv: () => false }));
  assert.deepEqual(r.problems, [NO_WEB_ENV]);
  assert.match(
    NO_WEB_ENV,
    /cp apps\/web\/\.env\.example apps\/web\/\.env\.local/,
  );
});

test('SP-11 four independent problems at once, in service then endpoint order', async () => {
  const io = stack(psText({ auth: 'Up 5 minutes (unhealthy)' }), {
    probe: async () => null,
    portHolder: async () => ({ pid: 1, cwd: '/c' }),
    hasWebEnv: () => false,
  });
  const r = await checkStack(E2E, io);
  assert.equal(r.problems.length, 4);
  assert.match(r.problems[0], /^service auth is unhealthy/);
  assert.match(r.problems[1], /^Mailpit/);
  assert.match(r.problems[2], /^port 3000/);
  assert.equal(r.problems[3], NO_WEB_ENV);
});

test('SP-12 db and seed plans ignore kong, rest, realtime and inbucket', async () => {
  const text = psText({}, P, ['db', 'pg_meta']);
  for (const step of ['db', 'seed']) {
    const r = await checkStack({ steps: [step] }, stack(text));
    assert.deepEqual(r.problems, [], step);
  }
});

test('SP-13 an unrecognised container line is one problem holding the raw text', async () => {
  for (const bad of [
    `supabase_dbx_${P}\tUp 5 minutes`,
    `foo_${P}\tUp 5 minutes`,
  ]) {
    const r = await checkStack(E2E, stack(`${psText()}\n${bad}`));
    assert.equal(r.problems.length, 1, bad);
    assert.ok(
      r.problems[0].startsWith(`unrecognised containers for project ${P}:`),
    );
    assert.ok(r.problems[0].includes(bad));
    assert.equal(r.transient, false);
  }
});

test('SP-14 classify and parseDockerPs on docker status text', () => {
  assert.equal(classify('Up 5 minutes (healthy)'), 'healthy');
  assert.equal(classify('Up 5 minutes'), 'healthy');
  assert.equal(classify('Up 3 seconds (health: starting)'), 'starting');
  assert.equal(classify('Up Less than a second (unhealthy)'), 'starting');
  assert.equal(classify('Up 59 seconds (unhealthy)'), 'starting');
  assert.equal(classify('Up About a minute (unhealthy)'), 'stuck');
  assert.equal(classify('Up 2 hours (unhealthy)'), 'stuck');
  assert.equal(classify('Exited (1) 2 seconds ago'), 'stuck');
  assert.equal(classify('Restarting (1) 5 seconds ago'), 'stuck');
  assert.equal(classify('Up 5 minutes (Paused)'), 'stuck');
  const { services, unknown } = parseDockerPs('', P);
  assert.equal(services.size, 0);
  assert.deepEqual(unknown, []);
  assert.equal(projectId('project_id = "abc"\n'), 'abc');
  assert.throws(() => projectId('x = 1'), /no project_id/);
});

function clock() {
  const t = { ms: 0, sleeps: [] };
  t.now = () => t.ms;
  t.sleep = async (ms) => {
    t.sleeps.push(ms);
    t.ms += ms;
  };
  return t;
}

test('SP-R1 waitReady polls while auth is starting, passes once healthy', async () => {
  const t = clock();
  let polls = 0;
  const io = fakeIo({
    dockerPs: async () => {
      polls += 1;
      const auth = polls <= 2 ? 'Up 2 seconds (health: starting)' : UP;
      return { ok: true, text: psText({ auth }) };
    },
  });
  const r = await waitReady(E2E, io, { forS: 90, sleep: t.sleep, now: t.now });
  assert.deepEqual(r.problems, []);
  assert.equal(polls, 3);
  assert.deepEqual(t.sleeps, [2000, 2000]);
});

test('SP-R2 never healthy: the starting line with the wait; a stuck problem returns after one poll', async () => {
  const t = clock();
  let polls = 0;
  const starting = fakeIo({
    dockerPs: async () => {
      polls += 1;
      return {
        ok: true,
        text: psText({ auth: 'Up 2 seconds (health: starting)' }),
      };
    },
  });
  const r = await waitReady(E2E, starting, {
    forS: 6,
    sleep: t.sleep,
    now: t.now,
  });
  assert.deepEqual(r.problems, [
    'service auth is starting (Up 2 seconds (health: starting)) after 6 s: run `docker restart supabase_auth_demo-project`',
  ]);
  assert.equal(polls, 4);

  const t2 = clock();
  let polls2 = 0;
  const stuck = fakeIo({
    dockerPs: async () => {
      polls2 += 1;
      return { ok: true, text: psText({ db: 'Exited (1) 1 minute ago' }) };
    },
  });
  const r2 = await waitReady(E2E, stuck, {
    forS: 90,
    sleep: t2.sleep,
    now: t2.now,
  });
  assert.equal(r2.problems.length, 1);
  assert.equal(polls2, 1);
  assert.deepEqual(t2.sleeps, []);
});

test('SP-R3 an endpoint that fails only because a service is starting does not end the wait', async () => {
  const t = clock();
  let polls = 0;
  const io = fakeIo({
    dockerPs: async () => {
      polls += 1;
      const auth = polls < 2 ? 'Up 2 seconds (health: starting)' : UP;
      return { ok: true, text: psText({ auth }) };
    },
    probe: async () => (polls < 2 ? null : 200),
  });
  const r = await waitReady({ steps: ['integration'] }, io, {
    forS: 30,
    sleep: t.sleep,
    now: t.now,
  });
  assert.deepEqual(r.problems, []);
  assert.equal(polls, 2);
});

test('SP-R4 an endpoint that misses once then answers within the wait is ok, and Mailpit is probed at /livez', async () => {
  const t = clock();
  const urls = [];
  let misses = 1;
  const io = fakeIo({
    probe: async (u) => {
      urls.push(u);
      if (u.includes(':54324') && misses > 0) {
        misses -= 1;
        return null;
      }
      return 200;
    },
  });
  const r = await waitReady(E2E, io, { forS: 20, sleep: t.sleep, now: t.now });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(t.sleeps, [2000]);
  assert.ok(urls.includes('http://127.0.0.1:54324/livez'));
  assert.ok(!urls.some((u) => u.includes('/api/v1/info')));
});

test('SP-R5 an endpoint that never answers within the wait ends with its problem line; with no wait it is final at once', async () => {
  const t = clock();
  const io = fakeIo({ probe: async () => null });
  const r = await waitReady(E2E, io, { forS: 6, sleep: t.sleep, now: t.now });
  assert.deepEqual(r.problems, [
    'Mailpit (http://127.0.0.1:54324/livez) does not answer: `docker restart supabase_inbucket_demo-project`',
  ]);
  assert.equal(t.sleeps.length, 3);
  const once = await checkStack(E2E, io);
  assert.equal(once.problems.length, 1);
});

test('SP-B1 runBounded past its limit: timedOut, code 124, the grandchild is dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-b1-'));
  const pidFile = join(dir, 'pid');
  const started = Date.now();
  const r = await runBounded(`sleep 30 & echo $! > ${pidFile}; wait`, {
    limitS: 1,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.code, 124);
  assert.ok(Date.now() - started < 7000);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  let alive = true;
  for (let i = 0; i < 20 && alive; i += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((r2) => setTimeout(r2, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the grandchild survived the group kill');
});

test('SP-B2 runBounded within its limit returns the output and exit code, and a step that exits 124 is not timedOut', async () => {
  const ok = await runBounded('echo hi; echo err >&2', { limitS: 10 });
  assert.deepEqual([ok.code, ok.timedOut], [0, false]);
  assert.match(ok.out, /hi/);
  assert.match(ok.out, /err/);
  const own = await runBounded('exit 124', { limitS: 10 });
  assert.deepEqual([own.code, own.timedOut], [124, false]);
  const nolimit = await runBounded('exit 3');
  assert.equal(nolimit.code, 3);
});

test('SP-C1 CLI: bad --steps or --wait exits 2 with the usage', () => {
  const cli = join(import.meta.dirname, '__tests__', 'stack-preflight-cli.mjs');
  for (const args of [
    ['--steps=bogus'],
    ['--steps=db', '--wait=x'],
    [],
    ['--steps=db', '--nope'],
  ]) {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: node tools\/stack-preflight\.mjs/);
  }
  assert.ok(existsSync(cli));
});

test('SP-MR1 mutation-registry is a known step that needs the e2e services and port 3000', async () => {
  assert.deepEqual(REQUIRED['mutation-registry'], REQUIRED.e2e);
  assert.deepEqual(parseArgs(['--steps=e2e,mutation-registry']).steps, [
    'e2e',
    'mutation-registry',
  ]);
  assert.match(parseArgs(['--steps=bogus']).error, /unknown step id bogus/);
  const MR = { steps: ['mutation-registry'] };
  // a missing realtime container is reported, as for e2e
  const noRealtime = stack(psText({ realtime: null }));
  const r = await checkStack(MR, noRealtime);
  assert.ok(
    r.problems.some((p) => /realtime/.test(p)),
    r.problems.join('\n'),
  );
  // Mailpit, port 3000 and the web env are probed for it too
  const probed = [];
  const io = fakeIo({
    probe: async (u) => {
      probed.push(u);
      return u.includes('54324') ? null : 200;
    },
    portHolder: async () => ({ pid: 7, cwd: '/c' }),
    hasWebEnv: () => false,
  });
  const bad = await checkStack(MR, io);
  assert.ok(probed.some((u) => u.includes('54324')));
  assert.ok(bad.problems.some((p) => p.startsWith('Mailpit')));
  assert.ok(bad.problems.some((p) => p.startsWith('port 3000')));
  assert.ok(bad.problems.includes(NO_WEB_ENV));
  assert.deepEqual(await checkStack(MR, fakeIo()), {
    problems: [],
    warnings: [],
    transient: false,
  });
});
