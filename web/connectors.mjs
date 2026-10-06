import { driveSearchQuery, driveSearchParameters, DRIVE_SEARCH_RULE, completeDriveSearch } from './drive-search.mjs';
import { readGoogleDocument } from './document-read.mjs';
import { recortar } from './recorte.mjs';
import { emailHeader } from './security-boundaries.mjs';
import { searchPagination, searchCursorSchema, SEARCH_PAGINATION_RULE, searchItems, driveSearchMeta } from './search-pagination.mjs';
import { emailPagination, emailCursorSchema, EMAIL_PAGINATION_RULE } from './email-pagination.mjs';
import { recurrenceSchema, calendarRecurrence, recurrenceDefaultEnd, calendarWindow, recurrenceLabel, recurrenceOccurrences } from './calendar-recurrence.mjs';
// ── Conectores Google como tools do core ──
// Cada conector vira uma tool (JSON Schema) que entra no tool-loop do harness.
// Recebem um `token()` async que devolve um access_token válido (já renovado).
// Leitura sempre; escrita (enviar e-mail, criar evento, subir arquivo) quando o
// usuário concedeu o escopo de escrita do serviço.
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

// Uma busca anterior à escrita deve provar ausência ou um alvo único.
// Nunca tratar indisponibilidade, resposta inválida ou página parcial como vazio.
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

// Pasta identificada pela marca do app, não pelo nome. Duplicatas e falhas de
// busca também precisam parar AQUI, antes de criar pasta ou procurar arquivos.
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

// POST JSON autenticado (usado pelas ações de escrita).
async function gpost(token, url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// PATCH JSON autenticado (atualização parcial; usado pra editar evento).
async function gpatch(token, url, body, ifMatch = null) {
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...(ifMatch ? {'If-Match':ifMatch} : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// DELETE autenticado (usado pra apagar evento). 204 = sem corpo.
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

// Codifica um header MIME quando tem caractere não-ASCII (ex: assunto com acento).
const mimeWord = (s) =>
  /[^\x00-\x7F]/.test(s || '') ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : (s || '');

// Monta o corpo MIME cru (base64url) de um e-mail. Usado tanto pelo rascunho
// quanto pelo envio.
function buildRawEmail({ to, subject, body, cc }) {
  const safeTo=emailHeader(to,'destinatário'), safeCc=emailHeader(cc,'cópia'), safeSubject=emailHeader(subject,'assunto');
  const headers = [`To: ${safeTo}`];
  if (safeCc) headers.push(`Cc: ${safeCc}`);
  headers.push(`Subject: ${mimeWord(safeSubject)}`);
  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit');
  return b64urlEncode(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

// Normaliza a hora de parede pro RFC3339 que o Google exige. O modelo às vezes
// emite só HH:MM (sem segundos), ex "2026-08-18T14:09", e o Calendar responde
// 400 Bad Request genérico porque RFC3339 exige segundos. Aqui completamos:
// zero-pad na hora e :00 nos segundos quando faltam, preservando fração/offset
// se vierem. Se não casar o formato de data-hora local (tem offset estranho ou
// coisa inesperada), deixa passar como veio. Caso de 16/08: consulta médica
// não entrava por causa disso.
const rfc3339Local = (v) => {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return s;
  const [, Y, Mo, D, h, mi, se, frac, off] = m;
  return `${Y}-${Mo}-${D}T${h.padStart(2, '0')}:${mi}:${se || '00'}${frac || ''}${off || ''}`;
};

// start/end pro Calendar: ISO com hora -> dateTime+tz; só data -> all-day.
// O tz (IANA) define o fuso do evento; default São Paulo, mas o agente deve
// passar o fuso real do usuário (ex America/Zurich pra quem está em Basileia).
const calTime = (v, tz) =>
  /T\d/.test(v || '') ? { dateTime: rfc3339Local(v), timeZone: tz || 'America/Sao_Paulo' } : { date: v };

// ── Agendas do Google (calendarList) ────────────────────────────────────────
// O produto lia e escrevia só em `primary`. Quem organiza a vida em mais de uma
// agenda (trabalho, produtora, agenda de outra pessoa compartilhada com ele)
// recebia meia resposta, e a tool nem sabia que faltava coisa: não havia
// nenhuma chamada a calendarList no código (auditoria 04/09).
// Aqui o conjunto de agendas passa a ser DESCOBERTO. Nenhum escopo OAuth novo:
// calendar.readonly/calendar.events já valem pra conta inteira.
const CAL_FEED = /(holiday|contacts)@group\.v\.calendar\.google\.com$/i;
const semAcento = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// Lista as agendas da conta. Nunca lança: se a chamada falhar (permissão antiga,
// erro do Google), a leitura continua na principal, como era antes.
async function listCalendars(token) {
  try {
    const r = await gget(token, `${CAL}/users/me/calendarList?minAccessRole=reader&maxResults=250`);
    const items = (r.items || []).filter((c) => c.id && !c.deleted).map((c) => ({
      id: c.id,
      nome: c.summaryOverride || c.summary || c.id,
      principal: !!c.primary,
      // Feed automático (feriados, aniversários): fica FORA do padrão porque
      // entope a agenda do dia, mas segue acessível pedindo pelo nome.
      feed: CAL_FEED.test(c.id),
      acesso: c.accessRole || '',
      catalog_partial: !!r.nextPageToken,
    }));
    if (items.length) return items;
  } catch { /* cai no fallback */ }
  return [{ id: 'primary', nome: 'principal', principal: true, feed: false, acesso: 'owner', catalog_partial:true }];
}

// Qual(is) agenda(s) o dono quis. Sem `agenda`, TODAS as de verdade (sem feed).
// Casa por id exato, nome exato e depois nome parcial, tudo sem acento.
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

// Junta os eventos das várias agendas em UMA lista: ordena por instante e corta
// no teto, dizendo quando cortou. Fora da tool pra poder ser testada sozinha.
// Por que instante e não texto: cada agenda pode ter fuso próprio e o Google
// devolve o offset dentro do ISO, então "T09:00:00Z" viria antes de
// "T08:00:00-03:00" (que é 11:00Z) e o corte derrubaria o evento errado.
export function ordenarECortar(eventos, teto) {
  const inst = (s) => { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER; };
  const todos = [...eventos].sort((a, b) => inst(a.start) - inst(b.start) || String(a.start || '').localeCompare(String(b.start || '')));
  const items = todos.slice(0, Math.max(1, teto));
  // Com várias agendas o teto é dividido entre elas e a lista pode parar no meio
  // da janela pedida. Sem esta nota o assistente diria "não tem nada dia 28"
  // olhando uma lista que acabou no dia 12.
  const corte = todos.length > items.length
    ? `Couberam só os ${items.length} eventos mais próximos (${todos.length - items.length} ficaram de fora). A lista cobre até ${items[items.length - 1]?.start || '?'} e NÃO diz nada sobre o resto da janela: pra ver mais adiante, peça um período menor, uma agenda só, ou um max maior.`
    : null;
  return { items, corte };
}

// Agenda pra ESCREVER. Sem `agenda`, a principal (default de sempre: ninguém
// cria evento na agenda compartilhada de outra pessoa por acidente). Com nome,
// resolve e exige permissão de escrita, senão o Google devolveria 403 seco.
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
        conta: { type: 'string', description: `OPCIONAL. Conta Google da agenda, quando não for a padrão (${padrao}). Use o \`conta\` que veio no calendar_list do evento. Disponíveis: ${[padrao, ...outras].filter(Boolean).join(', ')}.` } } },
      run: async (a = {}) => { let r; try { r = alvo(a); } catch (e) { return JSON.stringify({ ok: false, error: e.message }); } return r.t.run(r.args); },
      ...(tool.prepareConfirmation ? {
        prepareConfirmation: async (a = {}) => { const r = alvo(a); return r.t.prepareConfirmation(r.args); },
        restoreConfirmation: async (a = {}, d) => { const r = alvo(a); return r.t.restoreConfirmation(r.args, d); },
      } : {}),
    };
  });
}

