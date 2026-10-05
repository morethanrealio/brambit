// Execução da rotina "busca_email": monta a consulta exata a partir do config
// gravado, roda no Gmail (API REST) ou Outlook (Microsoft Graph) paginando até
// o fim (ou até o teto) e devolve a lista pronta pro modelo resumir. Nada aqui
// depende do modelo: mesma consulta, mesmo resultado, toda execução.
//
// Só leitura (gmail.readonly / Mail.Read já concedidos). Nenhum escopo novo.

import { readGmailBody, collectAttachments } from './gmail-payload.mjs';

import { normalizeEmailBody, limitEmailBody } from './email-body.mjs';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export const EMAIL_SEARCH_CAP = 200;        // teto de mensagens por execução
export const EMAIL_SEARCH_PAGE = 50;        // tamanho da página
export const EMAIL_SEARCH_BODY_LIMIT = 15;  // quantas ganham corpo (as mais recentes)
export const EMAIL_SEARCH_BODY_CHARS = 1500;
const CONCURRENCY = 6;

// ---- consultas ----

// Gmail: ("a" OR "b") (from:x OR from:y) newer_than:Nd [is:unread] [has:attachment] -from:me
// `-from:me` = só e-mails RECEBIDOS: a rotina é sobre o que chegou, e sem isso as
// próprias respostas do dono (que citam o termo) voltariam como "novidade".
export function buildGmailQuery(c) {
  const parts = [];
  if (c.terms?.length) parts.push(c.terms.length === 1 ? q(c.terms[0]) : '(' + c.terms.map(q).join(' OR ') + ')');
  if (c.senders?.length) parts.push(c.senders.length === 1 ? `from:${c.senders[0]}` : '(' + c.senders.map((s) => `from:${s}`).join(' OR ') + ')');
  parts.push(`newer_than:${c.days}d`);
  if (c.unreadOnly) parts.push('is:unread');
  if (c.withAttachment) parts.push('has:attachment');
  parts.push('-from:me');
  return parts.join(' ');
}
const q = (t) => (/\s/.test(t) ? `"${t}"` : t);

// Outlook (Graph $search, sintaxe KQL). Sem termo/remetente usa $filter por
// data (mais preciso). Data também é filtrada do lado do cliente.
export function buildGraphQuery(c, since) {
  const day = since.toISOString().slice(0, 10);
  // $search (KQL) só quando há termo/remetente; só flags/data vai de $filter,
  // que é exato e aceita $orderby.
  if (c.terms?.length || c.senders?.length) {
    const kql = [];
    if (c.terms?.length) kql.push(c.terms.length === 1 ? q(c.terms[0]) : '(' + c.terms.map(q).join(' OR ') + ')');
    if (c.senders?.length) kql.push(c.senders.length === 1 ? `from:${c.senders[0]}` : '(' + c.senders.map((s) => `from:${s}`).join(' OR ') + ')');
    if (c.unreadOnly) kql.push('isRead:false');
    if (c.withAttachment) kql.push('hasAttachments:true');
    kql.push(`received>=${day}`);
    return { mode: 'search', text: kql.join(' AND ') };
  }
  const f = [`receivedDateTime ge ${since.toISOString()}`];
  if (c.unreadOnly) f.push('isRead eq false');
  if (c.withAttachment) f.push('hasAttachments eq true');
  return { mode: 'filter', text: f.join(' and ') };
}

export function sinceDate(days, now = new Date()) {
  return new Date(now.getTime() - days * 86400000);
}

// ---- helpers ----

async function getJson(fetchImpl, token, url, headers = {}) {
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return out;
}

const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
const clip = (s, n) => { s = String(s || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

// ---- Gmail ----

async function runGmail(c, deps) {
  const { token, fetchImpl, cap, page, bodyLimit } = deps;
  const query = buildGmailQuery(c);
  const ids = [];
  let pageToken = '';
  let pages = 0;
  let truncated = false;
  for (;;) {
    const url = `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=${page}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const j = await getJson(fetchImpl, token, url);
    pages++;
    for (const m of j.messages || []) ids.push(m.id);
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
    if (ids.length >= cap) { truncated = true; break; }
  }
  const take = ids.slice(0, cap);
  if (ids.length > cap) truncated = true;
  const errors = [];
  const items = await mapLimit(take, CONCURRENCY, async (id, idx) => {
    const full = idx < bodyLimit;
    const url = full
      ? `${GMAIL}/messages/${id}?format=full`
      : `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`;
    try {
      const m = await getJson(fetchImpl, token, url);
      const labels = m.labelIds || [];
      const content = full ? readGmailBody(m.payload,{maxChars:deps.bodyChars}) : {body:'',links:[]};
      const atts = full ? collectAttachments(m.payload).map((a) => a.filename).filter(Boolean) : [];
      return {
        id, from: header(m, 'From'), to: header(m, 'To'), subject: header(m, 'Subject'), date: header(m, 'Date'),
        ts: m.internalDate ? Number(m.internalDate) : 0,
        snippet: clip(m.snippet, 300),
        ...content,
        unread: labels.includes('UNREAD'), attachments: atts,
        link: `https://mail.google.com/mail/#all/${id}`,
      };
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
      return null;
    }
  });
  const list = items.filter(Boolean).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return { provider: 'gmail', query, total: list.length, pages, truncated, items: list, errors };
}

