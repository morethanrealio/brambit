import { driveSearchQuery, driveSearchParameters, DRIVE_SEARCH_RULE, completeDriveSearch } from './drive-search.mjs';
import { readGoogleDocument } from './document-read.mjs';
import { recortar } from './recorte.mjs';
import { emailHeader } from './security-boundaries.mjs';
import { searchPagination, searchCursorSchema, SEARCH_PAGINATION_RULE, searchItems, driveSearchMeta } from './search-pagination.mjs';
import { emailPagination, emailCursorSchema, EMAIL_PAGINATION_RULE } from './email-pagination.mjs';
import { recurrenceSchema, calendarRecurrence, recurrenceDefaultEnd, calendarWindow, recurrenceLabel, recurrenceOccurrences } from './calendar-recurrence.mjs';
// ── Google connectors as core tools ──
// Each connector becomes a tool (JSON Schema) that enters the harness tool-loop.
// They receive an async `token()` that returns a valid access_token (already
// refreshed). Reading is always allowed; writing (sending email, creating an
// event, uploading a file) when the user granted that service's write scope.
import { extractPdfText } from './pdf.mjs';
import { analisePlanilhaConector, tipoPlanilha } from './planilha.mjs';
import { ocrPdf, describeImage } from './media.mjs';
import { marca } from './marca.mjs';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCS = 'https://docs.googleapis.com/v1/documents';
const CAL = 'https://www.googleapis.com/calendar/v3';

async function gget(token, url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// A search prior to a write must prove absence or a single target.
// Never treat unavailability, an invalid response, or a partial page as empty.
const validDriveId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
async function uniqueDriveWriteTarget(token, q, label) {
  let r;
  try {
    r = await gget(token, `${DRIVE}/files?q=${encodeURIComponent(q)}&spaces=drive&pageSize=2&fields=nextPageToken,incompleteSearch,files(id,name,mimeType)`);
  } catch {
    throw new Error(`Não consegui conferir ${label} no Drive. Não vou criar uma cópia nem escolher um arquivo sem essa verificação. Tente novamente mais tarde.`);
  }
  if (!r || !Array.isArray(r.files)
      || (r.nextPageToken !== undefined && typeof r.nextPageToken !== 'string')
      || (r.incompleteSearch !== undefined && typeof r.incompleteSearch !== 'boolean')
      || r.files.some(f => !f || !validDriveId(f.id) || typeof f.name !== 'string' || typeof f.mimeType !== 'string')) {
    throw new Error(`Não consegui validar a resposta da busca de ${label} no Drive. A gravação foi interrompida.`);
  }
  if (r.nextPageToken || r.incompleteSearch) {
    throw new Error(`A busca de ${label} no Drive ficou incompleta. A gravação foi interrompida para não criar cópias nem alterar o arquivo errado.`);
  }
  if (r.files.length > 1) {
    throw new Error(`Encontrei mais de um resultado para ${label} no Drive. A gravação foi interrompida: é preciso resolver a duplicidade antes de continuar.`);
  }
  return r.files[0] || null;
}

// Folder identified by the app's marker, not by name. Duplicates and search
// failures also need to stop HERE, before creating a folder or searching for files.
const APP_FOLDER_TAG = { key: 'brambsAssistant', value: '1' };
export async function ensureAssistantFolder(token, folderName = marca().nome) {
  const q = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='${APP_FOLDER_TAG.key}' and value='${APP_FOLDER_TAG.value}' }`;
  const existing = await uniqueDriveWriteTarget(token, q, 'a pasta do assistente');
  if (existing) {
    if (existing.mimeType !== 'application/vnd.google-apps.folder') throw new Error('O resultado não é uma pasta do Drive. A gravação foi interrompida.');
    return existing.id;
  }
  const created = await gpost(token, `${DRIVE}/files?fields=id,name`, {
    name: folderName || marca().nome,
    mimeType: 'application/vnd.google-apps.folder',
    appProperties: { [APP_FOLDER_TAG.key]: APP_FOLDER_TAG.value },
  });
  if (!validDriveId(created?.id)) throw new Error('Não consegui confirmar o identificador da pasta criada no Drive. Confira o Drive antes de repetir.');
  return created.id;
}

// Authenticated JSON POST (used by write actions).
async function gpost(token, url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Authenticated JSON PATCH (partial update; used to edit an event).
async function gpatch(token, url, body, ifMatch = null) {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...(ifMatch ? {'If-Match':ifMatch} : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Authenticated DELETE (used to delete an event). 204 = no body.
async function gdel(token, url, ifMatch = null) {
  const r = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${await token()}`, ...(ifMatch ? {'If-Match':ifMatch} : {}) },
  });
  if (!r.ok && r.status !== 204) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return true;
}

const b64urlEncode = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Encodes a MIME header when it has a non-ASCII character (e.g. a subject with an accent).
const mimeWord = (s) =>
  /[^\x00-\x7F]/.test(s || '') ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : (s || '');

