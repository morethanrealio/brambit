// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
// Dates without an explicit zone resolve in the instance default zone, here São Paulo.
process.env.BRAMBIT_DEFAULT_TIMEZONE = 'America/Sao_Paulo';
// Offline. APIs are mocks; sockets are blocked before importing connectors.
import assert from 'node:assert/strict';
import net from 'node:net';
net.Socket.prototype.connect = () => { throw new Error('REDE REAL PROIBIDA NO TESTE'); };
import { calendarRecurrence, recurrenceLabel } from '../web/calendar-recurrence.mjs';
let checks = 0;
const check = (condition, name) => { assert.ok(condition, name); checks++; };
const start = '2026-09-14T08:30:00', timezone = 'America/Sao_Paulo';
const monthly = { frequencia: 'mensal' };
const r = calendarRecurrence(monthly, start, timezone);
check(r.google[0] === 'RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=14', 'Google monthly day 14');
assert.deepEqual(r.outlook, { pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 14 }, range: { type: 'noEnd', startDate: '2026-09-14', recurrenceTimeZone: timezone } }); checks++;
check(calendarRecurrence(undefined, 'legacy-date') === null, 'single event preserved');
check(calendarRecurrence({ ...monthly, quantidade: 12 }, start).google[0].endsWith('COUNT=12'), 'Google count');
check(calendarRecurrence({ ...monthly, quantidade: 12 }, start).outlook.range.numberOfOccurrences === 12, 'Outlook count');
for (const [ate, expected] of [['2026-09-14', '20260915T025959Z'], ['2026-12-13', '20261214T025959Z'], ['2026-12-14', '20261215T025959Z']]) {
 const a = calendarRecurrence({ ...monthly, ate }, start);
 check(a.google[0].endsWith(`UNTIL=${expected}`), `inclusive local end date ${ate}`);
 check(a.outlook.range.endDate === ate, 'Graph end date');
}
check(calendarRecurrence({ ...monthly, intervalo: 2 }, start).google[0].includes('INTERVAL=2'), 'bimonthly');
check(calendarRecurrence({ frequencia: 'semanal' }, start).outlook.pattern.daysOfWeek[0] === 'monday', 'weekly same day');
check(calendarRecurrence({ frequencia: 'diaria', quantidade: 3 }, start).google[0].endsWith('COUNT=3'), 'daily');
check(calendarRecurrence({ frequencia: 'anual' }, start).outlook.pattern.month === 9, 'annual');
check(calendarRecurrence({ ...monthly, ate: '2027-02-28' }, start, 'Europe/Zurich').google[0].endsWith('UNTIL=20270228T225959Z'), 'end uses the winter offset, not the start\'s');
check(calendarRecurrence({ ...monthly, ate: '2026-09-30' }, start, 'Europe/Zurich').google[0].endsWith('UNTIL=20260930T215959Z'), 'end uses the summer offset');
check(calendarRecurrence({ ...monthly, ate: '2026-09-30' }, start, 'Asia/Kolkata').google[0].endsWith('UNTIL=20260930T182959Z'), 'half-hour timezone');
assert.throws(() => calendarRecurrence({ ...monthly, ate: '2011-12-30' }, '2011-11-14T08:30:00', 'Pacific/Apia')); checks++;
const invalid = [null, false, [], 'RRULE:FREQ=MONTHLY', {}, { frequencia: 'semanall' }, { ...monthly, intervalo: 0 }, { ...monthly, intervalo: null }, { ...monthly, intervalo: 1.5 }, { ...monthly, intervalo: '2' }, { ...monthly, quantidade: 0 }, { ...monthly, quantidade: '12' }, { ...monthly, quantidade: 2, ate: '2027-01-01' }, { ...monthly, ate: '2026-02-30' }, { ...monthly, ate: '2026-09-13' }, { ...monthly, dias: ['MO','WE'] }];
for (const value of invalid) { assert.throws(() => calendarRecurrence(value, start)); checks++; }
for (const badStart of ['2026-02-30T08:30:00', '2026-09-14', '2026-09-14T25:00:00', start + 'Z', start + '-03:00', '2026-09-30T08:30:00']) { assert.throws(() => calendarRecurrence(monthly, badStart)); checks++; }
assert.throws(() => calendarRecurrence(monthly, start, 'Not/AZone')); checks++;
assert.throws(() => calendarRecurrence({ frequencia: 'anual' }, '2028-02-29T08:30:00')); checks++;
// Imports don't initialize the server, the scheduler, nor migrate the database.
const { googleTools } = await import('../web/connectors.mjs');
const { microsoftTools } = await import('../web/connectors-ext.mjs');
const { gateTool, hasPending, takePending, describe, describeDone, renderConfirmed, setThreadLanguage } = await import('../web/confirm.mjs');
const calls = [];
globalThis.fetch = async (url, opts) => {
 if(String(url).startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList?') && (!opts.method || opts.method==='GET'))
  return {ok:true,json:async()=>({items:[{id:'primary',summary:'Principal',primary:true,accessRole:'owner'}]})};
 check(opts.method === 'POST', 'only POST is mocked for creation');
 check(String(url) === 'https://www.googleapis.com/calendar/v3/calendars/primary/events' || String(url) === 'https://graph.microsoft.com/v1.0/me/events', 'endpoint allowed in the mock');
 calls.push({ url, body: JSON.parse(opts.body) });
 return { ok: true, json: async () => ({ id: 'mock-event', htmlLink: 'https://example.invalid/event', subject: 'Pagamento', start: { dateTime: start }, end: { dateTime: '2026-09-14T09:30:00' } }) };
};
const token = async () => 'mock-only';
const google = googleTools({ token, caps: { calendar: { write: true } } }).find(t => t.name === 'calendar_create');
const outlook = microsoftTools({ token }).find(t => t.name === 'outlook_calendar_create');
for (const [tool, args, bodyKey] of [
 [google, { title: 'Pagamento', start, timezone, recorrencia: monthly }, 'google'],
 [outlook, { titulo: 'Pagamento', inicio: start, fuso: timezone, recorrencia: monthly }, 'outlook'],
]) {
 check(tool.parameters.properties.recorrencia.required.includes('frequencia'), 'schema exposed');
 const key = tool.name, gated = gateTool(tool, key);
 const before = calls.length;
 const proposal = await gated.run(args);
 check(calls.length === before && hasPending(key), 'proposal can query the destination, but does NOT execute a write');
 check(proposal.includes('dia 14') && proposal.includes('08:30') && proposal.includes('sem data final'), 'confirmation shows cadence, time and duration');
 const pend = takePending(key); // simulates the owner's explicit approval
 const result = await pend.run(pend.args);
 check(JSON.parse(result).ok === true, 'creation returns success');
 assert.deepEqual(calls.at(-1).body.recurrence, r[bodyKey]); checks++;
 check(calls.at(-1).body.start.dateTime.startsWith(start), '08:30 not converted to UTC');
 check(calls.at(-1).body.start.timeZone === timezone, 'timezone at the start');
 check(calls.at(-1).body.end.dateTime === '2026-09-14T09:30:00', 'local end independent of the server TZ');
 check(renderConfirmed(pend, result).includes('dia 14'), 'outcome includes the series');
 for (const lang of ['pt-BR', 'en', 'es']) {
  check(describe(key, args, lang).includes('14') && describeDone(key, args, lang).includes(timezone), 'languages show recurrence/timezone');
 }
 const single = { ...args }; delete single.recorrencia;
 await tool.run(single);
 check(!('recurrence' in calls.at(-1).body), 'single event payload intact');
 const n = calls.length;
 const bad = { ...args, recorrencia: { ...monthly, intervalo: 0 } };
 check(JSON.parse(await gated.run(bad)).ok === false && !hasPending(key), 'invalid input does not create a pending item');
 check(JSON.parse(await tool.run(bad)).ok === false && calls.length === n, 'connector also refuses before HTTP');
 // Case repro: time change → new confirmation, without losing recurrence.
 const changed = { ...args, [key === 'calendar_create' ? 'start' : 'inicio']: '2026-09-14T09:00:00' };
 await gated.run(changed);
 check(takePending(key).args.recorrencia.frequencia === 'mensal', 'pending item keeps the series contract');
}
console.log(`${checks} verificações aprovadas (offline, sem banco/API real)`);
