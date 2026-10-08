// ── Event that repeats ──
//
// 2026-09-07 case: the person asked for an appointment "every day on the 14th" and received
// a SINGLE event on the 14th, with a green confirmation check. It was not a hallucination:
// the create-event schemas (Google and Outlook) simply had no
// recurrence field, so there was no way for her request to reach the API. The assistant did
// what it could and reported as if it had done what she asked.
//
// This module is the missing piece, and it's deliberately STRUCTURED instead of
// accepting a raw RRULE from the model: recurrence is easy to write wrong
// (BYMONTHDAY vs BYDAY, UNTIL in UTC, COUNT vs UNTIL) and a mistake here only shows up
// weeks later, when the event didn't repeat. With named fields, validation
// happens BEFORE the call and an invalid request is rejected instead of becoming
// a silent single event.
//
// Output in two formats, from the same normalized object:
//   • Google Calendar -> RRULE array (RFC 5545)
//   • Microsoft Graph -> {pattern, range} object
// and a `descricao` in Portuguese that goes back to the model in the tool result, so
// it can confirm to the user what was actually created, not what they asked for.

const DIAS = {
  dom: { i: 0, rrule: 'SU', graph: 'sunday', nome: 'domingo' },
  seg: { i: 1, rrule: 'MO', graph: 'monday', nome: 'segunda' },
  ter: { i: 2, rrule: 'TU', graph: 'tuesday', nome: 'terça' },
  qua: { i: 3, rrule: 'WE', graph: 'wednesday', nome: 'quarta' },
  qui: { i: 4, rrule: 'TH', graph: 'thursday', nome: 'quinta' },
  sex: { i: 5, rrule: 'FR', graph: 'friday', nome: 'sexta' },
  sab: { i: 6, rrule: 'SA', graph: 'saturday', nome: 'sábado' },
};
const POR_INDICE = Object.values(DIAS).sort((a, b) => a.i - b.i);
const FREQS = ['diaria', 'semanal', 'mensal', 'anual'];

// Parameter schema, shared by the Google and Outlook tools so that
// the model sees exactly the same shape in both connectors.
export const REPETIR_SCHEMA = {
  type: 'object',
  description: 'OPTIONAL. Fill in ONLY when the event REPEATS ("toda segunda", "todo dia 14", "todo mês", "a cada 15 dias"). If the user asked for repetition and you do NOT pass this field, a single event will be created and their request will not have been fulfilled.',
  properties: {
    frequencia: { type: 'string', enum: FREQS, description: 'diaria, semanal, mensal or anual.' },
    intervalo: { type: 'integer', description: 'Every how many periods (default 1). E.g.: frequencia=semanal + intervalo=2 = every two weeks; frequencia=diaria + intervalo=15 = every 15 days.' },
    dias_da_semana: { type: 'array', items: { type: 'string', enum: Object.keys(DIAS) }, description: 'Only for frequencia=semanal. E.g. ["seg","qua"]. If omitted, repeats on the same weekday as the start date.' },
    dia_do_mes: { type: 'integer', description: 'Only for frequencia=mensal. E.g. 14 = every 14th. If omitted, uses the day of the start date.' },
    ate: { type: 'string', description: 'OPTIONAL. Date on which the repetition ends (YYYY-MM-DD). Without "ate" and without "ocorrencias", repeats with no end date.' },
    ocorrencias: { type: 'integer', description: 'OPTIONAL. Total number of repetitions (alternative to "ate"). Do not use both together.' },
  },
  required: ['frequencia'],
};

const soData = (v) => String(v || '').slice(0, 10);
const brData = (d) => { const [a, m, dia] = soData(d).split('-'); return dia ? `${dia}/${m}/${a}` : soData(d); };

/**
 * Validates and normalizes the `repetir` coming from the model.
 * Returns `{ erro }` when the request doesn't add up, and in that case the caller must
 * REFUSE the creation, never fall back to a single event.
 */