// Builds the raw MIME body (base64url) of an email. Used both by the draft
// and by sending.
function buildRawEmail({ to, subject, body, cc }) {
  const safeTo=emailHeader(to,'destinatário'), safeCc=emailHeader(cc,'cópia'), safeSubject=emailHeader(subject,'assunto');
  const headers = [`To: ${safeTo}`];
  if (safeCc) headers.push(`Cc: ${safeCc}`);
  headers.push(`Subject: ${mimeWord(safeSubject)}`);
  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit');
  return b64urlEncode(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

// Normalizes wall-clock time to the RFC3339 that Google requires. The model
// sometimes emits only HH:MM (no seconds), e.g. "2026-08-18T14:09", and Calendar
// responds with a generic 400 Bad Request because RFC3339 requires seconds. Here
// we complete it: zero-pad the hour and :00 in the seconds when missing, preserving
// fraction/offset if present. If it doesn't match the local date-time format (has
// a strange offset or something unexpected), lets it pass as is. Case from
// 2026-08-16: a medical appointment wasn't going in because of this.
const rfc3339Local = (v) => {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return s;
  const [, Y, Mo, D, h, mi, se, frac, off] = m;
  return `${Y}-${Mo}-${D}T${h.padStart(2, '0')}:${mi}:${se || '00'}${frac || ''}${off || ''}`;
};

// start/end for Calendar: ISO with time -> dateTime+tz; date only -> all-day.
// The tz (IANA) sets the event's timezone; default São Paulo, but the agent
// should pass the user's real timezone (e.g. America/Zurich for someone in Basel).
const calTime = (v, tz) =>
  /T\d/.test(v || '') ? { dateTime: rfc3339Local(v), timeZone: tz || 'America/Sao_Paulo' } : { date: v };

// ── Google calendars (calendarList) ──────────────────────────────────────────
// The product only read and wrote to `primary`. Whoever organizes their life
// across more than one calendar (work, a production company, a calendar someone
// else shared with them) got half an answer, and the tool didn't even know
// something was missing: there was no call to calendarList in the code at all
// (audit 2026-09-04).
// Here the set of calendars starts being DISCOVERED. No new OAuth scope:
// calendar.readonly/calendar.events already cover the whole account.
const CAL_FEED = /(holiday|contacts)@group\.v\.calendar\.google\.com$/i;
const semAcento = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Lists the account's calendars. Never throws: if the call fails (old
// permission, Google error), reading continues on the primary one, as before.
async function listCalendars(token) {
  try {
    const r = await gget(token, `${CAL}/users/me/calendarList?minAccessRole=reader&maxResults=250`);
    const items = (r.items || []).filter((c) => c.id && !c.deleted).map((c) => ({
      id: c.id,
      nome: c.summaryOverride || c.summary || c.id,
      principal: !!c.primary,
      // Automatic feed (holidays, birthdays): stays OUT of the default because
      // it clutters the day's calendar, but is still reachable by asking by name.
      feed: CAL_FEED.test(c.id),
      acesso: c.accessRole || '',
      catalog_partial: !!r.nextPageToken,
    }));
    if (items.length) return items;
  } catch { /* cai no fallback */ }
  return [{ id: 'primary', nome: 'principal', principal: true, feed: false, acesso: 'owner', catalog_partial:true }];
}

// Which calendar(s) the owner meant. Without `agenda`, ALL the real ones (no feed).
// Matches by exact id, exact name and then partial name, all accent-insensitive.
function pickCalendars(cals, agenda) {
  const q = semAcento(agenda);
  if (!q) return cals.filter((c) => !c.feed);
  if (q === 'todas' || q === 'todas as agendas' || q === 'all') return cals;
  if (q === 'principal' || q === 'primary') {
    const p = cals.filter((c) => c.principal);
    if (p.length) return p;
  }
  const exato = cals.filter((c) => c.id === agenda || semAcento(c.nome) === q);
  if (exato.length) return exato;
  return cals.filter((c) => semAcento(c.nome).includes(q) || q.includes(semAcento(c.nome)));
}

const calId = (c) => encodeURIComponent(c.id);

// Merges events from several calendars into ONE list: sorts by instant and cuts
// at the ceiling, stating when it cut. Outside the tool so it can be tested on
// its own. Why instant and not text: each calendar can have its own timezone and
// Google returns the offset inside the ISO, so "T09:00:00Z" would come before
// "T08:00:00-03:00" (which is 11:00Z) and the cut would drop the wrong event.
export function ordenarECortar(eventos, teto) {
  const inst = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER; };
  const todos = [...eventos].sort((a, b) => inst(a.start) - inst(b.start) || String(a.start || '').localeCompare(String(b.start || '')));
  const items = todos.slice(0, Math.max(1, teto));
  // With several calendars the ceiling is split between them and the list might
  // stop in the middle of the requested window. Without this note the assistant
  // would say "there's nothing on the 28th" while looking at a list that ended
  // on the 12th.
  const corte = todos.length > items.length
    ? `Couberam só os ${items.length} eventos mais próximos (${todos.length - items.length} ficaram de fora). A lista cobre até ${items[items.length - 1]?.start || '?'} e NÃO diz nada sobre o resto da janela: pra ver mais adiante, peça um período menor, uma agenda só, ou um max maior.`
    : null;
  return { items, corte };
}

// Calendar to WRITE to. Without `agenda`, the primary one (the usual default:
// nobody creates an event on someone else's shared calendar by accident). With
// a name, it resolves and requires write permission, otherwise Google would
// return a bare 403.
async function resolveWriteCalendar(token, agenda, {confirm = false} = {}) {
  if (!agenda && !confirm) return { cal: { id: 'primary', nome: 'principal' } };
  const cals = await listCalendars(token);
  if (confirm && cals.some(c => c.catalog_partial)) return {error:'Não consegui conferir todas as agendas e permissões dessa conta. Preciso concluir essa consulta antes de propor a alteração.'};
  const achadas = pickCalendars(cals, agenda || 'primary');
  if (!achadas.length) {
    return { error: `Não achei agenda com o nome "${agenda}". Você tem: ${cals.map((c) => c.nome).join(', ')}.` };
  }
  if (achadas.length > 1) {
    return { error: `"${agenda}" casou com mais de uma agenda (${achadas.map((c) => c.nome).join(', ')}). Diga qual.` };
  }
  const c = achadas[0];
  if (c.acesso && !['owner', 'writer'].includes(c.acesso)) {
    return { error: `Você só tem leitura na agenda "${c.nome}", não dá pra criar ou mudar evento nela.` };
  }
  return { cal: c };
}

// Prepare a real, immutable target before asking the person to approve. Account
// selection belongs to the authenticated connector; an agenda name never
// switches the Google account or changes the assistant's preference.
function calendarWriteConfirmation(tool, token, account) {
  const currentAccount = async () => String(typeof account === 'function' ? await account() : account || '');
  const eventSnapshot = event => ({id:event.id,summary:event.summary || '',start:event.start,end:event.end,etag:event.etag || null,
    description:event.description || '',
    location:event.location || '',attendees:(event.attendees || []).map(a => a.email).sort(),
    recurrence:event.recurrence || [],status:event.status || ''});
  const when = (value, language, timezone = 'America/Sao_Paulo') => {
    const s = String(value || ''), m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
    if (!m) return s;
    if (m[4] && /(?:Z|[+-]\d\d:\d\d)$/.test(s)) return new Intl.DateTimeFormat(language,{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:timezone}).format(new Date(s));
    const date = new Intl.DateTimeFormat(language,{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'})
      .format(new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]))));
    return `${date}${m[4] ? `, ${m[4]}:${m[5]}` : ''}`;
  };
  const labels = (args, descriptor) => Object.fromEntries(['pt-BR','en','es'].map(lang => {
    const {calendar,event} = descriptor;
    const title = args.title ?? event?.summary ?? '(sem título)';
    const start = args.start ?? event?.start?.dateTime ?? event?.start?.date;
    const end = args.end ?? event?.end?.dateTime ?? event?.end?.date
      ?? (/T\d/.test(start || '') ? recurrenceDefaultEnd(String(start).replace(/(?:Z|[+-]\d\d:\d\d)$/,'')) : start);
    const guests = args.attendees ?? event?.attendees ?? [];
    const tz = args.timezone || event?.start?.timeZone || 'America/Sao_Paulo';
    const action = tool.name === 'calendar_create' ? { 'pt-BR':'Criar',en:'Create',es:'Crear'}
      : tool.name === 'calendar_delete' ? {'pt-BR':'Excluir',en:'Delete',es:'Eliminar'} : {'pt-BR':'Atualizar',en:'Update',es:'Actualizar'};
    const destination = lang === 'en' ? 'Calendar' : lang === 'es' ? 'Calendario' : 'Agenda';
    const invitees = lang === 'en' ? (guests.length ? `Guests: ${guests.join(', ')}` : 'No guests')
      : lang === 'es' ? (guests.length ? `Invitados: ${guests.join(', ')}` : 'Sin invitados')
        : (guests.length ? `Convidados: ${guests.join(', ')}` : 'Sem convidados');
    const details = tool.name === 'calendar_update' ? [args.location !== undefined ? `${lang === 'en' ? 'Location' : 'Local'}: ${args.location || '—'}` : '',
      args.description !== undefined ? `${lang === 'en' ? 'Description' : lang === 'es' ? 'Descripción' : 'Descrição'}: ${args.description || '—'}` : ''].filter(Boolean).join('\n') : '';
    const repeat = args.recorrencia ? `\n${recurrenceLabel(args.recorrencia,start,tz,lang)} ${recurrenceOccurrences(args.recorrencia,start,tz).map(o => when(o.local,lang,tz)).join('; ')}` : '';
    return [lang,`${action[lang]} “${title}” — ${when(start,lang,tz)}${end ? `–${when(end,lang,tz)}` : ''} (${tz}).\n${destination}: ${calendar.nome}${descriptor.account ? ` · ${descriptor.account}` : ''}. ${invitees}.${details ? `\n${details}` : ''}${repeat}`.trim()];
  }));
  async function prepare(args, expected = null) {
    const selectedAccount = await currentAccount();
    if (expected && expected.account !== selectedAccount) throw Error('A conta Google mudou. Confira o destino novamente.');
    let requestedCalendar = expected?.calendar?.id || args.agenda;
    if (!requestedCalendar && tool.name !== 'calendar_create') {
      const existing = await resolveEventCalendar(token,args.id);
      if (existing.error) throw Error(existing.error);
      requestedCalendar = existing.cal.id;
    }
    const resolved = await resolveWriteCalendar(token,requestedCalendar,{confirm:true});
    if (resolved.error) throw Error(resolved.error);
    let event = null;
    if (tool.name !== 'calendar_create') {
      if (!args.id) throw Error('Preciso identificar o evento antes de propor a alteração.');
      const raw = await gget(token,`${CAL}/calendars/${calId(resolved.cal)}/events/${encodeURIComponent(args.id)}`);
      if (raw?.id !== args.id || raw.status === 'cancelled') throw Error('O evento não está mais disponível.');
      event = eventSnapshot(raw);
    }
    const descriptor = {kind:'google-calendar',account:selectedAccount,
      calendar:{id:resolved.cal.id,nome:resolved.cal.nome},event};
    if (expected && JSON.stringify(descriptor) !== JSON.stringify(expected)) throw Error('O evento ou a agenda mudou. Confira os novos detalhes antes de confirmar.');
    return {descriptor,labels:labels(args,descriptor),run:async () => {
      if (await currentAccount() !== descriptor.account) throw Error('A conta Google mudou.');
      return tool.run({...args,agenda:descriptor.calendar.id,
        timezone:args.timezone || descriptor.event?.start?.timeZone || 'America/Sao_Paulo',
        _confirmationEtag:descriptor.event?.etag || null});
    }};
  }
  return {...tool,prepareConfirmation:args => prepare(args),restoreConfirmation:(args,descriptor) => prepare(args,descriptor)};
}

// Calendar writes on ANY connected Google account (27/09/2026).
// Before, writes always went to the assistant's account, so an event read from
// the work calendar (reads cover all) couldn't be edited or deleted. Here each
// write tool gets `conta`: without it, it behaves as always; with it, the
// proposal, confirmation and execution use that account's token. `conta` stays
// in the saved args, so a restored confirmation goes back to the same account
// (and its descriptor still locks against an account swap).
// `contas` = e-mails with calendar write scope; `construir(conta)` returns
// the Google tools for that account.
export function calendarWritesPorConta(tools, { contas = [], padrao = '', construir }) {
  const nomes = ['calendar_create', 'calendar_update', 'calendar_delete'];
  const outras = contas.filter((c) => c && c !== padrao);
  if (!outras.length) return tools;
  const cache = new Map();
  const daConta = (conta, nome) => {
    if (!cache.has(conta)) cache.set(conta, construir(conta));
    return cache.get(conta).find((t) => t.name === nome);
  };
  return tools.map((tool) => {
    if (!nomes.includes(tool.name)) return tool;
    const alvo = ({ conta, ...args }) => {
      const c = conta ? String(conta).trim().toLowerCase() : '';
      if (!c || c === String(padrao).toLowerCase()) return { t: tool, args };
      const achada = outras.find((o) => o.toLowerCase() === c);
      if (!achada) throw Error(`A conta "${conta}" não está conectada com permissão de agenda. Contas disponíveis: ${[padrao, ...outras].filter(Boolean).join(', ')}.`);
      return { t: daConta(achada, tool.name), args };
    };
    return {
      ...tool,
      parameters: { ...tool.parameters, properties: { ...tool.parameters.properties,
        conta: { type: 'string', description: `OPTIONAL. Google account of the calendar, when it is not the default (${padrao}). Use the \`conta\` that came with the event in calendar_list. Available: ${[padrao, ...outras].filter(Boolean).join(', ')}.` } } },
      run: async (a = {}) => { let r; try { r = alvo(a); } catch (e) { return JSON.stringify({ ok: false, error: e.message }); } return r.t.run(r.args); },
      ...(tool.prepareConfirmation ? {
        prepareConfirmation: async (a = {}) => { const r = alvo(a); return r.t.prepareConfirmation(r.args); },
        restoreConfirmation: async (a = {}, d) => { const r = alvo(a); return r.t.restoreConfirmation(r.args, d); },
      } : {}),
    };
  });
}

