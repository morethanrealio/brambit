// Common, strict contract: a cadence anchored on the FIRST local start.
// Does not accept raw RRULE/Graph: unknown fields are never discarded.
import { defaultTimezone } from './locale.mjs';
export const recurrenceSchema = {
  type: 'object', additionalProperties: false, required: ['frequencia'],
  description: 'REQUIRED for a recurring request. Cadence based on the first start date/time: monthly at 2026-09-14T08:30:00 = every 14th at 08:30. Supports daily, weekly on the same day, monthly (days 1–28) and yearly (except 02/29). For other patterns, do NOT create a single event: explain the limitation. No quantidade/ate = no end, show this when confirming.',
  properties: {
    frequencia: { type: 'string', enum: ['diaria', 'semanal', 'mensal', 'anual'] },
    intervalo: { type: 'integer', minimum: 1, maximum: 99, description: 'Every N days/weeks/months/years. Default 1.' },
    quantidade: { type: 'integer', minimum: 1, maximum: 10000, description: 'Total occurrences, including the first; do not combine with ate.' },
    ate: { type: 'string', description: 'Last allowed day (inclusive), YYYY-MM-DD, in the event\'s time zone. Do not combine with quantidade.' },
  },
};
const CONFIG = {
  diaria: ['DAILY', 'daily'], semanal: ['WEEKLY', 'weekly'],
  mensal: ['MONTHLY', 'absoluteMonthly'], anual: ['YEARLY', 'absoluteYearly'],
};
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function normalizeRecurrence(value, start, timezone = defaultTimezone()) {
  if (value === undefined) return null; // missing field: preserves single events
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recorrencia deve ser um objeto válido, não criar evento único.');
  if (Object.keys(value).some(k => !Object.hasOwn(recurrenceSchema.properties, k))) throw new Error('Campo/padrão de recorrência não suportado. Não criar evento único.');
  if (!Object.hasOwn(CONFIG, value.frequencia)) throw new Error('Frequência de recorrência inválida.');
  const intervalo = value.intervalo === undefined ? 1 : value.intervalo;
  if (!Number.isInteger(intervalo) || intervalo < 1 || intervalo > 99) throw new Error('Intervalo deve ser inteiro entre 1 e 99.');
  const match = String(start || '').match(/^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match || !validDate(match[1])) throw new Error('Recorrência exige início local válido com horário, sem offset, e fuso IANA. Eventos recorrentes de dia inteiro ainda não são suportados.');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new Error('Fuso IANA inválido para recorrência.'); }
  const date = match[1], day = +date.slice(8), month = +date.slice(5, 7);
  if (value.frequencia === 'mensal' && day > 28) throw new Error('Recorrência mensal nos dias 29–31 precisa definir como tratar meses curtos; ainda não suportada. Não criar evento único.');
  if (value.frequencia === 'anual' && month === 2 && day === 29) throw new Error('Recorrência anual em 29/02 ainda não suportada. Não criar evento único.');
  if (value.quantidade !== undefined && (!Number.isInteger(value.quantidade) || value.quantidade < 1 || value.quantidade > 10000)) throw new Error('Quantidade deve ser inteira entre 1 e 10000.');
  if (value.ate !== undefined && (!validDate(value.ate) || value.ate < date)) throw new Error('Data final inválida ou anterior ao início da série.');
  if (value.ate !== undefined && value.quantidade !== undefined) throw new Error('Use quantidade OU ate, nunca os dois.');
  return { frequencia: value.frequencia, intervalo, date, day, month, timezone,
    weekday: new Date(date + 'T00:00:00Z').getUTCDay(), quantidade: value.quantidade, ate: value.ate };
}
// UNTIL is UTC for a series with time. Converts the LOCAL end of day via IANA,
// not a fixed offset (which would be wrong across daylight saving time).
function untilUtc(date, timezone) {
  const target = Date.parse(date + 'T23:59:59Z');
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = target;
  for (let i = 0; i < 5; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(instant)).map(x => [x.type, x.value]));
    const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    if (wall === target) return new Date(instant).toISOString().replace(/[-:]/g, '').replace('.000', '');
    instant += target - wall;
  }
  throw new Error('Data final não existe nesse fuso; confirme outra data antes de criar.');
}
export function calendarRecurrence(value, start, timezone) {
  const r = normalizeRecurrence(value, start, timezone);
  if (!r) return null;
  localDateTimeInstant(start,r.timezone);
  let rule = `RRULE:FREQ=${CONFIG[r.frequencia][0]};INTERVAL=${r.intervalo}`;
  if (r.frequencia === 'mensal' || r.frequencia === 'anual') rule += `;BYMONTHDAY=${r.day}`;
  if (r.frequencia === 'anual') rule += `;BYMONTH=${r.month}`;
  if (r.ate) rule += `;UNTIL=${untilUtc(r.ate, r.timezone)}`;
  if (r.quantidade !== undefined) rule += `;COUNT=${r.quantidade}`;
  const pattern = { type: CONFIG[r.frequencia][1], interval: r.intervalo };
  if (r.frequencia === 'semanal') { pattern.daysOfWeek = [DAYS[r.weekday]]; pattern.firstDayOfWeek = 'monday'; }
  if (r.frequencia === 'mensal' || r.frequencia === 'anual') pattern.dayOfMonth = r.day;
  if (r.frequencia === 'anual') pattern.month = r.month;
  const range = { type: r.ate ? 'endDate' : r.quantidade !== undefined ? 'numbered' : 'noEnd', startDate: r.date, recurrenceTimeZone: r.timezone };
  if (r.ate) range.endDate = r.ate;
  if (r.quantidade !== undefined) range.numberOfOccurrences = r.quantidade;
  return { google: [rule], outlook: { pattern, range }, normalized: r };
}
export function recurrenceLabel(value, start, timezone, language = 'pt-BR') {
  const r = calendarRecurrence(value, start, timezone)?.normalized;
  if (!r) return '';
  const lang = String(language || 'pt-BR').slice(0, 2);
  const units = { pt: ['dias', 'semanas', 'meses', 'anos'], en: ['days', 'weeks', 'months', 'years'], es: ['días', 'semanas', 'meses', 'años'] };
  const l = units[lang] ? lang : 'pt';
  const unit = units[l][Object.keys(CONFIG).indexOf(r.frequencia)];
  const prefix = { pt: 'Recorrência', en: 'Recurrence', es: 'Recurrencia' }[l];
  const every = { pt: 'a cada', en: 'every', es: 'cada' }[l];
  const from = { pt: 'a partir de', en: 'starting', es: 'desde' }[l];
  const end = r.ate ? `${{ pt: 'até', en: 'through', es: 'hasta' }[l]} ${r.ate}`
    : r.quantidade !== undefined ? `${r.quantidade} ${{ pt: 'ocorrências', en: 'occurrences', es: 'ocurrencias' }[l]}`
    : { pt: 'sem data final', en: 'no end date', es: 'sin fecha final' }[l];
  const onDay = r.frequencia === 'mensal' ? `, ${{ pt: 'dia', en: 'day', es: 'día' }[l]} ${r.day}` : '';
  return `${prefix}: ${every} ${r.intervalo} ${unit}${onDay}; ${from} ${start} (${r.timezone}); ${end}.`;
}