// 404/410 = o evento REALMENTE não está nessa agenda. Qualquer outro erro
// (401, 403, 429, 5xx, rede) quer dizer que a checagem não aconteceu: tratar
// isso como ausência faz a tool jurar pro dono que o evento não existe quando
// o Google só tropeçou.
const naoRespondeu = (e) => !/^(404|410)\b/.test(String(e?.message || ''));

// Em qual agenda está esse evento? Procura em paralelo, com teto. Devolve
// também as agendas que não deram resposta, pra quem chama não confundir
// "não está lá" com "não deu pra olhar".
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

// Agenda de um evento pra EDITAR/APAGAR. O id do evento sozinho não diz de qual
// agenda ele veio, e agora que a leitura cobre todas, a IA acha evento que a
// escrita não alcançava (404 em cima de evento que existe). Tenta a principal
// primeiro (1 requisição, o caso comum) e só então procura nas outras.
async function resolveEventCalendar(token, eventId, agenda) {
  if (agenda) return resolveWriteCalendar(token, agenda);
  const incertas = [];
  try {
    await gget(token, `${CAL}/calendars/primary/events/${encodeURIComponent(eventId)}`);
    return { cal: { id: 'primary', nome: 'principal' } };
  } catch (e) {
    // pode estar em outra agenda; se o Google nem respondeu, isso fica marcado
    if (naoRespondeu(e)) incertas.push('principal');
  }
  const cals = await listCalendars(token);
  const editaveis = cals.filter((c) => !c.principal && !c.feed && (!c.acesso || ['owner', 'writer'].includes(c.acesso)));
  const r = editaveis.length ? await findEventCalendar(token, eventId, editaveis) : { cal: null, incertas: [] };
  if (r.cal) return { cal: r.cal };
  const duvida = [...incertas, ...r.incertas];
  // Este texto chega CRU no dono (renderConfirmed cola o `error` na mensagem),
  // então é frase de fato, não ordem pro modelo.
  if (duvida.length) {
    const quais = duvida.length === 1 ? `a agenda "${duvida[0]}"` : `${duvida.length} agendas (${duvida.join(', ')})`;
    return { error: `Não consegui checar ${quais} agora: o Google não respondeu. Isso não quer dizer que o evento sumiu; vale tentar de novo em instantes.` };
  }
  return { error: 'Evento não encontrado em nenhuma agenda que você pode editar. Confira o id com calendar_list.' };
}