// 404/410 = the event REALLY isn't in that calendar. Any other error
// (401, 403, 429, 5xx, network) means the check didn't actually happen: treating
// this as absence makes the tool swear to the owner that the event doesn't exist
// when Google just stumbled.
const naoRespondeu = (e) => !/^(404|410)\b/.test(String(e?.message || ''));

// Which calendar is this event in? Searches in parallel, with a ceiling. Also
// returns the calendars that didn't respond, so the caller doesn't confuse
// "it's not there" with "couldn't check".
async function findEventCalendar(token, eventId, cals) {
  const alvos = cals.slice(0, 12);
  const incertas = [];
  const achados = await Promise.all(alvos.map(async (c) => {
    try {
      await gget(token, `${CAL}/calendars/${calId(c)}/events/${encodeURIComponent(eventId)}`);
      return c;
    } catch (e) {
      if (naoRespondeu(e)) incertas.push(c.nome);
      return null;
    }
  }));
  return { cal: achados.find(Boolean) || null, incertas };
}

// Calendar of an event to EDIT/DELETE. The event id alone doesn't say which
// calendar it came from, and now that reading covers all of them, the AI finds
// an event that writing couldn't reach (404 on top of an event that exists).
// Tries the primary one first (1 request, the common case) and only then
// searches the others.
async function resolveEventCalendar(token, eventId, agenda) {
  if (agenda) return resolveWriteCalendar(token, agenda);
  const incertas = [];
  try {
    await gget(token, `${CAL}/calendars/primary/events/${encodeURIComponent(eventId)}`);
    return { cal: { id: 'primary', nome: 'principal' } };
  } catch (e) {
    // may be in another calendar; if Google didn't even respond, this gets flagged
    if (naoRespondeu(e)) incertas.push('principal');
  }
  const cals = await listCalendars(token);
  const editaveis = cals.filter((c) => !c.principal && !c.feed && (!c.acesso || ['owner', 'writer'].includes(c.acesso)));
  const r = editaveis.length ? await findEventCalendar(token, eventId, editaveis) : { cal: null, incertas: [] };
  if (r.cal) return { cal: r.cal };
  const duvida = [...incertas, ...r.incertas];
  // This text reaches the owner RAW (renderConfirmed glues `error` into the
  // message), so it's an actual sentence, not an instruction to the model.
  if (duvida.length) {
    const quais = duvida.length === 1 ? `a agenda "${duvida[0]}"` : `${duvida.length} agendas (${duvida.join(', ')})`;
    return { error: `Não consegui checar ${quais} agora: o Google não respondeu. Isso não quer dizer que o evento sumiu; vale tentar de novo em instantes.` };
  }
  return { error: 'Evento não encontrado em nenhuma agenda que você pode editar. Confira o id com calendar_list.' };
}

// Reading Gmail's payload lives in gmail-payload.mjs (no network calls),
// re-exported here for whoever already imported it from the connector.
import { extractGmailBody, readGmailBody, collectAttachments } from './gmail-payload.mjs';
export { extractGmailBody, collectAttachments };

