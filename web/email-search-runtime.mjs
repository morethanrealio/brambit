// Execution of the "busca_email" routine: builds the exact query from the
// recorded config, runs it on Gmail (REST API) or Outlook (Microsoft Graph)
// paging to the end (or to the ceiling) and returns the ready-made list for the
// model to summarize. Nothing here depends on the model: same query, same
// result, every run.
//
// Read-only (gmail.readonly / Mail.Read already granted). No new scope.

import { readGmailBody, collectAttachments } from './gmail-payload.mjs';

import { normalizeEmailBody, limitEmailBody } from './email-body.mjs';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export const EMAIL_SEARCH_CAP = 200;        // ceiling of messages per run
export const EMAIL_SEARCH_PAGE = 50;        // page size
export const EMAIL_SEARCH_BODY_LIMIT = 15;  // quantas ganham corpo (as mais recentes)
export const EMAIL_SEARCH_BODY_CHARS = 1500;
const CONCURRENCY = 6;

// ---- consultas ----

// Gmail: ("a" OR "b") (from:x OR from:y) newer_than:Nd [is:unread] [has:attachment] -from:me
// `-from:me` = only RECEIVED emails: the routine is about what came in, and
// without this the owner's own replies (which quote the term) would come back
// as "news".
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

// Outlook (Graph $search, KQL syntax). Without a term/sender uses $filter by
// date (more precise). Date is also filtered client-side.
export function buildGraphQuery(c, since) {
  const day = since.toISOString().slice(0, 10);
  // $search (KQL) only when there's a term/sender; flags/date-only goes through
  // $filter, which is exact and accepts $orderby.
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
      if (m.receivedDateTime && new Date(m.receivedDateTime) < since) continue; // $search doesn't guarantee the date
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

// deps.token: async () => access token (Gmail or Graph depending on c.provider).
// Throws if the search itself fails (token, network, 4xx/5xx on the listing).
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
  // partial = something was left out (ceiling or a message that didn't open): triggers the footer.
  r.partial = r.truncated || r.errors.length > 0 || r.items.some(m=>m.truncated || m.links_truncated);
  return r;
}

// Block that goes into the routine's frame. The model only works with this.
export function emailSearchPromptBlock(c, r, { language = 'pt-BR' } = {}) {
  const conta = r.account ? ` (account ${r.account})` : '';
  const prov = r.provider === 'outlook' ? 'Outlook' : 'Gmail';
  const lines = [];
  lines.push('[BUSCA DE E-MAIL EXECUTADA PELA PLATAFORMA]');
  lines.push(`The platform already queried ${prov}${conta} with the exact query: ${r.query}`);
  lines.push(`Window: last ${r.days} day${r.days === 1 ? '' : 's'}. Result: ${r.total} email${r.total === 1 ? '' : 's'}${r.truncated ? ` (list cut at the cap of ${EMAIL_SEARCH_CAP}; the most recent ones are here)` : ' (complete list, paginated to the end)'}.`);
  if (r.errors.length) lines.push(`${r.errors.length} message(s) did not open and were left out.`);
  lines.push('Rules: do NOT redo the search, do NOT use an email tool and do NOT say you are going to search; work ONLY with the list below. Do what the routine asks using these emails. Cite sender, subject and date when relevant. Do not make up content that is not in the snippet/body.');
  // Product decision (13/09): a search routine ALWAYS shows signs of life. Silence looks like failure
  // ("it broke, the assistant didn't do the job"). Empty = one sentence saying what it searched and found nothing.
  if (r.total === 0) lines.push(`The list is EMPTY. Reply in ONE sentence that the search was done (${prov}, last ${r.days} day${r.days === 1 ? '' : 's'}) and found no email on the subject. NEVER reply [ROTINA_SEM_NOVIDADES] nor stay silent, even if the routine asks for it: with no message, the person thinks the routine failed.`);
  else lines.push('If no email in the list is relevant to what the routine asks, say so in ONE sentence (what was searched and that nothing relevant arrived). NEVER reply [ROTINA_SEM_NOVIDADES] nor stay silent, even if the routine asks for it.');
  lines.push('--- E-MAILS (most recent first) ---');
  r.items.forEach((m, i) => {
    lines.push(`${i + 1}. From: ${m.from || '?'} | Subject: ${m.subject || '(no subject)'} | Date: ${m.date || '?'}${m.unread ? ' | unread' : ''}${m.attachments.length ? ` | attachments: ${m.attachments.join(', ')}` : ''}`);
    if (m.link) lines.push(`   Link: ${m.link}`);
    if (m.snippet) lines.push(`   Snippet: ${m.snippet}`);
    if (m.truncated) lines.push('   Partial read: the body was not made available in full; do not conclude that data is absent from the rest.');
    if (m.links?.length) lines.push('   Links present in the email (not visited): '+JSON.stringify(m.links));
    if (m.links_truncated) lines.push('   The list of links was also limited.');
    if (m.body) lines.push(`   Body: ${m.body.replace(/\n/g, '\n   ')}`);
  });
  if (!r.items.length) lines.push('(none)');
  lines.push('--- FIM DOS E-MAILS ---');
  return lines.join('\n');
}

// When the search itself failed (token, network, API): the model warns, doesn't fake it.
export function emailSearchFailureBlock(c, err) {
  const prov = c.provider === 'outlook' ? 'Outlook' : 'Gmail';
  return [
    '[BUSCA DE E-MAIL FALHOU]',
    `The platform tried to query ${prov}${c.account ? ` (account ${c.account})` : ''} and the API did not respond: ${String(err?.message || err).slice(0, 200)}`,
    'Do not try to search on your own. Say in one or two sentences that this routine\'s email search could not be done right now and, if the error is about the account connection (Google/Microsoft not connected or expired), tell the person to reconnect it under Connections (Conexões).',
  ].join('\n');
}

// Short summary for the test done when the routine is created.
export function describeEmailSearchTest(r) {
  const n = r.total;
  const base = `Testei agora: ${n === 0 ? 'nenhum e-mail' : n === 1 ? '1 e-mail' : `${n} e-mails`} nos últimos ${r.days} dia${r.days === 1 ? '' : 's'}${r.truncated ? ' (teto atingido)' : ''}.`;
  if (!n) return base + ' A rotina vai rodar mesmo assim e, quando não achar nada, avisa em uma linha que não encontrou.';
  const ex = r.items.slice(0, 3).map((m) => `"${m.subject || '(sem assunto)'}" de ${m.from || '?'}`).join('; ');
  return `${base} Exemplos: ${ex}.`;
}
