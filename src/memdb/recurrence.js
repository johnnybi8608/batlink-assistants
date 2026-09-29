// Time arithmetic for recurring reminders:
//   1. Every occurrence is computed from the anchor as a whole number of periods, never by adding to the
//      previous occurrence (otherwise 1/31 -> 2/28 -> 3/28 keeps drifting).
//   2. Calendar arithmetic happens in the reminder's own time zone (local wall-clock time), so DST changes
//      never shift it by an hour.
//   3. Monthly rules: if the target month has no such day, the last day of that month is used.

/** Wall-clock time of a UTC instant in time zone tz */
export function wallClock(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Wall-clock time in tz -> UTC instant (a time that does not exist because of a DST jump moves past the jump) */
export function fromWallClock({ y, m, d, h, mi, s = 0 }, tz) {
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s);
  let t = asUtc;
  for (let i = 0; i < 3; i += 1) {
    const w = wallClock(new Date(t), tz);
    const diff = asUtc - Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
    if (diff === 0) break;
    t += diff;
  }
  return new Date(t);
}

export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Time zone used when a reminder does not specify one. Defaults to the system time zone;
 * callers set it from config.owner.timezone with setDefaultTimezone() (an empty value keeps the system zone).
 * Exported as a live binding, so importers always see the current value.
 */
export let DEFAULT_TIMEZONE = systemTimezone();

export function setDefaultTimezone(tz) {
  const value = String(tz ?? '').trim();
  if (value && !isValidTimezone(value)) throw new Error(`Invalid time zone: ${value}`);
  DEFAULT_TIMEZONE = value || systemTimezone();
  return DEFAULT_TIMEZONE;
}

/** Parse "YYYY-MM-DD HH:mm" in time zone tz into a UTC instant */
export function parseLocal(text, tz) {
  const m = String(text ?? '').trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return fromWallClock({ y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) }, tz);
}

/** Format a UTC instant in tz as "YYYY-MM-DD HH:mm(周X)" (shown to the AI / user, hence Chinese weekday) */
export function formatLocal(date, tz) {
  const w = wallClock(date, tz);
  const pad = (n) => String(n).padStart(2, '0');
  const weekday = '日一二三四五六'[new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay()];
  return `${w.y}-${pad(w.m)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}(周${weekday})`;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

/**
 * Instant of occurrence number `index` (0-based; 0 is the anchor itself)
 * @param {{ freq: 'day'|'week'|'month', interval: number, startsAt: Date, tz: string }} rule
 */
export function occurrence(rule, index) {
  if (index <= 0 || !rule.freq) return new Date(rule.startsAt);
  const a = wallClock(rule.startsAt, rule.tz);
  const n = Math.max(1, rule.interval || 1) * index;
  let y = a.y, m = a.m, d = a.d;
  if (rule.freq === 'day' || rule.freq === 'week') {
    const t = new Date(Date.UTC(a.y, a.m - 1, a.d + (rule.freq === 'week' ? 7 * n : n)));
    y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate();
  } else if (rule.freq === 'month') {
    const total = a.m - 1 + n;
    y = a.y + Math.floor(total / 12);
    m = (total % 12) + 1;
    d = Math.min(a.d, daysInMonth(y, m));
  }
  return fromWallClock({ y, m, d, h: a.h, mi: a.mi, s: a.s }, rule.tz);
}

/** Starting at index, find the first occurrence later than `after`; returns { index, at } */
export function nextOccurrenceAfter(rule, index, after) {
  let i = Math.max(0, index);
  let at = occurrence(rule, i);
  for (let guard = 0; at <= after && guard < 100000; guard += 1) {
    i += 1;
    at = occurrence(rule, i);
  }
  return { index: i, at };
}

/** Human-readable rule (shown to the AI / user, hence Chinese) */
export function describeRule(freq, interval) {
  if (!freq) return '一次性';
  const unit = { day: '天', week: '周', month: '个月' }[freq];
  return interval > 1 ? `每 ${interval} ${unit}` : `每${unit === '个月' ? '月' : unit}`;
}