export function normalizarRepeticao(repetir, inicioISO) {
  if (repetir == null) return null;
  if (typeof repetir !== 'object' || Array.isArray(repetir)) return { erro: 'O campo "repetir" precisa ser um objeto com pelo menos "frequencia".' };

  const freq = String(repetir.frequencia || '').trim().toLowerCase();
  if (!FREQS.includes(freq)) return { erro: `"frequencia" precisa ser uma de: ${FREQS.join(', ')}. Veio "${repetir.frequencia ?? ''}".` };

  const intervalo = Math.max(1, Math.floor(Number(repetir.intervalo) || 1));
  if (intervalo > 999) return { erro: '"intervalo" absurdo (máximo 999).' };

  // The start date drives the defaults: day of week and day of month come from it
  // when the user didn't specify them.
  const base = new Date(`${soData(inicioISO)}T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return { erro: `Não entendi a data de início ("${inicioISO}"), então não dá pra montar a repetição.` };

  let dias = null;
  if (freq === 'semanal') {
    const pedidos = Array.isArray(repetir.dias_da_semana) ? repetir.dias_da_semana : [];
    if (pedidos.length) {
      const chaves = pedidos.map((d) => String(d).trim().toLowerCase().slice(0, 3));
      const invalido = chaves.find((c) => !DIAS[c]);
      if (invalido) return { erro: `Dia da semana desconhecido em "dias_da_semana": "${invalido}". Use ${Object.keys(DIAS).join(', ')}.` };
      dias = [...new Set(chaves.map((c) => DIAS[c].i))].sort((a, b) => a - b);
    } else {
      dias = [base.getUTCDay()];
    }
  } else if (Array.isArray(repetir.dias_da_semana) && repetir.dias_da_semana.length) {
    return { erro: '"dias_da_semana" só vale com frequencia=semanal.' };
  }

  let diaDoMes = null;
  if (freq === 'mensal') {
    const d = repetir.dia_do_mes == null ? base.getUTCDate() : Math.floor(Number(repetir.dia_do_mes));
    if (!Number.isFinite(d) || d < 1 || d > 31) return { erro: '"dia_do_mes" precisa ser um número de 1 a 31.' };
    // Day 29/30/31 doesn't exist in every month: the event simply disappears in
    // short months. Better to warn now than have the person find out in February.
    diaDoMes = d;
  } else if (repetir.dia_do_mes != null) {
    return { erro: '"dia_do_mes" só vale com frequencia=mensal. Pra anual, a data de início já define o dia.' };
  }

  const ate = repetir.ate ? soData(repetir.ate) : null;
  if (ate && !/^\d{4}-\d{2}-\d{2}$/.test(ate)) return { erro: '"ate" precisa estar no formato AAAA-MM-DD.' };
  if (ate && ate < soData(inicioISO)) return { erro: `"ate" (${brData(ate)}) é antes da data de início (${brData(inicioISO)}).` };

  const ocorrencias = repetir.ocorrencias == null ? null : Math.floor(Number(repetir.ocorrencias));
  if (ocorrencias != null && (!Number.isFinite(ocorrencias) || ocorrencias < 2)) return { erro: '"ocorrencias" precisa ser um número de 2 pra cima (1 ocorrência é evento único, não repetição).' };
  if (ate && ocorrencias != null) return { erro: 'Use "ate" OU "ocorrencias", não os dois.' };

  const norma = { freq, intervalo, dias, diaDoMes, ate, ocorrencias, inicio: soData(inicioISO) };
  norma.descricao = descreve(norma);
  norma.aviso = diaDoMes && diaDoMes > 28
    ? `Atenção: dia ${diaDoMes} não existe em todos os meses, então nesses meses o evento não vai acontecer.`
    : null;
  return norma;
}

function descreve({ freq, intervalo, dias, diaDoMes, ate, ocorrencias }) {
  let base;
  if (freq === 'diaria') base = intervalo === 1 ? 'todo dia' : `a cada ${intervalo} dias`;
  else if (freq === 'semanal') {
    const nomes = (dias || []).map((i) => POR_INDICE[i].nome);
    const lista = nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : nomes[0];
    base = intervalo === 1 ? `toda ${lista}` : `a cada ${intervalo} semanas, ${lista}`;
  } else if (freq === 'mensal') base = intervalo === 1 ? `todo dia ${diaDoMes} do mês` : `a cada ${intervalo} meses, no dia ${diaDoMes}`;
  else base = intervalo === 1 ? 'todo ano, na mesma data' : `a cada ${intervalo} anos, na mesma data`;

  if (ate) return `${base}, até ${brData(ate)}`;
  if (ocorrencias) return `${base}, ${ocorrencias} vezes`;
  return `${base}, sem data pra terminar`;
}

// UTC instant of the end of day `ate` in the user's timezone. The RRULE's UNTIL is always
// in UTC: without this conversion, someone in São Paulo (UTC-3) would lose the last
// occurrence when the event is at night.
function untilUtc(ate, tz) {
  const [y, m, d] = ate.split('-').map(Number);
  const chute = Date.UTC(y, m - 1, d, 23, 59, 59);
  let off = 0;
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Sao_Paulo', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date(chute)).map((x) => [x.type, x.value]));
    const comoLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    off = comoLocal - chute; // how far the timezone is ahead of UTC, in ms
  } catch { off = 0; } // fuso desconhecido: cai no UTC puro em vez de quebrar
  const inst = new Date(chute - off);
  return `${inst.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/** Google Calendar: campo `recurrence` do evento (array de linhas RFC 5545). */
export function paraGoogle(n, tz) {
  const p = [`FREQ=${{ diaria: 'DAILY', semanal: 'WEEKLY', mensal: 'MONTHLY', anual: 'YEARLY' }[n.freq]}`];
  if (n.intervalo > 1) p.push(`INTERVAL=${n.intervalo}`);
  if (n.freq === 'semanal' && n.dias?.length) p.push(`BYDAY=${n.dias.map((i) => POR_INDICE[i].rrule).join(',')}`);
  if (n.freq === 'mensal' && n.diaDoMes) p.push(`BYMONTHDAY=${n.diaDoMes}`);
  if (n.ocorrencias) p.push(`COUNT=${n.ocorrencias}`);
  else if (n.ate) p.push(`UNTIL=${untilUtc(n.ate, tz)}`);
  return [`RRULE:${p.join(';')}`];
}

/** Microsoft Graph: campo `recurrence` do evento ({pattern, range}). */
export function paraGraph(n, tz) {
  const pattern = { type: { diaria: 'daily', semanal: 'weekly', mensal: 'absoluteMonthly', anual: 'absoluteYearly' }[n.freq], interval: n.intervalo };
  // The Graph REQUIRES daysOfWeek on weekly and dayOfMonth on absoluteMonthly; on
  // absoluteYearly it requires dayOfMonth AND month, both coming from the start date.
  if (n.freq === 'semanal') pattern.daysOfWeek = (n.dias || []).map((i) => POR_INDICE[i].graph);
  if (n.freq === 'mensal') pattern.dayOfMonth = n.diaDoMes;
  if (n.freq === 'anual') {
    const [y, m, d] = n.inicio.split('-').map(Number);
    pattern.dayOfMonth = d; pattern.month = m; void y;
  }
  const range = { startDate: n.inicio, recurrenceTimeZone: tz || 'America/Sao_Paulo' };
  if (n.ocorrencias) { range.type = 'numbered'; range.numberOfOccurrences = n.ocorrencias; }
  else if (n.ate) { range.type = 'endDate'; range.endDate = n.ate; }
  else range.type = 'noEnd';
  return { pattern, range };
}