// Adding a wall-clock hour cannot depend on the Node process's TZ.
export function recurrenceDefaultEnd(localStart) {
  return new Date(new Date(localStart + 'Z').getTime() + 3600000).toISOString().slice(0, 19);
}

// Wall-clock time -> instant, without depending on the process's TZ. Rejects the
// nonexistent time of entering daylight saving time. On the repeated hour, uses the first.
export function localDateTimeInstant(local, timezone = defaultTimezone()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(String(local)) || !validDate(local.slice(0,10))) throw Error('Data/hora local inválida.');
  const wall = local.length === 16 ? local + ':00' : local;
  const target = Date.parse(wall+'Z');
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0,19) !== wall) throw Error('Data/hora local inválida.');
  const fmt = new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const asWall = instant => { const p=Object.fromEntries(fmt.formatToParts(new Date(instant)).map(x=>[x.type,x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`; };
  const candidates = new Set();
  for (const hours of [-36,0,36]) {
    const probe=target+hours*3600000, offset=Date.parse(asWall(probe)+'Z')-probe;
    const candidate=target-offset;
    if (asWall(candidate)===wall) candidates.add(candidate);
  }
  if (!candidates.size) throw Error('Esse horário local não existe no fuso informado (mudança de horário de verão). Escolha outro horário.');
  return new Date(Math.min(...candidates)).toISOString();
}

export function recurrenceOccurrences(value, start, timezone = defaultTimezone(), {after = null, limit = 3} = {}) {
  const r=normalizeRecurrence(value,start,timezone); if (!r) return [];
  localDateTimeInstant(start,timezone); // also validates the first occurrence
  const first=Date.parse(start+'Z'), out=[];
  if (!Number.isInteger(limit) || limit<1) throw Error('Limite de ocorrências inválido.');
  let begin=0;
  if (after) {
    const date=new Date(after); if (!Number.isFinite(date.getTime())) throw Error('Instante de referência inválido.');
    const startDate=new Date(first);
    const distance=r.frequencia==='mensal' ? (date.getUTCFullYear()-startDate.getUTCFullYear())*12+date.getUTCMonth()-startDate.getUTCMonth()
      : r.frequencia==='anual' ? date.getUTCFullYear()-startDate.getUTCFullYear()
      : (date.getTime()-first)/86400000/(r.frequencia==='semanal'?7:1);
    begin=Math.max(0,Math.floor(distance/r.intervalo)-2); // margin for timezone/DST differences
  }
  const max=Math.min(r.quantidade ?? Infinity,begin+Math.min(limit,10)+370);
  for (let i=begin; i<max && out.length<Math.min(limit,10); i++) {
    const d=new Date(first), n=i*r.intervalo;
    if (r.frequencia==='diaria') d.setUTCDate(d.getUTCDate()+n);
    else if (r.frequencia==='semanal') d.setUTCDate(d.getUTCDate()+n*7);
    else if (r.frequencia==='mensal') d.setUTCMonth(d.getUTCMonth()+n);
    else d.setUTCFullYear(d.getUTCFullYear()+n);
    const local=d.toISOString().slice(0,19);
    if (r.ate && local.slice(0,10)>r.ate) break;
    let instant;
    try { instant=localDateTimeInstant(local,timezone); } catch { continue; } // a nonexistent wall-clock time doesn't turn into another time
    if (after && Date.parse(instant)<=Date.parse(after)) continue;
    out.push({local,instant});
  }
  return out;
}

export function calendarWindow({inicio,fim,fuso=defaultTimezone(),days=30,now=new Date()}={}) {
  const parse=value=> /(?:Z|[+-]\d{2}:\d{2})$/i.test(String(value)) ? new Date(value).toISOString() : localDateTimeInstant(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? value+'T00:00:00' : value,fuso);
  new Intl.DateTimeFormat('en',{timeZone:fuso}).format();
  const from=inicio ? parse(inicio) : new Date(now).toISOString();
  if (!Number.isSafeInteger(days) || days<1 || days>366) throw Error('Janela em dias deve estar entre 1 e 366.');
  const to=fim ? parse(fim) : new Date(Date.parse(from)+days*86400000).toISOString();
  if (Date.parse(to)<=Date.parse(from) || Date.parse(to)-Date.parse(from)>366*86400000) throw Error('A janela deve ter fim posterior ao início e no máximo 366 dias.');
  return {from,to};
}