// ---- Outlook / Graph ----

async function runGraph(c, deps) {
  const { token, fetchImpl, cap, page, bodyLimit, now } = deps;
  const since = sinceDate(c.days, now);
  const gq = buildGraphQuery(c, since);
  const select = '$select=id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink';
  let url = gq.mode === 'search'
    ? `${GRAPH}/me/messages?$search=${encodeURIComponent(`"${gq.text.replace(/"/g, '\\"')}"`)}&$top=${Math.min(page, 25)}&${select}`
    : `${GRAPH}/me/messages?$filter=${encodeURIComponent(gq.text)}&$orderby=receivedDateTime%20desc&$top=${page}&${select}`;
  const raw = [];
  let pages = 0;
  let truncated = false;
  while (url) {
    const j = await getJson(fetchImpl, token, url);
    pages++;
    for (const m of j.value || []) {
      if (m.receivedDateTime && new Date(m.receivedDateTime) < since) continue; // $search não garante a data
      raw.push(m);
    }
    url = j['@odata.nextLink'] || '';
    if (url && raw.length >= cap) { truncated = true; break; }
  }
  raw.sort((a, b) => new Date(b.receivedDateTime || 0) - new Date(a.receivedDateTime || 0));
  const take = raw.slice(0, cap);
  if (raw.length > cap) truncated = true;
  const errors = [];
  const items = await mapLimit(take, CONCURRENCY, async (m, idx) => {
    const base = {
      id: m.id, from: m.from?.emailAddress ? `${m.from.emailAddress.name || ''} <${m.from.emailAddress.address || ''}>`.trim() : '',
      to: '', subject: m.subject || '', date: m.receivedDateTime || '', ts: m.receivedDateTime ? new Date(m.receivedDateTime).getTime() : 0,
      snippet: clip(m.bodyPreview, 300), body: '', unread: m.isRead === false, attachments: [],
      link: m.webLink || '',
    };
    if (idx >= bodyLimit) return base;
    try {
      const d = await getJson(fetchImpl, token, `${GRAPH}/me/messages/${encodeURIComponent(m.id)}?$select=body,hasAttachments&$expand=attachments($select=name)`, { Prefer: 'outlook.body-content-type="text"' });
      Object.assign(base,limitEmailBody(normalizeEmailBody(d.body?.content,d.body?.contentType || 'text'),deps.bodyChars));
      base.attachments = (d.attachments || []).map((a) => a.name).filter(Boolean);
    } catch (e) {
      errors.push(`${m.id}: ${e.message}`);
    }
    return base;
  });
  return { provider: 'outlook', query: gq.mode === 'search' ? `$search=${gq.text}` : `$filter=${gq.text}`, total: items.length, pages, truncated, items, errors };
}

// ---- entrada ----

// deps.token: async () => access token (Gmail ou Graph conforme c.provider).
// Lança se a busca em si falhar (token, rede, 4xx/5xx na listagem).
export async function executeEmailSearch(c, deps = {}) {
  const d = {
    fetchImpl: deps.fetchImpl || globalThis.fetch,
    token: deps.token,
    cap: deps.cap ?? EMAIL_SEARCH_CAP,
    page: deps.page ?? EMAIL_SEARCH_PAGE,
    bodyLimit: deps.bodyLimit ?? EMAIL_SEARCH_BODY_LIMIT,
    bodyChars: deps.bodyChars ?? EMAIL_SEARCH_BODY_CHARS,
    now: deps.now || new Date(),
  };
  if (typeof d.token !== 'function') throw new Error('executeEmailSearch: token deve ser função.');
  const t0 = Date.now();
  const r = c.provider === 'outlook' ? await runGraph(c, d) : await runGmail(c, d);
  r.ms = Date.now() - t0;
  r.days = c.days;
  r.account = c.account || null;
  // partial = algo ficou de fora (teto ou mensagem que não abriu): dispara o rodapé.
  r.partial = r.truncated || r.errors.length > 0 || r.items.some(m=>m.truncated || m.links_truncated);
  return r;
}