// Decodes base64url to bytes (Gmail attachments come in base64url).
function b64urlBytes(data) {
  return Buffer.from((data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Identifies the type of a binary by its magic bytes, for when Gmail doesn't
// deliver the attachment's name/mime (see fetchGmailAttachment). Only the
// formats that actually show up as attachments; returns null with no match.
const MAGIC = [
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  { ext: 'png', mime: 'image/png', test: (b) => b.slice(0, 8).toString('hex') === '89504e470d0a1a0a' },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.slice(0, 3).toString('latin1') === 'GIF' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  // OOXML (docx/xlsx/pptx) is a zip: the real type comes from the 1st entry's name.
  { ext: 'zip', mime: 'application/zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
];
const OOXML = [
  { needle: 'word/', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { needle: 'xl/', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { needle: 'ppt/', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
];
export function sniffBinary(buf) {
  if (!buf || buf.length < 12) return null;
  const hit = MAGIC.find((m) => { try { return m.test(buf); } catch { return false; } });
  if (!hit) return null;
  if (hit.ext === 'zip') {
    // In OOXML files the path of the zip's 1st entry already says which one it is (word/, xl/, ppt/).
    const head = buf.slice(0, 2000).toString('latin1');
    const kind = OOXML.find((o) => head.includes(o.needle));
    if (kind) return { ext: kind.ext, mime: kind.mime };
  }
  return { ext: hit.ext, mime: hit.mime };
}

// Downloads the BYTES of a Gmail attachment and resolves name/type.
// The metadata (filename/mimeType) lives in the MESSAGE's payload, and the
// `find` by attachmentId comes back empty when the passed message id isn't the
// id of the message that owns the attachment (thread with several messages):
// the download works, but the file comes out as "attachment" with no mime.
// That's why: if not found in the message, sweeps the WHOLE thread; if still
// not found, infers it from the magic bytes.
export async function fetchGmailAttachment({ token, messageId, attachmentId }) {
  const m = await gget(token, `${GMAIL}/messages/${messageId}?format=full`);
  let att = collectAttachments(m.payload).find((a) => a.attachmentId === attachmentId);
  if (!att && m.threadId) {
    try {
      const th = await gget(token, `${GMAIL}/threads/${m.threadId}?format=full`);
      for (const msg of th.messages || []) {
        const hit = collectAttachments(msg.payload).find((a) => a.attachmentId === attachmentId);
        if (hit) { att = hit; break; }
      }
    } catch (e) { console.error('[gmail] varredura da thread pelo anexo falhou:', e?.message ?? e); }
  }
  const data = await gget(token, `${GMAIL}/messages/${messageId}/attachments/${attachmentId}`);
  const buffer = b64urlBytes(data.data);
  const sniffed = sniffBinary(buffer);
  const filename = att?.filename || (sniffed ? `anexo.${sniffed.ext}` : 'anexo');
  const mimeType = att?.mimeType || sniffed?.mime || '';
  return { buffer, filename, mimeType, size: att?.size || buffer.length, fromMetadata: !!att };
}

const header = (msg, name) =>
  (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

// Builds the tools for granted services from the read/write capabilities.
// `caps` = { gmail: { read, write }, drive: {...}, calendar: {...}, docs: {...} }.
export function googleTools({ token, caps = {}, account = '', onUsage = () => {}, onAccess = () => {}, folderName = marca().nome, onSheetLoad = null }) {
  // Trilha de auditoria: registra cada leitura de dado sensivel (Gmail/Drive/
  // Docs/Calendar). Fire-and-forget — nunca deixa a auditoria quebrar a tool.
  const audit = (tool, resource, detail) => { try { onAccess({ tool, resource, detail }); } catch { /* nunca quebra */ } };
  // OCR fallback for a scanned PDF (no text layer): when extractPdfText
  // comes back empty, sends the bytes to Gemini to read. Returns the tool's
  // ready-made JSON (with ocr:true) or null if that also fails.
  const ocrPdfFallback = async (buf, name, mime) => {
    try {
      const { text, usage } = await ocrPdf(buf);
      if (usage) onUsage({ usage, kind: 'vision' });
      if (text) return JSON.stringify({ name, mimeType: mime, ocr: true, text });
    } catch (e) {
      console.error('[connectors] ocrPdf falhou:', e?.message ?? e);
    }
    return null;
  };
  // Image OCR/vision (scanned attachment that came as .jpg/.png instead of PDF).
  const ocrImageFallback = async (buf, name, mime) => {
    try {
      const { text, usage } = await describeImage(buf, mime, 'Extraia TODO o texto legível desta imagem em português do Brasil. Se for um boleto ou guia (DAS, DARF, boleto bancário), destaque no início a LINHA DIGITÁVEL completa, o valor e a data de vencimento.');
      if (usage) onUsage({ usage, kind: 'vision' });
      if (text) return JSON.stringify({ name, mimeType: mime, ocr: true, text });
    } catch (e) {
      console.error('[connectors] describeImage falhou:', e?.message ?? e);
    }
    return null;
  };
  // Detects a PDF by its magic bytes (%PDF-), to catch an attachment that came
  // with the wrong mime (e.g. application/octet-stream) or no extension in the name.
  const sniffPdf = (buf) => !!buf && buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-';
  // Reads a PDF buffer: tries to extract text; if it comes back empty OR the
  // extractor throws, falls back to OCR (Gemini). Always returns a ready-made tool JSON.
  const readPdfBuf = async (buf, name, mime) => {
    let text = '', pages, truncated;
    try { ({ text, pages, truncated } = await extractPdfText(buf, { maxChars: 20000 })); }
    catch (e) { console.error('[connectors] extractPdfText erro:', e?.message ?? e); }
    if (text) return JSON.stringify({ name, mimeType: mime, pages, truncated, text });
    const ocr = await ocrPdfFallback(buf, name, mime);
    return ocr || JSON.stringify({ name, mimeType: mime, note: 'PDF sem texto extraível (escaneado); OCR também não conseguiu ler.' });
  };
  const tools = [];
  const can = (svc, op) => !!caps[svc]?.[op];

  // Gmail labels. Fetches the list once and builds a name→id map
  // (case-insensitive) + the system labels by canonical name
  // (INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH...). Used to resolve
  // names the AI passes (organize inbox, create filter) into real ids.
  async function fetchLabels(token) {
    const r = await gget(token, `${GMAIL}/labels`);
    return r.labels || [];
  }
  const SYSTEM_LABELS = ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SPAM', 'TRASH', 'DRAFT', 'SENT', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
  function labelNameToId(labels, name) {
    const n = String(name || '').trim();
    if (!n) return null;
    const up = n.toUpperCase();
    if (SYSTEM_LABELS.includes(up)) return up;
    const hit = labels.find((l) => (l.name || '').toLowerCase() === n.toLowerCase());
    return hit ? hit.id : null;
  }

  if (can('gmail', 'read')) {
    const accountPages = new Map();
    tools.push({
      name: 'gmail_search',
      description: 'Searches emails in the user\'s mailbox using Gmail search syntax (e.g. "from:fulano fatura newer_than:30d"). Returns messages (sender, subject, date, snippet, id), has_more and next_cursor. ' + EMAIL_PAGINATION_RULE,
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Query in Gmail search format.' }, max: { type: 'integer', minimum: 1, description: 'Page size (default 5; capped at 10).' }, cursor: emailCursorSchema }, required: ['query'] },
      async run({ query, max, cursor }) {
        const currentAccount = typeof account === 'function' ? await account() : account;
        if (!accountPages.has(currentAccount)) accountPages.set(currentAccount,emailPagination({ defaultMax: 5, cap: 10 }));
        const pages = accountPages.get(currentAccount);
        const page = pages.request(query, max, cursor);
        audit('gmail_search', 'gmail', `q=${String(query).slice(0, 120)}`);
        const list = await gget(token, `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=${page.pageSize}${page.position ? '&pageToken=' + encodeURIComponent(page.position) : ''}`);
        if (!list || typeof list !== 'object' || Array.isArray(list) || (list.messages !== undefined && !Array.isArray(list.messages))) throw new Error('Resposta de busca Gmail inválida; não considere ausência de e-mail.');
        if ((list.messages || []).length > page.pageSize || (list.messages || []).some(m => !m || typeof m.id !== 'string' || !m.id)) throw new Error('Lista Gmail inválida ou acima do limite solicitado.');
        const ids = (list.messages || []).map((m) => m.id);
        const out = [];
        for (const id of ids) {
          const m = await gget(token, `${GMAIL}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
          out.push({ id, account: currentAccount, link: `https://mail.google.com/mail/${currentAccount ? `?authuser=${encodeURIComponent(currentAccount)}` : ''}#all/${encodeURIComponent(id)}`, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), snippet: m.snippet });
        }
        return pages.result(page, out, list.nextPageToken, list.resultSizeEstimate);
      },
    });
    tools.push({
      name: 'gmail_read',
      description: 'Reads the useful text of an email by the id obtained from gmail_search, stripping HTML/CSS before the limit. Returns the button links and warns if the content was still cut off. Also lists the attachments (with attachmentId, name and type); to read an attachment\'s content use gmail_read_attachment.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        const currentAccount = typeof account === 'function' ? await account() : account;
        audit('gmail_read', 'gmail', `msg=${id}`);
        const m = await gget(token, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
        const content = readGmailBody(m.payload);
        const attachments = collectAttachments(m.payload).map((a) => ({ attachmentId: a.attachmentId, filename: a.filename, mimeType: a.mimeType, size: a.size }));
        // A long email (long thread, newsletter) was being cut without a flag, and
        // the model would answer "the email says X" having only read the start.
        // The PDF path and the spreadsheet path already return `truncated`; now
        // this one does too.
        return JSON.stringify({ id: m.id || id, account: currentAccount, link: `https://mail.google.com/mail/${currentAccount ? `?authuser=${encodeURIComponent(currentAccount)}` : ''}#all/${encodeURIComponent(id)}`, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null, ...content, attachments });
      },
    });
    tools.push({
      name: 'gmail_read_attachment',
      description: 'Reads the CONTENT (text) of an email attachment: PDF (extracts the text), text/JSON. A SPREADSHEET (Excel/CSV) does not come back as text: it is opened in the analysis environment and the result carries only the structure in the "analise" field; the content is queried with analisar_planilha. Pass the email id (from gmail_search) and the attachmentId (shown in the attachment list from gmail_read). For other binary formats it returns only the metadata. This does NOT save the file: to deliver the attachment as a FILE to the user (chat/Drive) there is the salvar_anexo_email tool in the main agent.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'email id' }, attachmentId: { type: 'string', description: 'attachmentId of the attachment (comes from gmail_read)' } }, required: ['id', 'attachmentId'] },
      async run({ id, attachmentId }) {
        audit('gmail_read_attachment', 'gmail', `msg=${id} att=${attachmentId}`);
        // Downloads the bytes and resolves name/type (message → thread → magic bytes).
        const { buffer: buf, filename: name, mimeType: mime, size, fromMetadata } = await fetchGmailAttachment({ token, messageId: id, attachmentId });
        console.log(`[gmail_read_attachment] name=${name} mime=${mime} size=${buf.length} meta=${fromMetadata}`);
        if (mime === 'application/pdf' || /\.pdf$/i.test(name) || sniffPdf(buf)) {
          return await readPdfBuf(buf, name, mime || 'application/pdf');
        }
        if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|tiff?|bmp)$/i.test(name)) {
          const ocr = await ocrImageFallback(buf, name, mime || 'image/jpeg');
          return ocr || JSON.stringify({ name, mimeType: mime, note: 'Imagem sem texto legível.' });
        }
        // A spreadsheet doesn't come back as text (see planilha.mjs).
        if (tipoPlanilha(name, mime)) {
          return JSON.stringify({ name, mimeType: mime, analise: await analisePlanilhaConector(onSheetLoad, buf, name, mime) });
        }
        if (mime.startsWith('text/') || mime === 'application/json' || /\.(txt|json|md)$/i.test(name)) {
          const att = recortar(buf.toString('utf8'), 12000, 'anexo');
          return JSON.stringify({ name, mimeType: mime, text: att.corpo, truncated: att.truncado || undefined });
        }
        return JSON.stringify({ name, mimeType: mime, size, note: 'Formato binário; não consigo ler o conteúdo como texto. Se o usuário quer o ARQUIVO em si, o agente principal salva e entrega com a tool salvar_anexo_email.' });
      },
    });
    tools.push({
      name: 'gmail_labels',
      description: 'Lists the LABELS (labels/folders) that exist in the user\'s Gmail account: the system ones (INBOX, IMPORTANT, etc.) and the ones they created, with id, name and how many emails each has. Use BEFORE organizing the inbox or creating a filter, to know which labels already exist and reuse them (do not duplicate).',
      parameters: { type: 'object', properties: {} },
      async run() {
        audit('gmail_labels', 'gmail', 'list');
        const labels = await fetchLabels(token);
        const out = labels.map((l) => ({ id: l.id, name: l.name, type: l.type, unread: l.messagesUnread, total: l.messagesTotal }));
        return JSON.stringify(out);
      },
    });
  }

  // ── Gmail label management (gmail.labels, sensitive scope): create/
  // edit/delete a label. Does NOT include organizing the already-received inbox
  // (bulk apply label/archive requires gmail.modify, which is CASA-restricted). ──
  if (can('gmail', 'manage')) {
    tools.push({
      name: 'gmail_label_create',
      description: 'Creates a new LABEL (label/folder) in the user\'s Gmail. Pass the name; to create a nested one use "Parent/Child" (e.g. "Trabalho/Faturas"). Check gmail_labels first to avoid duplicates. Reversible action.',
      parameters: { type: 'object', properties: {
        nome: { type: 'string', description: 'Label name (use "Parent/Child" to nest).' },
      }, required: ['nome'] },
      async run({ nome }) {
        audit('gmail_label_create', 'gmail', `name=${String(nome).slice(0, 60)}`);
        const r = await gpost(token, `${GMAIL}/labels`, {
          name: String(nome).trim(),
          labelListVisibility: 'labelShow',
          messageListVisibility: 'show',
        });
        return JSON.stringify({ ok: true, id: r.id, name: r.name });
      },
    });
    tools.push({
      name: 'gmail_label_update',
      description: 'Renames an existing Gmail label. Pass the current name (or the id) and the new name. Only the user\'s labels (system ones cannot be renamed).',
      parameters: { type: 'object', properties: {
        marcador: { type: 'string', description: 'Current label name (or its id).' },
        novo_nome: { type: 'string', description: 'New name.' },
      }, required: ['marcador', 'novo_nome'] },
      async run({ marcador, novo_nome }) {
        audit('gmail_label_update', 'gmail', `${String(marcador).slice(0, 40)}→${String(novo_nome).slice(0, 40)}`);
        const labels = await fetchLabels(token);
        const id = labels.find((l) => l.id === marcador)?.id || labelNameToId(labels, marcador);
        if (!id || SYSTEM_LABELS.includes(id)) return JSON.stringify({ error: 'marcador_nao_encontrado', nota: 'Passe o nome exato de um marcador criado pelo usuário (veja gmail_labels).' });
        const r = await gpatch(token, `${GMAIL}/labels/${id}`, { name: String(novo_nome).trim() });
        return JSON.stringify({ ok: true, id: r.id, name: r.name });
      },
    });
    tools.push({
      name: 'gmail_label_delete',
      description: 'DELETES a label from the user\'s Gmail. The emails are NOT deleted, they only lose that label. Deleting the label itself cannot be undone. Only the user\'s labels.',
      parameters: { type: 'object', properties: {
        marcador: { type: 'string', description: 'Name (or id) of the label to delete.' },
      }, required: ['marcador'] },
      async run({ marcador }) {
        audit('gmail_label_delete', 'gmail', String(marcador).slice(0, 60));
        const labels = await fetchLabels(token);
        const id = labels.find((l) => l.id === marcador)?.id || labelNameToId(labels, marcador);
        if (!id || SYSTEM_LABELS.includes(id)) return JSON.stringify({ error: 'marcador_nao_encontrado', nota: 'Só dá pra apagar marcador criado pelo usuário.' });
        await gdel(token, `${GMAIL}/labels/${id}`);
        return JSON.stringify({ ok: true, apagado: id });
      },
    });
  }

  // ── Gmail filters (gmail.settings.basic) = routing rules: "every
  // email from X goes to label Y and skips the inbox". ──
  if (can('gmail', 'settings')) {
    tools.push({
      name: 'gmail_filters_list',
      description: 'Lists the user\'s Gmail routing RULES (filters): by which criterion (sender/subject/etc.) and what they do (label, archive). Use to see what already exists before creating another one.',
      parameters: { type: 'object', properties: {} },
      async run() {
        audit('gmail_filters_list', 'gmail', 'filters');
        const r = await gget(token, `${GMAIL}/settings/filters`);
        const labels = await fetchLabels(token);
        const idName = (id) => labels.find((l) => l.id === id)?.name || id;
        const out = (r.filter || []).map((f) => ({
          id: f.id, criterio: f.criteria || {},
          acao: {
            aplicar: (f.action?.addLabelIds || []).map(idName),
            remover: (f.action?.removeLabelIds || []).map(idName),
          },
        }));
        return JSON.stringify(out);
      },
    });
    tools.push({
      name: 'gmail_filter_create',
      description: 'Creates a routing RULE (filter) in Gmail: emails that match the criterion get an action automatically, from now on. Criterion: de (sender), para, assunto, contem (text/query in Gmail search format), tem_anexo. Action: marcador (by name, must exist), pular_caixa_entrada, marcar_lido, marcar_importante. E.g.: everything from "news@zara.com" → label "Newsletters" and skip the inbox.',
      parameters: { type: 'object', properties: {
        de: { type: 'string', description: 'Sender (from).' },
        para: { type: 'string', description: 'Recipient (to).' },
        assunto: { type: 'string', description: 'Text in the subject.' },
        contem: { type: 'string', description: 'Free-form query (Gmail search syntax).' },
        tem_anexo: { type: 'boolean' },
        marcador: { type: 'string', description: 'Label to apply (by name; must exist — create it first).' },
        pular_caixa_entrada: { type: 'boolean', description: 'true = archive directly (removes INBOX).' },
        marcar_lido: { type: 'boolean' },
        marcar_importante: { type: 'boolean' },
      } },
      async run({ de, para, assunto, contem, tem_anexo, marcador, pular_caixa_entrada, marcar_lido, marcar_importante }) {
        const criteria = {};
        if (de) criteria.from = de;
        if (para) criteria.to = para;
        if (assunto) criteria.subject = assunto;
        if (contem) criteria.query = contem;
        if (tem_anexo) criteria.hasAttachment = true;
        if (!Object.keys(criteria).length) return JSON.stringify({ error: 'sem_criterio', nota: 'Informe ao menos de/para/assunto/contem/tem_anexo.' });
        const addLabelIds = [], removeLabelIds = [];
        if (marcador) {
          const labels = await fetchLabels(token);
          const id = labelNameToId(labels, marcador);
          if (!id) return JSON.stringify({ error: 'marcador_inexistente', nota: 'Crie o marcador com gmail_label_create antes.' });
          addLabelIds.push(id);
        }
        if (marcar_importante) addLabelIds.push('IMPORTANT');
        if (pular_caixa_entrada) removeLabelIds.push('INBOX');
        if (marcar_lido) removeLabelIds.push('UNREAD');
        if (!addLabelIds.length && !removeLabelIds.length) return JSON.stringify({ error: 'sem_acao', nota: 'Defina ao menos marcador/pular_caixa_entrada/marcar_lido/marcar_importante.' });
        audit('gmail_filter_create', 'gmail', JSON.stringify(criteria).slice(0, 120));
        const r = await gpost(token, `${GMAIL}/settings/filters`, { criteria, action: { addLabelIds, removeLabelIds } });
        return JSON.stringify({ ok: true, id: r.id, nota: 'Regra criada; vale pros próximos e-mails. Não reprocessa os que já estão na caixa.' });
      },
    });
    tools.push({
      name: 'gmail_filter_delete',
      description: 'Deletes a Gmail routing RULE (filter) by id (obtained from gmail_filters_list).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        audit('gmail_filter_delete', 'gmail', String(id));
        await gdel(token, `${GMAIL}/settings/filters/${id}`);
        return JSON.stringify({ ok: true, apagado: id });
      },
    });
  }

  if (can('drive', 'read')) {
    const drivePages = searchPagination({ defaultMax: 8, cap: 15 });
    tools.push({
      name: 'drive_search',
      description: 'Searches files in the personal Drive and in the accessible shared Drives. Returns real names, IDs and links. ' + DRIVE_SEARCH_RULE,
      parameters: driveSearchParameters,
      run: completeDriveSearch(async (args = {}) => {
        const q = driveSearchQuery(args);
        const page = drivePages.request(q, args.max, args.cursor);
        audit('drive_search', 'drive', `q=${q.slice(0,120)} page=${page.page}`);
        const qs = new URLSearchParams({ q, pageSize: String(page.pageSize),
          spaces: 'drive', corpora: 'user', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true',
          fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,webViewLink,driveId,shortcutDetails)' });
        if (page.position) qs.set('pageToken',page.position);
        const j = await gget(token, `${DRIVE}/files?${qs}`);
        return drivePages.result(page, searchItems(j.files === undefined ? [] : j.files,page,'id'), driveSearchMeta(j));
      }),
    });
    // Fallback for a Google spreadsheet too large for the .xlsx export: Drive's
    // CSV only brings the first sheet, so the result states this plainly.
    const lerSheetsCsv = async (id, meta) => {
      const r = await fetch(`${DRIVE}/files/${id}/export?mimeType=text/csv`, { headers: { Authorization: `Bearer ${await token()}` } });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const analise = await analisePlanilhaConector(onSheetLoad, buf, `${meta.name || 'planilha'}.csv`, 'text/csv');
      return JSON.stringify({ name: meta.name, mimeType: meta.mimeType, analise, note: 'Planilha grande demais pro Google exportar inteira: veio SÓ A PRIMEIRA ABA. As outras abas não foram lidas; diga isso ao usuário em vez de supor o conteúdo delas.' });
    };
    tools.push({
      name: 'drive_read',
      description: 'Reads the content of a Drive file by id: Google Docs, Presentations (Slides), PDF and text/JSON files. A SPREADSHEET (Google Sheets, Excel, CSV) does not come back as text: it is opened in the analysis environment and the result carries only the structure in the "analise" field; the content is queried with analisar_planilha. For other binary formats it returns only the metadata.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        audit('drive_read', 'drive', `file=${id}`);
        const meta = await gget(token, `${DRIVE}/files/${id}?fields=id,name,mimeType&supportsAllDrives=true`);
        const mime = meta.mimeType || '';
        // PDF: downloads the bytes and extracts the text (same pipeline as attached PDFs).
        if (mime === 'application/pdf' || /\.pdf$/i.test(meta.name || '')) {
          const r = await fetch(`${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${await token()}` } });
          if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
          const buf = Buffer.from(await r.arrayBuffer());
          return await readPdfBuf(buf, meta.name, mime || 'application/pdf');
        }
        if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|tiff?|bmp)$/i.test(meta.name || '')) {
          const r = await fetch(`${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${await token()}` } });
          if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
          const buf = Buffer.from(await r.arrayBuffer());
          const ocr = await ocrImageFallback(buf, meta.name, mime || 'image/jpeg');
          return ocr || JSON.stringify({ name: meta.name, mimeType: mime, note: 'Imagem sem texto legível.' });
        }
        // Spreadsheet (Google Sheets, Excel, CSV): downloads the bytes and sends
        // them to the analysis environment; the result only carries the structure
        // (see planilha.mjs). Google Sheets' native format is exported as .xlsx:
        // Drive's CSV export only brings the FIRST sheet, and a multi-sheet
        // spreadsheet was going blind (case from 2026-09-30). Same drive.readonly
        // scope; nothing new in the OAuth.
        const sheetsNativo = mime === 'application/vnd.google-apps.spreadsheet';
        if (sheetsNativo || tipoPlanilha(meta.name, mime)) {
          const url = sheetsNativo
            ? `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
            : `${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
          if (!r.ok) {
            const erro = (await r.text()).slice(0, 200);
            // Drive's export has a size ceiling (exportSizeLimitExceeded). It then
            // falls back to CSV, which only reads the first sheet, and WARNS the
            // model about it.
            if (sheetsNativo && r.status === 403 && /exportSizeLimitExceeded/i.test(erro)) return await lerSheetsCsv(id, meta);
            throw new Error(`${r.status}: ${erro}`);
          }
          const buf = Buffer.from(await r.arrayBuffer());
          const nome = sheetsNativo ? `${meta.name || 'planilha'}.xlsx` : (meta.name || 'planilha.xlsx');
          const analise = await analisePlanilhaConector(onSheetLoad, buf, nome, sheetsNativo ? XLSX_MIME : mime);
          return JSON.stringify({ name: meta.name, mimeType: mime, analise });
        }
        let url;
        if (mime === 'application/vnd.google-apps.document') url = `${DRIVE}/files/${id}/export?mimeType=text/plain`;
        else if (mime === 'application/vnd.google-apps.presentation') url = `${DRIVE}/files/${id}/export?mimeType=text/plain`;
        else if (mime.startsWith('text/') || mime === 'application/json') url = `${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`;
        else return JSON.stringify({ ...meta, note: 'Formato binário; não consigo ler o conteúdo como texto.' });
        const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
        if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
        const arq = recortar(await r.text(), 12000, 'arquivo');
        return JSON.stringify({ name: meta.name, mimeType: mime, text: arq.corpo, truncated: arq.truncado || undefined });
      },
    });
  }

  if (can('calendar', 'read')) {
    tools.push({
      name: 'calendar_list',
      description: 'Lists the user\'s Google Calendar events in a window of days. By default it reads ALL the calendars they have (their own, work ones, the ones other people shared with them), not only the primary; each event comes with the `agenda` field saying which one it came from. Pass `agenda` to restrict to a single one, or "todas" to also include the holiday/birthday feeds, which are left out by default. To know IF/WHEN something is scheduled, list the period and READ the events: do NOT rely only on `query` (the real title may differ from the term in the request, e.g. request "revisão do carro" vs event "Revisão Jeep Alphaville"). `query` is only a best-effort local filter; if nothing matches, the tool still returns the whole calendar for the period. Read-only.',
      parameters: { type: 'object', properties: { inicio: { type:'string', description:'Start of the window, inclusive; ISO or YYYY-MM-DD. Use for specific past or future dates.' }, fim: { type:'string', description:'End of the window, exclusive; ISO or YYYY-MM-DD.' }, fuso: { type:'string', description:'IANA timezone for local dates/times.' }, days: { type: 'integer', description: 'Window in days from inicio or from now (default 30; maximum 366).' }, query: { type: 'string', description: 'OPTIONAL filter by event text (applied locally, without hiding the calendar). Prefer NOT to use it and read the list.' }, max: { type: 'integer', description: 'Maximum number of events (default 50).' }, agenda: { type: 'string', description: 'OPTIONAL. Name or id of ONE calendar, when the owner asked only for it. Omit to read all (the normal case). Use "todas" to include holidays/birthdays.' } } },
      async run({ days = 30, query, max = 50, agenda, inicio, fim, fuso }) {
        const {from:timeMin,to:timeMax}=calendarWindow({inicio,fim,fuso,days});
        if (!Number.isSafeInteger(max) || max<1) throw Error('max deve ser um inteiro positivo.');
        const cals = await listCalendars(token);
        const alvos = pickCalendars(cals, agenda);
        if (!alvos.length) {
          return JSON.stringify({ erro: `Não achei agenda com o nome "${agenda}".`, agendas_disponiveis: cals.map((c) => c.nome) });
        }
        // Ceiling of calendars per call: whoever has 30 shared calendars can't
        // turn a "what do I have today" into 30 requests to Google.
        const lidas = alvos.slice(0, 12);
        audit('calendar_list', 'calendar', `days=${days} agendas=${lidas.length}`);
        // No `q` for Google: a text filter at the source already made the AI miss
        // an event (search too narrow). We pull the whole window and filter locally.
        const porAgenda = String(Math.min(Math.max(1, max), 100));
        const falhas = [];
        const incompletas = [];
        const listas = await Promise.all(lidas.map(async (c) => {
          const p = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: porAgenda });
          try {
            const r = await gget(token, `${CAL}/calendars/${calId(c)}/events?${p.toString()}`);
            if (r.nextPageToken) incompletas.push(c.nome);
            return (r.items || []).map((e) => ({
              id: e.id, agenda: c.nome, title: e.summary || '(sem título)',
              serie_id: e.recurringEventId || undefined, ocorrencia_original: e.originalStartTime || undefined,
              start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date,
              location: e.location || '', attendees: (e.attendees || []).map((a) => a.email).slice(0, 8),
            }));
          } catch {
            // A broken calendar can't bring down the entire response, but the owner
            // needs to know it was left out (otherwise it disappears silently).
            falhas.push(c.nome);
            return [];
          }
        }));
        const { items, corte } = ordenarECortar(listas.flat(), Math.min(Math.max(1, max), 100));
        const catalogPartial = (!agenda || ['todas','todas as agendas','all'].includes(semAcento(agenda))) && cals.some(c=>c.catalog_partial);
        // What the response covered. Without this the assistant has no way to warn
        // that it read 12 of 30 calendars, and would say "there's nothing" about
        // what it didn't read.
        const contaLida = typeof account === 'function' ? await account() : account;
        const cobertura = {
          // Google account the events came from: to edit/delete one of them when
          // it's not the assistant's default account, writing needs it.
          ...(contaLida ? { conta: contaLida } : {}),
          periodo: {inicio:timeMin,fim:timeMax},
          partial: !!(catalogPartial || incompletas.length || falhas.length || corte || alvos.length > lidas.length),
          ...(catalogPartial ? {catalogo_incompleto:'Não foi possível conferir a lista completa de agendas; cobertura limitada às agendas identificadas.'} : {}),
          ...(incompletas.length ? {agendas_com_mais_paginas:incompletas} : {}),
          agendas_lidas: lidas.map((c) => c.nome),
          ...(alvos.length > lidas.length ? { agendas_nao_lidas: alvos.slice(12).map((c) => c.nome) } : {}),
          ...(falhas.length ? { agendas_com_erro: falhas } : {}),
          ...(corte ? { corte } : {}),
        };
        if (!items.length) return JSON.stringify({ nota: 'Nenhum evento na janela.', ...cobertura });
        if (query) {
          const q = semAcento(query);
          const matched = items.filter((e) => semAcento(`${e.title} ${e.location}`).includes(q));
          if (matched.length) return JSON.stringify({ ...cobertura, eventos: matched });
          // Filter didn't match: returns the full calendar so an event is NEVER hidden.
          return JSON.stringify({ nota: `Nenhum evento casou com "${query}"; segue a agenda completa dos próximos ${days} dias pra você conferir.`, ...cobertura, eventos: items });
        }
        return JSON.stringify({ ...cobertura, eventos: items });
      },
    });
  }

  if (can('docs', 'read')) {
    tools.push({
      name: 'docs_read',
      description: 'Reads Google Docs including tables and tabs. If has_more, continue with next_offset and revision until done; partial/warnings indicate read limits.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 1, maximum: 16000 }, revision: { type: 'string' } }, required: ['id'] },
      async run({ id, offset = 0, max_chars = 8000, revision = null }) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max_chars) || max_chars < 1 || max_chars > 16000) throw new Error('Paginação inválida');
        audit('docs_read', 'docs', `doc=${id}`);
        const doc = await gget(token, `${DOCS}/${encodeURIComponent(id)}?includeTabsContent=true`);
        return JSON.stringify(readGoogleDocument(doc, { offset, max_chars, revision }));
      },
    });
  }

  // ── Writing ──
  // Gmail DRAFT: comes with the connection (gmail.compose scope). Creates a draft,
  // does NOT send. Safe/reversible action, doesn't go through the confirmation gate.
  if (can('gmail', 'write')) {
    tools.push({
      name: 'gmail_create_draft',
      description: 'Creates an email DRAFT in the user\'s Gmail account (does NOT send; it stays saved in Drafts for them to review and send). Use whenever they ask to "escrever/preparar um e-mail". Show the content in the conversation.',
      parameters: { type: 'object', properties: {
        to: { type: 'string', description: 'Recipient(s), comma-separated.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Email body in plain text.' },
        cc: { type: 'string', description: 'Optional CC, comma-separated.' },
      }, required: ['to', 'subject', 'body'] },
      async run({ to, subject, body, cc }) {
        const raw = buildRawEmail({ to, subject, body, cc });
        const r = await gpost(token, `${GMAIL}/drafts`, { message: { raw } });
        return JSON.stringify({ ok: true, draftId: r.id, note: 'Rascunho criado no Gmail (NÃO enviado).' });
      },
    });
  }

  // Gmail SEND: only when the user explicitly TURNED ON sending in the app
  // (caps.gmail.send). Even so, it goes through the per-action confirmation gate.
  if (can('gmail', 'send')) {
    tools.push({
      name: 'gmail_send',
      description: 'Sends an email on behalf of the user. ALWAYS confirm the recipient, subject and body with the user BEFORE sending; do not send without their explicit ok.',
      parameters: { type: 'object', properties: {
        to: { type: 'string', description: 'Recipient(s), comma-separated.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Email body in plain text.' },
        cc: { type: 'string', description: 'Optional CC, comma-separated.' },
      }, required: ['to', 'subject', 'body'] },
      async run({ to, subject, body, cc }) {
        const raw = buildRawEmail({ to, subject, body, cc });
        const r = await gpost(token, `${GMAIL}/messages/send`, { raw });
        return JSON.stringify({ ok: true, id: r.id, note: 'E-mail enviado.' });
      },
    });
  }

  if (can('calendar', 'write')) {
    tools.push({
      name: 'calendar_create',
      description: 'For a recurring request, fill in recorrencia and confirm the cadence and the end; never silently replace it with a single event. Creates an event in the user\'s Google Calendar. It goes on the primary calendar, unless you pass `agenda` (name of one of the calendars that showed up in calendar_list). ALWAYS confirm title, date/time and attendees BEFORE creating; do not create without the user\'s explicit ok. Pass `timezone` with the user\'s REAL timezone (IANA, e.g. America/Zurich for someone in Basel, America/Sao_Paulo in Brazil); `start`/`end` must be the local wall-clock time (e.g. 2026-07-09T11:30:00) WITHOUT offset. Do not embed an offset in the ISO nor convert the time yourself.',
      parameters: { type: 'object', properties: {
        recorrencia: recurrenceSchema,
        title: { type: 'string' },
        start: { type: 'string', description: 'Start. Local wall-clock ISO time WITHOUT offset (e.g. 2026-07-09T11:30:00) for a timed event, or just a date (2026-07-09) for an all-day event.' },
        end: { type: 'string', description: 'End, same format as start. If omitted on a timed event, assumes 1h.' },
        timezone: { type: 'string', description: 'User\'s IANA timezone (e.g. America/Zurich, Europe/Lisbon, America/Sao_Paulo). Defaults to America/Sao_Paulo if omitted.' },
        description: { type: 'string' },
        location: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee emails.' },
        agenda: { type: 'string', description: 'OPTIONAL. Name of the calendar to create it in, when it is not the primary (use the name that came in the `agenda` field of calendar_list).' },
      }, required: ['title', 'start'] },
      async run({ title, start, end, description, location, attendees, timezone, agenda, recorrencia }) {
        let repeat;
        try { repeat = calendarRecurrence(recorrencia, start, timezone); }
        catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
        const alvo = await resolveWriteCalendar(token, agenda);
        if (alvo.error) return JSON.stringify({ ok: false, error: alvo.error });
        const hasTime = /T\d/.test(start || '');
        const endVal = end || (hasTime ? recurrenceDefaultEnd(String(start).replace(/(?:Z|[+-]\d\d:\d\d)$/, '')) : start);
        const ev = { summary: title, start: calTime(start, timezone), end: calTime(endVal, timezone) };
        if (repeat) ev.recurrence = repeat.google;
        if (description) ev.description = description;
        if (location) ev.location = location;
        if (attendees?.length) ev.attendees = attendees.map((email) => ({ email }));
        const q = attendees?.length ? '?sendUpdates=all' : '';
        const r = await gpost(token, `${CAL}/calendars/${calId(alvo.cal)}/events${q}`, ev);
        return JSON.stringify({ ok: true, id: r.id, link: r.htmlLink, agenda: alvo.cal.nome, note: `Evento criado na agenda "${alvo.cal.nome}".` });
      },
    });

    tools.push({
      name: 'calendar_update',
      description: 'EDITS an event that already exists in one of the user\'s calendars (Google Calendar). Use to reschedule, change the title, location, description or attendees of an EXISTING event (never create a new one to "edit"). First use calendar_list to find the event and get its `id`. If the event came from a calendar that is not the primary, pass the same `agenda` that came in calendar_list. Pass ONLY the fields that change. ALWAYS confirm the change with the user first. For the time, use `timezone` with the user\'s REAL timezone (IANA) and `start`/`end` as local wall-clock ISO time WITHOUT offset.',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: 'Id of the event to edit (from calendar_list).' },
        title: { type: 'string', description: 'New title (only if it changes).' },
        start: { type: 'string', description: 'New start. Local wall-clock ISO time WITHOUT offset (e.g. 2026-07-09T11:30:00) or just a date (all day). Only if it changes.' },
        end: { type: 'string', description: 'New end, same format as start. Only if it changes.' },
        timezone: { type: 'string', description: 'User\'s IANA timezone (e.g. America/Sao_Paulo, America/Zurich). Use when changing the time.' },
        description: { type: 'string', description: 'New description (only if it changes).' },
        location: { type: 'string', description: 'New location (only if it changes).' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'COMPLETE list of attendee emails (replaces the current one). Only if it changes.' },
        agenda: { type: 'string', description: 'OPTIONAL. Calendar of the event, when it is not the primary (use the `agenda` that came in calendar_list).' },
      }, required: ['id'] },
      async run({ id, title, start, end, timezone, description, location, attendees, agenda, _confirmationEtag }) {
        if (!id) return JSON.stringify({ ok: false, error: 'Preciso do id do evento (use calendar_list pra achar).' });
        const patch = {};
        if (title != null) patch.summary = title;
        if (start != null) patch.start = calTime(start, timezone);
        if (end != null) patch.end = calTime(end, timezone);
        if (description != null) patch.description = description;
        if (location != null) patch.location = location;
        if (Array.isArray(attendees)) patch.attendees = attendees.map((email) => ({ email }));
        if (!Object.keys(patch).length) return JSON.stringify({ ok: false, error: 'Nada pra mudar; passe ao menos um campo.' });
        // The guest always finds out: changing time or location without notice
        // leaves the other side at the wrong meeting.
        const q = '?sendUpdates=all';
        const alvo = await resolveEventCalendar(token, id, agenda);
        if (alvo.error) return JSON.stringify({ ok: false, error: alvo.error });
        try {
          const r = await gpatch(token, `${CAL}/calendars/${calId(alvo.cal)}/events/${encodeURIComponent(id)}${q}`, patch, _confirmationEtag);
          return JSON.stringify({ ok: true, id: r.id, link: r.htmlLink, agenda: alvo.cal.nome, note: `Evento atualizado na agenda "${alvo.cal.nome}".` });
        } catch (e) {
          const m = String(e?.message ?? e);
          if (m.startsWith('404')) return JSON.stringify({ ok: false, error: `Evento não encontrado na agenda "${alvo.cal.nome}". Confira o id com calendar_list.` });
          return JSON.stringify({ ok: false, error: m });
        }
      },
    });

    tools.push({
      name: 'calendar_delete',
      description: 'DELETES an event from one of the user\'s calendars (Google Calendar). Use calendar_list to find the `id` first; if the event came from a calendar that is not the primary, pass the same `agenda` that came from there. ALWAYS confirm with the user before deleting; irreversible action.',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: 'Id of the event to delete (from calendar_list).' },
        agenda: { type: 'string', description: 'OPTIONAL. Calendar of the event, when it is not the primary (use the `agenda` that came in calendar_list).' },
      }, required: ['id'] },
      async run({ id, agenda, _confirmationEtag }) {
        if (!id) return JSON.stringify({ ok: false, error: 'Preciso do id do evento (use calendar_list pra achar).' });
        const alvo = await resolveEventCalendar(token, id, agenda);
        if (alvo.error) return JSON.stringify({ ok: false, error: alvo.error });
        try {
          await gdel(token, `${CAL}/calendars/${calId(alvo.cal)}/events/${encodeURIComponent(id)}?sendUpdates=all`, _confirmationEtag);
          return JSON.stringify({ ok: true, deletedId: id, agenda: alvo.cal.nome, note: `Evento apagado da agenda "${alvo.cal.nome}".` });
        } catch (e) {
          const m = String(e?.message ?? e);
          if (m.startsWith('404') || m.startsWith('410')) return JSON.stringify({ ok: false, error: 'Evento não encontrado (já pode ter sido apagado).' });
          return JSON.stringify({ ok: false, error: m });
        }
      },
    });
  }

  if (can('drive', 'write')) {
    tools.push({
      name: 'drive_upload',
      description: `Creates a text file in the user's Google Drive, always inside the assistant's folder ("${folderName}") at the root. You cannot choose another folder or save it loose at the root (the app only touches its own folder). Confirm name and content first.`,
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'File name (e.g. notas.txt).' },
        content: { type: 'string', description: 'Text content.' },
        mimeType: { type: 'string', description: 'File MIME type (default text/plain).' },
      }, required: ['name', 'content'] },
      async run({ name, content, mimeType = 'text/plain' }) {
        // GUARD against "undefined": if the content didn't arrive (arg truncated
        // in a long generation, tool-call missing the field, etc.), NEVER write
        // the file — otherwise Drive ends up with the literal string "undefined"/
        // empty (bug from 2026-07-28). Fails with a clear, actionable error instead
        // of silently corrupting data.
        if (content == null || String(content).trim() === '' || String(content).trim() === 'undefined') {
          return JSON.stringify({ ok: false, error: 'Não recebi o conteúdo do arquivo (veio vazio/undefined). Não gravei nada. Se o texto for longo, ele pode ter sido cortado na chamada: reenvie o conteúdo, ou quebre em partes menores, ou salve o texto num arquivo do sandbox e use drive_upload_arquivo.' });
        }
        const folderId = await ensureAssistantFolder(token, folderName);
        const boundary = 'brambs' + b64urlEncode(name).slice(0, 16);
        const meta = JSON.stringify({ name, parents: [folderId] });
        const multipart =
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
          `--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n${content}\r\n` +
          `--${boundary}--`;
        const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
          method: 'POST',
          headers: { Authorization: `Bearer ${await token()}`, 'content-type': `multipart/related; boundary=${boundary}` },
          body: multipart,
        });
        if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
        const f = await r.json();
        return JSON.stringify({ ok: true, id: f.id, name: f.name, link: f.webViewLink, note: 'Arquivo criado no Drive.' });
      },
    });

    // Creates a NATIVE Google Doc from text. Unlike drive_upload (which
    // generates a standalone .txt), here Drive CONVERTS the body into a real
    // Google document (metadata with a target mimeType of google-apps.document),
    // which opens/edits in Docs and can later be exported to PDF. The drive.file
    // scope covers the creation.
    tools.push({
      name: 'docs_create',
      description: 'Creates a NATIVE Google Doc (a Google document, not a .txt) from text, inside the assistant\'s folder in Drive. Use when the user asks to "montar/criar um Google Doc". Accepts simple HTML in the content for layout (headings <h1>, bold <b>, lists <ul>) — pass html=true in that case. Returns the document link. Confirm name and content first.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'Document title.' },
        content: { type: 'string', description: 'Content (plain text, or simple HTML if html=true).' },
        html: { type: 'boolean', description: 'true if content is HTML (for layout). Default false = plain text.' },
      }, required: ['name', 'content'] },
      async run({ name, content, html = false }) {
        if (content == null || String(content).trim() === '' || String(content).trim() === 'undefined') {
          return JSON.stringify({ ok: false, error: 'Não recebi o conteúdo do documento (veio vazio/undefined). Não criei nada. Reenvie o conteúdo.' });
        }
        audit('docs_create', 'drive', `name=${String(name).slice(0, 80)}`);
        const folderId = await ensureAssistantFolder(token, folderName);
        const boundary = 'brambs' + b64urlEncode(name).slice(0, 16);
        const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/vnd.google-apps.document' });
        const bodyType = html ? 'text/html' : 'text/plain';
        const multipart =
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
          `--${boundary}\r\nContent-Type: ${bodyType}; charset=UTF-8\r\n\r\n${content}\r\n` +
          `--${boundary}--`;
        const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
          method: 'POST',
          headers: { Authorization: `Bearer ${await token()}`, 'content-type': `multipart/related; boundary=${boundary}` },
          body: multipart,
        });
        if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
        const f = await r.json();
        return JSON.stringify({ ok: true, id: f.id, name: f.name, link: f.webViewLink, note: 'Google Doc criado no Drive.' });
      },
    });

    // Exports a GOOGLE file (Doc/Sheet/Slides) to PDF and saves the PDF in the
    // assistant's folder on Drive. Covers "turn this Google Doc into a PDF".
    // Drive's export only works for Google's native formats; PDF is already PDF,
    // a regular binary doesn't export.
    tools.push({
      name: 'drive_export_pdf',
      description: 'Turns a Google Doc (or Sheet/Presentation) into a PDF: exports the file to PDF and saves it in the assistant\'s folder in Drive, returning the PDF link. Pass the file id (comes from drive_search/google). Use when the user asks "gera um PDF desse Google Doc / transforma em PDF". To combine new content and turn it into a PDF, create the Google Doc first with docs_create and then export its id here.',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: 'id of the Google Doc/Sheet/Slides to export.' },
        name: { type: 'string', description: 'Optional PDF name (default: file name + .pdf).' },
      }, required: ['id'] },
      async run({ id, name }) {
        audit('drive_export_pdf', 'drive', `file=${id}`);
        const meta = await gget(token, `${DRIVE}/files/${id}?fields=id,name,mimeType&supportsAllDrives=true`);
        const mime = meta.mimeType || '';
        if (!mime.startsWith('application/vnd.google-apps.')) {
          if (mime === 'application/pdf') return JSON.stringify({ ok: false, error: 'Esse arquivo já é um PDF; não precisa exportar. Use o link que já existe.' });
          return JSON.stringify({ ok: false, error: `Só dá pra exportar pra PDF arquivos nativos do Google (Docs, Planilhas, Apresentações). Esse é ${mime || 'de tipo desconhecido'}.` });
        }
        const r = await fetch(`${DRIVE}/files/${id}/export?mimeType=application/pdf`, { headers: { Authorization: `Bearer ${await token()}` } });
        if (!r.ok) throw new Error(`export ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const base = (name || meta.name || 'documento').replace(/\.pdf$/i, '');
        const folderId = await ensureAssistantFolder(token, folderName);
        const f = await uploadBinaryToDrive({ token, name: `${base}.pdf`, buffer: buf, mimeType: 'application/pdf', folderId });
        return JSON.stringify({
          ok: true, id: f.id, name: f.name, link: f.webViewLink, atualizado: !!f.updated,
          note: f.updated ? `PDF gerado; já existia um "${f.name}" no Drive e atualizei o conteúdo dele (mesmo link).` : 'PDF gerado e salvo no Drive.',
        });
      },
    });
  }

  return tools.map(tool => ['calendar_create','calendar_update','calendar_delete'].includes(tool.name)
    ? calendarWriteConfirmation(tool,token,account) : tool);
}

// Searches by EXACT name, restricted to the given folder.
// The existing OAuth scope still applies.
// Name isn't a unique identifier: only reuse it when the full search finds ONE.
async function findFileInFolder(token, folderId, name) {
  if (!validDriveId(folderId) || typeof name !== 'string' || !name.trim()) {
    throw new Error('Não recebi pasta e nome válidos para conferir o arquivo no Drive. A gravação foi interrompida.');
  }
  const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `name = '${esc}' and '${folderId}' in parents and trashed = false`;
  const existing = await uniqueDriveWriteTarget(token, q, 'o arquivo com esse nome');
  if (existing && (existing.name !== name || existing.mimeType === 'application/vnd.google-apps.folder')) {
    throw new Error('O resultado da busca não corresponde ao arquivo esperado. A gravação foi interrompida.');
  }
  return existing;
}

// Uploads a BINARY file (PDF, image, spreadsheet…) to the user's Drive.
// `buffer` is a Buffer with the raw bytes; builds a multipart/related with a
// binary body (not a string), unlike the text drive_upload. The drive.file
// scope covers the write. Used by the drive_upload_arquivo tool (reads the
// bytes from the sandbox).
//
// UPDATES IN PLACE: if a file with the SAME name already exists in the
// assistant's folder, overwrites its bytes (PATCH uploadType=media) instead of
// creating a new copy. The id and the LINK stay the same, which is what the
// person expects when asking to "update the spreadsheet" (before, every send
// generated a new link and the previous one became junk). Pass update:false to
// force a new copy. Doesn't touch OAuth scope: drive.file already allows
// updating a file the app created.
export async function uploadBinaryToDrive({ token, name, buffer, mimeType = 'application/octet-stream', folderId = null, update = true }) {
  if (update) {
    const existing = await findFileInFolder(token, folderId, name);
    if (existing) {
      const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id,name,webViewLink`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${await token()}`, 'content-type': mimeType },
        body: buffer,
      });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
      return { ...(await r.json()), updated: true };
    }
  }
  const boundary = 'brambs' + b64urlEncode(name).slice(0, 16);
  const meta = JSON.stringify(folderId ? { name, parents: [folderId] } : { name });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: binary\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const body = Buffer.concat([head, buffer, tail]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return { ...(await r.json()), updated: false };
}
