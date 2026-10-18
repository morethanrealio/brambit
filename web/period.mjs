import { defaultTimezone } from './locale.mjs';

// Start and end of the calendar month in the instance time zone (global allowances,
// default report window). Resets on day 1. Returns UTC ISO strings.
export function currentPeriod(now = new Date(), timeZone = defaultTimezone()) {
  const p = partsIn(now.getTime(), timeZone);
  const ny = p.month === 12 ? p.year + 1 : p.year, nm = p.month === 12 ? 1 : p.month + 1;
  return { start: monthStart(p.year, p.month, timeZone), end: monthStart(ny, nm, timeZone) };
}

// Old name, kept for plugins that still import it.
export const currentPeriodBRT = currentPeriod;

// UTC instant of 00:00 on day 1 of year-month in timeZone (follows daylight saving).
function monthStart(year, month, timeZone) {
  const wall = Date.UTC(year, month - 1, 1);
  let t = wall - offsetAt(wall, timeZone);
  t = wall - offsetAt(t, timeZone);
  return new Date(t).toISOString();
}

// How far the wall clock of timeZone is ahead of UTC at instant t, in ms.
function offsetAt(t, timeZone) {
  const p = partsIn(t, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

function partsIn(t, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  return Object.fromEntries(fmt.formatToParts(t).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
}