// Bloco que entra no frame da rotina. O modelo só trabalha com isto.
export function emailSearchPromptBlock(c, r, { language = 'pt-BR' } = {}) {
  const conta = r.account ? ` (conta ${r.account})` : '';
  const prov = r.provider === 'outlook' ? 'Outlook' : 'Gmail';
  const lines = [];
  lines.push('[BUSCA DE E-MAIL EXECUTADA PELA PLATAFORMA]');
  lines.push(`A plataforma já consultou o ${prov}${conta} com a consulta exata: ${r.query}`);
  lines.push(`Janela: últimos ${r.days} dia${r.days === 1 ? '' : 's'}. Resultado: ${r.total} e-mail${r.total === 1 ? '' : 's'}${r.truncated ? ` (lista cortada no teto de ${EMAIL_SEARCH_CAP}; os mais recentes estão aqui)` : ' (lista completa, paginada até o fim)'}.`);
  if (r.errors.length) lines.push(`${r.errors.length} mensagem(ns) não abriram e ficaram de fora.`);
  lines.push('Regras: NÃO refaça a busca, NÃO use ferramenta de e-mail e NÃO diga que vai buscar; trabalhe SOMENTE com a lista abaixo. Cumpra o que a rotina pede usando esses e-mails. Cite remetente, assunto e data quando relevante. Não invente conteúdo que não esteja no trecho/corpo.');
  // Decisão de produto (Marcos 13/09): rotina de busca SEMPRE dá sinal de vida. Silêncio parece falha
  // ("deu pau, o assistente não fez o trabalho"). Vazio = uma frase dizendo o que buscou e que não achou.
  if (r.total === 0) lines.push(`A lista está VAZIA. Responda em UMA frase que a busca foi feita (${prov}, últimos ${r.days} dia${r.days === 1 ? '' : 's'}) e não encontrou nenhum e-mail sobre o assunto. NUNCA responda [ROTINA_SEM_NOVIDADES] nem fique em silêncio, mesmo que a rotina peça isso: sem mensagem, a pessoa acha que a rotina falhou.`);
  else lines.push('Se nenhum e-mail da lista for relevante pro que a rotina pede, diga isso em UMA frase (o que foi buscado e que não chegou nada relevante). NUNCA responda [ROTINA_SEM_NOVIDADES] nem fique em silêncio, mesmo que a rotina peça isso.');
  lines.push('--- E-MAILS (mais recentes primeiro) ---');
  r.items.forEach((m, i) => {
    lines.push(`${i + 1}. De: ${m.from || '?'} | Assunto: ${m.subject || '(sem assunto)'} | Data: ${m.date || '?'}${m.unread ? ' | não lido' : ''}${m.attachments.length ? ` | anexos: ${m.attachments.join(', ')}` : ''}`);
    if (m.link) lines.push(`   Link: ${m.link}`);
    if (m.snippet) lines.push(`   Trecho: ${m.snippet}`);
    if (m.truncated) lines.push('   Leitura parcial: o corpo não foi disponibilizado integralmente; não conclua ausência de dados no restante.');
    if (m.links?.length) lines.push('   Links presentes no e-mail (não acessados): '+JSON.stringify(m.links));
    if (m.links_truncated) lines.push('   A lista de links também foi limitada.');
    if (m.body) lines.push(`   Corpo: ${m.body.replace(/\n/g, '\n   ')}`);
  });
  if (!r.items.length) lines.push('(nenhum)');
  lines.push('--- FIM DOS E-MAILS ---');
  return lines.join('\n');
}

// Quando a busca em si falhou (token, rede, API): o modelo avisa, não finge.
export function emailSearchFailureBlock(c, err) {
  const prov = c.provider === 'outlook' ? 'Outlook' : 'Gmail';
  return [
    '[BUSCA DE E-MAIL FALHOU]',
    `A plataforma tentou consultar o ${prov}${c.account ? ` (conta ${c.account})` : ''} e a API não respondeu: ${String(err?.message || err).slice(0, 200)}`,
    'Não tente buscar por conta própria. Diga em uma ou duas frases que a busca de e-mails desta rotina não pôde ser feita agora e, se o erro for de conexão da conta (Google/Microsoft não conectado ou expirado), oriente a reconectar em Conexões.',
  ].join('\n');
}

// Resumo curto pro teste feito na criação da rotina.
export function describeEmailSearchTest(r) {
  const n = r.total;
  const base = `Testei agora: ${n === 0 ? 'nenhum e-mail' : n === 1 ? '1 e-mail' : `${n} e-mails`} nos últimos ${r.days} dia${r.days === 1 ? '' : 's'}${r.truncated ? ' (teto atingido)' : ''}.`;
  if (!n) return base + ' A rotina vai rodar mesmo assim e, quando não achar nada, avisa em uma linha que não encontrou.';
  const ex = r.items.slice(0, 3).map((m) => `"${m.subject || '(sem assunto)'}" de ${m.from || '?'}`).join('; ');
  return `${base} Exemplos: ${ex}.`;
}