// Leitura do payload do Gmail vive em gmail-payload.mjs (sem rede),
// reexportada aqui pra quem já importava do conector.
import { extractGmailBody, readGmailBody, collectAttachments } from './gmail-payload.mjs';
export { extractGmailBody, collectAttachments };

// Decodifica base64url pra bytes (anexos do Gmail vêm em base64url).
function b64urlBytes(data) {
  return Buffer.from((data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Identifica o tipo de um binário pelos magic bytes, pra quando o Gmail não
// entrega nome/mime do anexo (ver fetchGmailAttachment). Só os formatos que
// aparecem em anexo de verdade; sem match devolve null.
const MAGIC = [
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  { ext: 'png', mime: 'image/png', test: (b) => b.slice(0, 8).toString('hex') === '89504e470d0a1a0a' },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.slice(0, 3).toString('latin1') === 'GIF' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP' },
  // OOXML (docx/xlsx/pptx) é um zip: o tipo real vem do nome da 1ª entrada.
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
    // Nos OOXML o caminho da 1ª entrada do zip já diz qual é (word/, xl/, ppt/).
    const head = buf.slice(0, 2000).toString('latin1');
    const kind = OOXML.find((o) => head.includes(o.needle));
    if (kind) return { ext: kind.ext, mime: kind.mime };
  }
  return { ext: hit.ext, mime: hit.mime };
}

// Baixa os BYTES de um anexo do Gmail e resolve nome/tipo.
// O metadado (filename/mimeType) vive no payload da MENSAGEM, e o `find` por
// attachmentId volta vazio quando o id de mensagem passado não é o da mensagem
// dona do anexo (thread com várias mensagens): o download funciona, mas o
// arquivo sai como "anexo" sem mime. Por isso: se não achar na mensagem, varre
// a THREAD inteira; se ainda assim não achar, deduz pelos magic bytes.
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

// Monta as tools dos serviços concedidos a partir das capacidades read/write.
// `caps` = { gmail: { read, write }, drive: {...}, calendar: {...}, docs: {...} }.
export function googleTools({ token, caps = {}, account = '', onUsage = () => {}, onAccess = () => {}, folderName = marca().nome, onSheetLoad = null }) {
  // Trilha de auditoria: registra cada leitura de dado sensivel (Gmail/Drive/
  // Docs/Calendar). Fire-and-forget — nunca deixa a auditoria quebrar a tool.
  const audit = (tool, resource, detail) => { try { onAccess({ tool, resource, detail }); } catch { /* nunca quebra */ } };
  // Fallback de OCR pra PDF escaneado (sem camada de texto): quando o
  // extractPdfText volta vazio, manda os bytes pro Gemini ler. Devolve o JSON
  // pronto da tool (com ocr:true) ou null se também não conseguir.
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
  // OCR/visão de imagem (anexo escaneado que veio como .jpg/.png em vez de PDF).
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
  // Detecta PDF pelos magic bytes (%PDF-), pra pegar anexo que veio com mime
  // errado (ex: application/octet-stream) ou sem extensão no nome.
  const sniffPdf = (buf) => !!buf && buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-';
  // Lê um buffer de PDF: tenta extrair o texto; se vier vazio OU o extrator
  // lançar erro, cai no OCR (Gemini). Sempre devolve um JSON pronto de tool.
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

  // Marcadores (labels) do Gmail. Busca a lista uma vez e monta um mapa
  // nome→id (case-insensitive) + os marcadores de sistema por nome canônico
  // (INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH...). Usado pra resolver
  // nomes que a IA passa (organizar inbox, criar filtro) em ids reais.
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
      description: 'Busca e-mails na caixa do usuário usando a sintaxe de busca do Gmail (ex: "from:fulano fatura newer_than:30d"). Devolve messages (remetente, assunto, data, trecho, id), has_more e next_cursor. ' + EMAIL_PAGINATION_RULE,
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Consulta no formato de busca do Gmail.' }, max: { type: 'integer', minimum: 1, description: 'Tamanho da página (padrão 5; limitado a 10).' }, cursor: emailCursorSchema }, required: ['query'] },
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
      description: 'Lê o texto útil de um e-mail pelo id obtido no gmail_search, removendo HTML/CSS antes do limite. Devolve links dos botões e avisa se o conteúdo ainda ficou cortado. Também lista os anexos (com attachmentId, nome e tipo); pra ler o conteúdo de um anexo use gmail_read_attachment.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        const currentAccount = typeof account === 'function' ? await account() : account;
        audit('gmail_read', 'gmail', `msg=${id}`);
        const m = await gget(token, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
        const content = readGmailBody(m.payload);
        const attachments = collectAttachments(m.payload).map((a) => ({ attachmentId: a.attachmentId, filename: a.filename, mimeType: a.mimeType, size: a.size }));
        // E-mail comprido (thread longa, newsletter) era cortado sem marcar, e o
        // modelo respondia "o e-mail diz X" tendo lido só o começo. O caminho de
        // PDF e o de planilha já devolvem `truncated`; agora este também.
        return JSON.stringify({ id: m.id || id, account: currentAccount, link: `https://mail.google.com/mail/${currentAccount ? `?authuser=${encodeURIComponent(currentAccount)}` : ''}#all/${encodeURIComponent(id)}`, from: header(m, 'From'), subject: header(m, 'Subject'), date: header(m, 'Date'), receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null, ...content, attachments });
      },
    });
    tools.push({
      name: 'gmail_read_attachment',
      description: 'Lê o CONTEÚDO (texto) de um anexo de e-mail: PDF (extrai o texto), texto/JSON. PLANILHA (Excel/CSV) não volta como texto: é aberta no ambiente de análise e o resultado traz só a estrutura no campo "analise"; o conteúdo se consulta com analisar_planilha. Passe o id do e-mail (do gmail_search) e o attachmentId (que aparece na lista de anexos do gmail_read). Para outros formatos binários devolve só os metadados. Isto NÃO salva o arquivo: pra entregar o anexo como ARQUIVO pro usuário (chat/Drive) existe a tool salvar_anexo_email no agente principal.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'id do e-mail' }, attachmentId: { type: 'string', description: 'attachmentId do anexo (vem do gmail_read)' } }, required: ['id', 'attachmentId'] },
      async run({ id, attachmentId }) {
        audit('gmail_read_attachment', 'gmail', `msg=${id} att=${attachmentId}`);
        // Baixa os bytes e resolve nome/tipo (mensagem → thread → magic bytes).
        const { buffer: buf, filename: name, mimeType: mime, size, fromMetadata } = await fetchGmailAttachment({ token, messageId: id, attachmentId });
        console.log(`[gmail_read_attachment] name=${name} mime=${mime} size=${buf.length} meta=${fromMetadata}`);
        if (mime === 'application/pdf' || /\.pdf$/i.test(name) || sniffPdf(buf)) {
          return await readPdfBuf(buf, name, mime || 'application/pdf');
        }
        if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|tiff?|bmp)$/i.test(name)) {
          const ocr = await ocrImageFallback(buf, name, mime || 'image/jpeg');
          return ocr || JSON.stringify({ name, mimeType: mime, note: 'Imagem sem texto legível.' });
        }
        // Planilha não volta como texto (ver planilha.mjs).
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
      description: 'Lista os MARCADORES (labels/pastas) que existem na conta Gmail do usuário: os de sistema (INBOX, IMPORTANT, etc.) e os criados por ele, com id, nome e quantos e-mails têm. Use ANTES de organizar a inbox ou criar filtro, pra saber os marcadores que já existem e reaproveitar (não duplicar).',
      parameters: { type: 'object', properties: {} },
      async run() {
        audit('gmail_labels', 'gmail', 'list');
        const labels = await fetchLabels(token);
        const out = labels.map((l) => ({ id: l.id, name: l.name, type: l.type, unread: l.messagesUnread, total: l.messagesTotal }));
        return JSON.stringify(out);
      },
    });
  }

  // ── Gestão de marcadores do Gmail (gmail.labels, escopo sensível): criar/
  // editar/apagar marcador. NÃO inclui organizar a inbox já recebida (aplicar
  // marcador/arquivar em massa exige gmail.modify, que é restrito → CASA). ──
  if (can('gmail', 'manage')) {
    tools.push({
      name: 'gmail_label_create',
      description: 'Cria um novo MARCADOR (label/pasta) no Gmail do usuário. Passe o nome; pra criar aninhado use "Pai/Filho" (ex: "Trabalho/Faturas"). Cheque antes com gmail_labels pra não duplicar. Ação reversível.',
      parameters: { type: 'object', properties: {
        nome: { type: 'string', description: 'Nome do marcador (use "Pai/Filho" pra aninhar).' },
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
      description: 'Renomeia um marcador existente do Gmail. Passe o nome atual (ou o id) e o novo nome. Só marcadores do usuário (os de sistema não podem ser renomeados).',
      parameters: { type: 'object', properties: {
        marcador: { type: 'string', description: 'Nome atual do marcador (ou o id dele).' },
        novo_nome: { type: 'string', description: 'Novo nome.' },
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
      description: 'APAGA um marcador do Gmail do usuário. Os e-mails NÃO são apagados, só perdem esse marcador. Não dá pra desfazer o marcador em si. Só marcadores do usuário.',
      parameters: { type: 'object', properties: {
        marcador: { type: 'string', description: 'Nome (ou id) do marcador a apagar.' },
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

  // ── Filtros do Gmail (gmail.settings.basic) = regras de roteamento: "todo
  // e-mail de X vai pro marcador Y e pula a inbox". ──
  if (can('gmail', 'settings')) {
    tools.push({
      name: 'gmail_filters_list',
      description: 'Lista as REGRAS de roteamento (filtros) do Gmail do usuário: por qual critério (remetente/assunto/etc.) e o que fazem (marcador, arquivar). Use pra ver o que já existe antes de criar outra.',
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
      description: 'Cria uma REGRA de roteamento (filtro) no Gmail: e-mails que casam com o critério recebem uma ação automaticamente, daqui pra frente. Critério: de (remetente), para, assunto, contem (texto/consulta no formato de busca do Gmail), tem_anexo. Ação: marcador (por nome, precisa existir), pular_caixa_entrada, marcar_lido, marcar_importante. Ex: tudo de "news@zara.com" → marcador "Newsletters" e pular a inbox.',
      parameters: { type: 'object', properties: {
        de: { type: 'string', description: 'Remetente (from).' },
        para: { type: 'string', description: 'Destinatário (to).' },
        assunto: { type: 'string', description: 'Texto no assunto.' },
        contem: { type: 'string', description: 'Consulta livre (sintaxe de busca do Gmail).' },
        tem_anexo: { type: 'boolean' },
        marcador: { type: 'string', description: 'Marcador a aplicar (por nome; precisa existir — crie antes).' },
        pular_caixa_entrada: { type: 'boolean', description: 'true = arquiva direto (remove INBOX).' },
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
      description: 'Apaga uma REGRA de roteamento (filtro) do Gmail pelo id (obtido no gmail_filters_list).',
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
      description: 'Busca arquivos no Drive pessoal e nos Drives compartilhados acessíveis. Devolve nomes, IDs e links reais. ' + DRIVE_SEARCH_RULE,
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
    // Fallback de planilha do Google grande demais pro export .xlsx: o CSV do
    // Drive só traz a primeira aba, então o resultado diz isso com todas as letras.
    const lerSheetsCsv = async (id, meta) => {
      const r = await fetch(`${DRIVE}/files/${id}/export?mimeType=text/csv`, { headers: { Authorization: `Bearer ${await token()}` } });
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const analise = await analisePlanilhaConector(onSheetLoad, buf, `${meta.name || 'planilha'}.csv`, 'text/csv');
      return JSON.stringify({ name: meta.name, mimeType: meta.mimeType, analise, note: 'Planilha grande demais pro Google exportar inteira: veio SÓ A PRIMEIRA ABA. As outras abas não foram lidas; diga isso ao usuário em vez de supor o conteúdo delas.' });
    };
    tools.push({
      name: 'drive_read',
      description: 'Lê o conteúdo de um arquivo do Drive pelo id: Google Docs, Apresentações (Slides), PDF e arquivos de texto/JSON. PLANILHA (Google Sheets, Excel, CSV) não volta como texto: é aberta no ambiente de análise e o resultado traz só a estrutura no campo "analise"; o conteúdo se consulta com analisar_planilha. Para outros formatos binários devolve só os metadados.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        audit('drive_read', 'drive', `file=${id}`);
        const meta = await gget(token, `${DRIVE}/files/${id}?fields=id,name,mimeType&supportsAllDrives=true`);
        const mime = meta.mimeType || '';
        // PDF: baixa os bytes e extrai o texto (mesmo pipeline dos PDFs anexados).
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
        // Planilha (Google Sheets, Excel, CSV): baixa os bytes e manda pro
        // ambiente de análise; o resultado leva só a estrutura (ver planilha.mjs).
        // A nativa do Google Sheets é exportada como .xlsx: o export em CSV do
        // Drive só traz a PRIMEIRA aba, e a planilha de várias abas ficava cega
        // (caso de 30/09). Mesmo escopo drive.readonly; nada novo no OAuth.
        const sheetsNativo = mime === 'application/vnd.google-apps.spreadsheet';
        if (sheetsNativo || tipoPlanilha(meta.name, mime)) {
          const url = sheetsNativo
            ? `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
            : `${DRIVE}/files/${id}?alt=media&supportsAllDrives=true`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
          if (!r.ok) {
            const erro = (await r.text()).slice(0, 200);
            // O export do Drive tem teto de tamanho (exportSizeLimitExceeded).
            // Aí cai no CSV, que lê só a primeira aba, e AVISA o modelo disso.
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
      description: 'Lista os eventos do Google Calendar do usuário numa janela de dias. Por padrão lê TODAS as agendas que ele tem (a dele, as de trabalho, as que outras pessoas compartilharam com ele), não só a principal; cada evento vem com o campo `agenda` dizendo de qual veio. Passe `agenda` pra restringir a uma só, ou "todas" pra incluir também os feeds de feriado/aniversário, que ficam de fora por padrão. Pra saber SE/QUANDO algo está marcado, liste o período e LEIA os eventos: NÃO confie só em `query` (o título real pode ser diferente do termo do pedido, ex. pedido "revisão do carro" x evento "Revisão Jeep Alphaville"). O `query` é só um filtro local best-effort; se não casar nada, a tool devolve a agenda inteira do período mesmo assim. Só leitura.',
      parameters: { type: 'object', properties: { inicio: { type:'string', description:'Início da janela, inclusive; ISO ou YYYY-MM-DD. Use para datas passadas ou futuras específicas.' }, fim: { type:'string', description:'Fim da janela, exclusivo; ISO ou YYYY-MM-DD.' }, fuso: { type:'string', description:'Fuso IANA para datas/horas locais.' }, days: { type: 'integer', description: 'Janela em dias a partir de inicio ou agora (padrão 30; máximo 366).' }, query: { type: 'string', description: 'Filtro OPCIONAL por texto do evento (aplicado localmente, sem esconder a agenda). Prefira NÃO usar e ler a lista.' }, max: { type: 'integer', description: 'Máximo de eventos (padrão 50).' }, agenda: { type: 'string', description: 'OPCIONAL. Nome ou id de UMA agenda, quando o dono pediu só ela. Omita pra ler todas (o normal). Use "todas" pra incluir feriados/aniversários.' } } },
      async run({ days = 30, query, max = 50, agenda, inicio, fim, fuso }) {
        const {from:timeMin,to:timeMax}=calendarWindow({inicio,fim,fuso,days});
        if (!Number.isSafeInteger(max) || max<1) throw Error('max deve ser um inteiro positivo.');
        const cals = await listCalendars(token);
        const alvos = pickCalendars(cals, agenda);
        if (!alvos.length) {
          return JSON.stringify({ erro: `Não achei agenda com o nome "${agenda}".`, agendas_disponiveis: cals.map((c) => c.nome) });
        }
        // Teto de agendas por chamada: quem tem 30 calendários compartilhados não
        // pode transformar um "o que tenho hoje" em 30 requisições ao Google.
        const lidas = alvos.slice(0, 12);
        audit('calendar_list', 'calendar', `days=${days} agendas=${lidas.length}`);
        // Sem `q` pro Google: filtro de texto na origem já fez a IA perder evento
        // (busca estreita demais). Puxamos a janela inteira e filtramos localmente.
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
            // Uma agenda quebrada não pode derrubar a resposta inteira, mas o dono
            // precisa saber que ela ficou de fora (senão some em silêncio).
            falhas.push(c.nome);
            return [];
          }
        }));
        const { items, corte } = ordenarECortar(listas.flat(), Math.min(Math.max(1, max), 100));
        const catalogPartial = (!agenda || ['todas','todas as agendas','all'].includes(semAcento(agenda))) && cals.some(c=>c.catalog_partial);
        // O que a resposta cobriu. Sem isso o assistente não tem como avisar que
        // leu 12 de 30 agendas, e diria "não tem nada" sobre o que não leu.
        const contaLida = typeof account === 'function' ? await account() : account;
        const cobertura = {
          // Conta Google de onde vieram os eventos: pra editar/apagar um deles
          // quando não é a conta padrão do assistente, a escrita precisa dela.
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
          // Filtro não casou: devolve a agenda completa pra NUNCA esconder um evento.
          return JSON.stringify({ nota: `Nenhum evento casou com "${query}"; segue a agenda completa dos próximos ${days} dias pra você conferir.`, ...cobertura, eventos: items });
        }
        return JSON.stringify({ ...cobertura, eventos: items });
      },
    });
  }

  if (can('docs', 'read')) {
    tools.push({
      name: 'docs_read',
      description: 'Lê Google Docs incluindo tabelas e abas. Se has_more, continue com next_offset e revision até terminar; partial/warnings indicam limites de leitura.',
      parameters: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 1, maximum: 16000 }, revision: { type: 'string' } }, required: ['id'] },
      async run({ id, offset = 0, max_chars = 8000, revision = null }) {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max_chars) || max_chars < 1 || max_chars > 16000) throw new Error('Paginação inválida');
        audit('docs_read', 'docs', `doc=${id}`);
        const doc = await gget(token, `${DOCS}/${encodeURIComponent(id)}?includeTabsContent=true`);
        return JSON.stringify(readGoogleDocument(doc, { offset, max_chars, revision }));
      },
    });
  }

  // ── Escrita ──
  // Gmail RASCUNHO: vem com a conexão (escopo gmail.compose). Cria um draft, NÃO
  // envia. Ação segura/reversível, não passa pela trava de confirmação.
  if (can('gmail', 'write')) {
    tools.push({
      name: 'gmail_create_draft',
      description: 'Cria um RASCUNHO de e-mail na conta Gmail do usuário (NÃO envia; fica salvo nos Rascunhos pra ele revisar e disparar). Use sempre que ele pedir pra "escrever/preparar um e-mail". Mostre o conteúdo na conversa.',
      parameters: { type: 'object', properties: {
        to: { type: 'string', description: 'Destinatário(s), separados por vírgula.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Corpo do e-mail em texto puro.' },
        cc: { type: 'string', description: 'CC opcional, separado por vírgula.' },
      }, required: ['to', 'subject', 'body'] },
      async run({ to, subject, body, cc }) {
        const raw = buildRawEmail({ to, subject, body, cc });
        const r = await gpost(token, `${GMAIL}/drafts`, { message: { raw } });
        return JSON.stringify({ ok: true, draftId: r.id, note: 'Rascunho criado no Gmail (NÃO enviado).' });
      },
    });
  }

  // Gmail ENVIO: só quando o usuário ATIVOU explicitamente o envio no app
  // (caps.gmail.send). Mesmo assim passa pela trava de confirmação por ação.
  if (can('gmail', 'send')) {
    tools.push({
      name: 'gmail_send',
      description: 'Envia um e-mail em nome do usuário. SEMPRE confirme com o usuário o destinatário, assunto e corpo ANTES de enviar; não envie sem o ok explícito dele.',
      parameters: { type: 'object', properties: {
        to: { type: 'string', description: 'Destinatário(s), separados por vírgula.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Corpo do e-mail em texto puro.' },
        cc: { type: 'string', description: 'CC opcional, separado por vírgula.' },
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
      description: 'Para pedido recorrente, preencha recorrencia e confirme a cadência e o término; nunca substitua por evento único silenciosamente. Cria um evento no Google Calendar do usuário. Vai na agenda principal, a não ser que você passe `agenda` (nome de uma das agendas que apareceram no calendar_list). SEMPRE confirme título, data/hora e convidados ANTES de criar; não crie sem o ok explícito do usuário. Passe `timezone` com o fuso REAL do usuário (IANA, ex America/Zurich pra quem está em Basileia, America/Sao_Paulo no Brasil); o `start`/`end` devem ser a hora de parede local (ex 2026-07-09T11:30:00) SEM offset. Não embuta offset no ISO nem converta a hora você mesmo.',
      parameters: { type: 'object', properties: {
        recorrencia: recurrenceSchema,
        title: { type: 'string' },
        start: { type: 'string', description: 'Início. Hora de parede local ISO SEM offset (ex 2026-07-09T11:30:00) pra evento com horário, ou só data (2026-07-09) pra dia inteiro.' },
        end: { type: 'string', description: 'Fim, mesmo formato do start. Se omitido num evento com hora, assume 1h.' },
        timezone: { type: 'string', description: 'Fuso IANA do usuário (ex America/Zurich, Europe/Lisbon, America/Sao_Paulo). Default America/Sao_Paulo se omitido.' },
        description: { type: 'string' },
        location: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'E-mails dos convidados.' },
        agenda: { type: 'string', description: 'OPCIONAL. Nome da agenda onde criar, quando não for a principal (use o nome que veio no campo `agenda` do calendar_list).' },
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
      description: 'EDITA um evento que já existe numa agenda do usuário (Google Calendar). Use pra remarcar horário, mudar título, local, descrição ou convidados de um evento EXISTENTE (nunca crie um novo pra "editar"). Primeiro use calendar_list pra achar o evento e pegar o `id`. Se o evento veio de uma agenda que não é a principal, passe o mesmo `agenda` que veio no calendar_list. Passe SÓ os campos que mudam. SEMPRE confirme a mudança com o usuário antes. Pra horário, use `timezone` com o fuso REAL do usuário (IANA) e `start`/`end` como hora de parede local ISO SEM offset.',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: 'Id do evento a editar (venha do calendar_list).' },
        title: { type: 'string', description: 'Novo título (só se mudar).' },
        start: { type: 'string', description: 'Novo início. Hora de parede local ISO SEM offset (ex 2026-07-09T11:30:00) ou só data (dia inteiro). Só se mudar.' },
        end: { type: 'string', description: 'Novo fim, mesmo formato do start. Só se mudar.' },
        timezone: { type: 'string', description: 'Fuso IANA do usuário (ex America/Sao_Paulo, America/Zurich). Use quando mexer no horário.' },
        description: { type: 'string', description: 'Nova descrição (só se mudar).' },
        location: { type: 'string', description: 'Novo local (só se mudar).' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Lista COMPLETA de e-mails dos convidados (substitui a atual). Só se mudar.' },
        agenda: { type: 'string', description: 'OPCIONAL. Agenda do evento, quando não for a principal (use o `agenda` que veio no calendar_list).' },
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
        // Convidado sempre fica sabendo: mudar horário ou local sem avisar deixa
        // o outro lado na reunião errada.
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
      description: 'APAGA um evento de uma agenda do usuário (Google Calendar). Use calendar_list pra achar o `id` primeiro; se o evento veio de uma agenda que não é a principal, passe o mesmo `agenda` que veio de lá. SEMPRE confirme com o usuário antes de apagar; ação irreversível.',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: 'Id do evento a apagar (venha do calendar_list).' },
        agenda: { type: 'string', description: 'OPCIONAL. Agenda do evento, quando não for a principal (use o `agenda` que veio no calendar_list).' },
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
      description: `Cria um arquivo de texto no Google Drive do usuário, sempre dentro da pasta do assistente ("${folderName}") na raiz. Não dá pra escolher outra pasta nem salvar solto na raiz (o app só mexe na própria pasta). Confirme nome e conteúdo antes.`,
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'Nome do arquivo (ex: notas.txt).' },
        content: { type: 'string', description: 'Conteúdo em texto.' },
        mimeType: { type: 'string', description: 'MIME do arquivo (padrão text/plain).' },
      }, required: ['name', 'content'] },
      async run({ name, content, mimeType = 'text/plain' }) {
        // GUARD anti "undefined": se o conteúdo não veio (arg truncado numa geração
        // longa, tool-call sem o campo, etc.), NUNCA gravar o arquivo — senão o Drive
        // fica com a string literal "undefined"/vazio (bug de 28/07). Falha com
        // erro claro e acionável em vez de corromper silenciosamente.
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

    // Cria um Google Doc NATIVO a partir de texto. Diferente do drive_upload (que
    // gera um .txt solto), aqui o Drive CONVERTE o corpo num documento Google de
    // verdade (metadata com mimeType-alvo google-apps.document), que abre/edita no
    // Docs e pode ser exportado pra PDF depois. Escopo drive.file cobre a criação.
    tools.push({
      name: 'docs_create',
      description: 'Cria um Google Doc NATIVO (documento do Google, não um .txt) a partir de texto, dentro da pasta do assistente no Drive. Use quando o usuário pedir pra "montar/criar um Google Doc". Aceita HTML simples no conteúdo pra ter layout (títulos <h1>, negrito <b>, listas <ul>) — passe html=true nesse caso. Devolve o link do documento. Confirme nome e conteúdo antes.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'Título do documento.' },
        content: { type: 'string', description: 'Conteúdo (texto puro, ou HTML simples se html=true).' },
        html: { type: 'boolean', description: 'true se content for HTML (pra ter layout). Padrão false = texto puro.' },
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

    // Exporta um arquivo GOOGLE (Doc/Sheet/Slides) pra PDF e salva o PDF na pasta
    // do assistente no Drive. Cobre "transforma esse Google Doc num PDF". O export
    // do Drive só vale pros formatos nativos do Google; PDF já é PDF, binário comum
    // não exporta.
    tools.push({
      name: 'drive_export_pdf',
      description: 'Transforma um Google Doc (ou Planilha/Apresentação) num PDF: exporta o arquivo pra PDF e salva na pasta do assistente no Drive, devolvendo o link do PDF. Passe o id do arquivo (vem do drive_search/google). Use quando o usuário pedir "gera um PDF desse Google Doc / transforma em PDF". Para juntar conteúdo novo e virar PDF, crie o Google Doc antes com docs_create e depois exporte o id dele aqui.',
      parameters: { type: 'object', properties: {
        id: { type: 'string', description: 'id do Google Doc/Sheet/Slides a exportar.' },
        name: { type: 'string', description: 'Nome opcional do PDF (padrão: nome do arquivo + .pdf).' },
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

// Procura pelo nome EXATO, restrito à pasta recebida.
// O escopo OAuth existente continua valendo.
// Nome não é identificador único: só reusar quando a busca completa acha UM.
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

// Sobe um arquivo BINÁRIO (PDF, imagem, planilha…) pro Drive do usuário.
// `buffer` é um Buffer com os bytes crus; monta um multipart/related com o corpo
// binário (não string), diferente do drive_upload de texto. Escopo drive.file
// cobre a escrita. Usado pela tool drive_upload_arquivo (lê os bytes do sandbox).
//
// ATUALIZA NO LUGAR: se já existe arquivo com o MESMO nome na pasta do
// assistente, reescreve os bytes dele (PATCH uploadType=media) em vez de criar
// cópia nova. O id e o LINK continuam os mesmos, que é o que a pessoa espera ao
// pedir "atualiza a planilha" (antes cada envio gerava link novo e o anterior
// virava lixo). Passe update:false pra forçar cópia nova. Não mexe em escopo
// OAuth: drive.file já permite atualizar arquivo criado pelo app.
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
