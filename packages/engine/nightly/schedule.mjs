import { NIGHTLY_DEFAULTS } from './define.mjs';

export const IDLE_MS = 3_600_000,
  RETRY_MS = 1_800_000,
  E2E_LIMIT_S = 1800; // = the e2e step's limitS in gate.config.mjs

// ------------------------------------------------------------ local clock

/** Local wall-clock parts of `ms` in `tz` (default: the machine zone). */
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  });
  const p = Object.fromEntries(
    f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]),
  );
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
}

/** Epoch ms of a local wall-clock time (day overflow rolls over). */
function fromLocal({ y, mo, d, h, mi }, tz) {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let guess = asUtc;
  for (let i = 0; i < 2; i += 1) {
    const l = localParts(guess, tz);
    guess += asUtc - Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi);
  }
  return guess;
}

const hm = (t) => {
  const [h, m] = t.split(':').map(Number);
  return { h, mi: m };
};

export function triggerFor(nowMs, tz, window = NIGHTLY_DEFAULTS.window) {
  const { h, mi } = localParts(nowMs, tz);
  const min = h * 60 + mi;
  const start = hm(window.start);
  const end = hm(window.end);
  return min >= start.h * 60 + start.mi && min < end.h * 60 + end.mi
    ? 'scheduled'
    : 'catch-up';
}

export function deadlineFor(
  trigger,
  nowMs,
  tz,
  window = NIGHTLY_DEFAULTS.window,
) {
  const l = localParts(nowMs, tz);
  if (trigger === 'scheduled')
    return fromLocal({ ...l, ...hm(window.end) }, tz);
  const by = hm(window.catchUpBy);
  const today = fromLocal({ ...l, ...by }, tz);
  return today > nowMs ? today : fromLocal({ ...l, d: l.d + 1, ...by }, tz);
}

export function decide({ holder, released, nowMs, deadlineMs }) {
  // prettier-ignore
  const busy = holder !== null || (released !== null && nowMs - Date.parse(released.lastReleasedAt) < IDLE_MS);
  if (!busy) return 'start';
  return nowMs + RETRY_MS <= deadlineMs ? 'defer' : 'skipped-busy';
}

export const dayOf = (ms) => {
  const l = localParts(ms);
  return `${l.y}-${String(l.mo).padStart(2, '0')}-${String(l.d).padStart(2, '0')}`;
};
