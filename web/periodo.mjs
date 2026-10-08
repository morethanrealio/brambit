// Start and end of the calendar month in the BR timezone (global franchises, default
// report window). Resets on day 1.
// Returns ISO with -03:00 offset (BR has had no daylight saving since 2019).
export function currentPeriodBRT(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit',
  }).formatToParts(now);
  const y = +parts.find((p) => p.type === 'year').value;
  const m = +parts.find((p) => p.type === 'month').value;
  const start = `${y}-${String(m).padStart(2, '0')}-01T00:00:00-03:00`;
  let ny = y, nm = m + 1; if (nm > 12) { nm = 1; ny++; }
  const end = `${ny}-${String(nm).padStart(2, '0')}-01T00:00:00-03:00`;
  return { start, end };
}
