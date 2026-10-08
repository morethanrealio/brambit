import { marca, uaApi } from './marca.mjs';
import { normalizeEmailBody, limitEmailBody } from './email-body.mjs';
import { microsoftToolAllowed } from './microsoft-scopes.mjs';
import { recortar } from './recorte.mjs';
import { searchPagination, searchCursorSchema, SEARCH_PAGINATION_RULE, searchItems, githubSearchMeta, slackSearchMeta, graphSearchNextPath } from './search-pagination.mjs';
import { emailPagination, emailCursorSchema, EMAIL_PAGINATION_RULE, graphEmailNextPath } from './email-pagination.mjs';
import { recurrenceSchema, calendarRecurrence, recurrenceDefaultEnd, calendarWindow } from './calendar-recurrence.mjs';
// ── External connectors (GitHub, Slack) as core tools ──
// Same shape as Google's tools (connectors.mjs): they receive an async `token()`
// that returns a valid access_token and become tools in the harness tool-loop.
// Reading is always allowed; writing (opening an issue, commenting, posting to
// Slack) comes with a notice to confirm with the user first.

import { linkedinIdentity } from './providers.mjs';
// Reading OneDrive content reuses the SAME pipeline as Google Drive files/
// attachments (PDF extractor, spreadsheet converter, image OCR), so the user
// gets the same response regardless of where the file lives.
import { extractPdfText } from './pdf.mjs';
import { analisePlanilhaConector, tipoPlanilha } from './planilha.mjs';
import { ocrPdf, describeImage } from './media.mjs';

// ── GitHub ──
const GH = 'https://api.github.com';

async function ghReq(token, path, { method = 'GET', body } = {}) {
  const r = await fetch(GH + path, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'brambs',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const issueBrief = (i) => ({
  number: i.number, title: i.title, state: i.state,
  author: i.user?.login, comments: i.comments,
  isPR: !!i.pull_request, url: i.html_url,
  repo: i.repository_url ? i.repository_url.replace('https://api.github.com/repos/', '') : undefined,
});

export function githubTools({ token }) {
  const repoPages = searchPagination({ defaultMax: 8, cap: 15 });
  const issuePages = searchPagination({ defaultMax: 10, cap: 20 });
  return [
    {
      name: 'github_list_repos',
      description: 'Lists the user\'s own GitHub repositories, INCLUDING the private ones and those of their organizations. Use this (not search) when they ask for "meus repositórios" or want to see what they have. Sorted by most recently updated.',
      parameters: { type: 'object', properties: { visibility: { type: 'string', description: 'all (default), public or private.' }, max: { type: 'integer', description: 'Default 30.' } } },
      async run({ visibility = 'all', max = 30 } = {}) {
        const j = await ghReq(token, `/user/repos?visibility=${encodeURIComponent(visibility)}&affiliation=owner,collaborator,organization_member&sort=updated&per_page=${Math.min(max, 100)}`);
        const out = (Array.isArray(j) ? j : []).map((r) => ({ full_name: r.full_name, private: r.private, description: r.description, language: r.language, default_branch: r.default_branch, updated_at: r.updated_at, url: r.html_url }));
        return out.length ? JSON.stringify(out) : 'Nenhum repositório encontrado.';
      },
    },
    {
      name: 'github_read_path',
      description: 'Reads the content of a repository (public or private) at the given path: if it is a file, returns the text; if it is a folder (or empty path), lists what is inside. Use to browse and read the code of the user\'s repositories.',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string', description: 'Path inside the repo. Empty = root.' }, ref: { type: 'string', description: 'Branch/tag/commit (optional).' } }, required: ['owner', 'repo'] },
      async run({ owner, repo, path = '', ref }) {
        const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
        const j = await ghReq(token, `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${q}`);
        if (Array.isArray(j)) {
          const entries = j.map((e) => ({ name: e.name, type: e.type, size: e.size, path: e.path }));
          return JSON.stringify({ dir: path || '/', entries });
        }
        if (j.type === 'file') {
          if (j.encoding === 'base64' && j.content) {
            const text = Buffer.from(j.content, 'base64').toString('utf8');
            const clipped = text.length > 12000;
            return JSON.stringify({ file: j.path, size: j.size, content: text.slice(0, 12000), clipped });
          }
          return JSON.stringify({ file: j.path, size: j.size, note: 'Arquivo binário ou grande demais pra ler como texto.', url: j.html_url });
        }
        return JSON.stringify(j);
      },
    },
    {
      name: 'github_search_repos',
      description: 'Searches GitHub repositories using search syntax. Returns items with the data and links. ' + SEARCH_PAGINATION_RULE,
      parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1 }, cursor: searchCursorSchema }, required: ['query'] },
      async run({ query, max, cursor } = {}) {
        const page = repoPages.request(query,max,cursor);
        const j = await ghReq(token, `/search/repositories?q=${encodeURIComponent(query)}&per_page=${page.pageSize}&page=${page.page}`);
        const meta = githubSearchMeta(j,page);
        const items = searchItems(j.items,page,'full_name').map(r => ({ full_name: r.full_name, description: r.description, stars: r.stargazers_count, language: r.language, url: r.html_url, private: r.private }));
        return repoPages.result(page,items,meta);
      },
    },
    {
      name: 'github_search_issues',
      description: 'Searches GitHub issues and pull requests using search syntax. Returns items with the data and links. ' + SEARCH_PAGINATION_RULE,
      parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1 }, cursor: searchCursorSchema }, required: ['query'] },
      async run({ query, max, cursor } = {}) {
        const page = issuePages.request(query,max,cursor);
        const j = await ghReq(token, `/search/issues?q=${encodeURIComponent(query)}&per_page=${page.pageSize}&page=${page.page}`);
        const meta = githubSearchMeta(j,page);
        const items = searchItems(j.items,page,'number').map(issueBrief);
        return issuePages.result(page,items,meta);
      },
    },
    {
      name: 'github_list_issues',
      description: 'Lists the issues of a repository. state: open (default), closed or all.',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' }, max: { type: 'integer' } }, required: ['owner', 'repo'] },
      async run({ owner, repo, state = 'open', max = 15 }) {
        const j = await ghReq(token, `/repos/${owner}/${repo}/issues?state=${state}&per_page=${Math.min(max, 30)}`);
        const out = (Array.isArray(j) ? j : []).map(issueBrief);
        return out.length ? JSON.stringify(out) : 'Nenhuma issue.';
      },
    },
    {
      name: 'github_read_issue',
      description: 'Reads an issue or PR by number, with body and comments.',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'number'] },
      async run({ owner, repo, number }) {
        const i = await ghReq(token, `/repos/${owner}/${repo}/issues/${number}`);
        let comments = [];
        // Only the FIRST page of comments is read. In a long discussion issue
        // (which is exactly where the conclusion lives) the rest would vanish
        // without a trace, and the model would answer "the issue ended at X"
        // looking only at the first 20. `i.comments` is the real total, so we
        // can state what was missing.
        const PAGINA_COMENTARIOS = 20;
        if (i.comments) {
          const c = await ghReq(token, `/repos/${owner}/${repo}/issues/${number}/comments?per_page=${PAGINA_COMENTARIOS}`);
          comments = (Array.isArray(c) ? c : []).map((x) => {
            const b = recortar(x.body || '', 1500, 'comentário');
            return { author: x.user?.login, body: b.corpo, truncated: b.truncado || undefined };
          });
        }
        const corpo = recortar(i.body || '', 4000, 'corpo da issue');
        const faltam = Math.max(0, Number(i.comments || 0) - comments.length);
        return JSON.stringify({
          number: i.number, title: i.title, state: i.state, author: i.user?.login,
          isPR: !!i.pull_request, body: corpo.corpo, bodyTruncated: corpo.truncado || undefined,
          url: i.html_url, comments,
          commentsTotal: i.comments || 0,
          commentsOmitidos: faltam || undefined,
          nota: faltam ? `Mostrei os ${comments.length} primeiros comentários de ${i.comments}; ${faltam} não foram lidos. Não conclua sobre o desfecho da issue sem avisar que faltam comentários.` : undefined,
        });
      },
    },
    {
      name: 'github_create_issue',
      description: 'Opens an issue in a repository. ALWAYS confirm repository, title and body with the user BEFORE creating; do not create without their explicit ok.',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] },
      async run({ owner, repo, title, body, labels }) {
        const payload = { title };
        if (body) payload.body = body;
        if (labels?.length) payload.labels = labels;
        const i = await ghReq(token, `/repos/${owner}/${repo}/issues`, { method: 'POST', body: payload });
        return JSON.stringify({ ok: true, id: i.id, number: i.number, url: i.html_url, note: 'Issue criada.' });
      },
    },
    {
      name: 'github_comment_issue',
      description: 'Comments on an issue or PR. ALWAYS confirm the text with the user BEFORE commenting; do not comment without their explicit ok.',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'integer' }, body: { type: 'string' } }, required: ['owner', 'repo', 'number', 'body'] },
      async run({ owner, repo, number, body }) {
        const c = await ghReq(token, `/repos/${owner}/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } });
        return JSON.stringify({ ok: true, id: c.id, url: c.html_url, note: 'Comentário publicado.' });
      },
    },
  ];
}

// ── Slack (user token) ──
const SL = 'https://slack.com/api';

async function slReq(token, method, params = {}, post = false) {
  let r;
  if (post) {
    r = await fetch(`${SL}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(params),
    });
  } else {
    const qs = new URLSearchParams(params).toString();
    r = await fetch(`${SL}/${method}${qs ? '?' + qs : ''}`, { headers: { Authorization: `Bearer ${await token()}` } });
  }
  const j = await r.json();
  if (!j.ok) throw new Error(`slack ${method}: ${j.error || 'erro'}`);
  return j;
}

export function slackTools({ token }) {
  const pages = searchPagination({ defaultMax: 10, cap: 20 });
  return [
    {
      name: 'slack_search',
      description: 'Searches Slack messages (e.g. from:@joao in:#geral fatura). Returns items with text, author, channel and link; long text flags text_truncated. ' + SEARCH_PAGINATION_RULE,
      parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, description: 'Page: default 10, maximum 20.' }, cursor: searchCursorSchema }, required: ['query'] },
      async run({ query, max, cursor } = {}) {
        const page = pages.request(query,max,cursor);
        const j = await slReq(token, 'search.messages', { query, count: page.pageSize, page: page.page });
        const meta = slackSearchMeta(j,page);
        const items = searchItems(j.messages.matches,page,'ts').map(m => ({ user: m.username || m.user, channel: m.channel?.name, text: String(m.text || '').slice(0,800), text_truncated: String(m.text || '').length > 800, ts: m.ts, link: m.permalink }));
        return pages.result(page,items,meta);
      },
    },
    {
      name: 'slack_list_channels',
      description: 'Lists the Slack channels (public and private) the user can see. Returns the name and id of each channel.',
      parameters: { type: 'object', properties: { max: { type: 'integer', description: 'Default 50.' } } },
      async run({ max = 50 }) {
        const j = await slReq(token, 'conversations.list', { types: 'public_channel,private_channel', limit: Math.min(max, 200), exclude_archived: 'true' });
        const out = (j.channels || []).map((c) => ({ id: c.id, name: c.name, is_private: c.is_private, members: c.num_members }));
        return out.length ? JSON.stringify(out) : 'Nenhum canal.';
      },
    },
    {
      name: 'slack_history',
      description: 'Reads the recent messages of a Slack channel by id (use slack_list_channels to find the id).',
      parameters: { type: 'object', properties: { channel: { type: 'string', description: 'Channel id (e.g. C012AB3CD).' }, max: { type: 'integer', description: 'Default 15.' } }, required: ['channel'] },
      async run({ channel, max = 15 }) {
        const j = await slReq(token, 'conversations.history', { channel, limit: Math.min(max, 50) });
        const out = (j.messages || []).map((m) => ({ user: m.user, text: (m.text || '').slice(0, 800), ts: m.ts })).reverse();
        return out.length ? JSON.stringify(out) : 'Sem mensagens.';
      },
    },
    {
      name: 'slack_list_users',
      description: 'Lists the members of the Slack workspace (name and id), to resolve who is who in the messages.',
      parameters: { type: 'object', properties: { max: { type: 'integer', description: 'Default 100.' } } },
      async run({ max = 100 }) {
        const j = await slReq(token, 'users.list', { limit: Math.min(max, 200) });
        const out = (j.members || []).filter((u) => !u.deleted && !u.is_bot).map((u) => ({ id: u.id, name: u.real_name || u.name, handle: u.name }));
        return out.length ? JSON.stringify(out) : 'Nenhum usuário.';
      },
    },
    {
      name: 'slack_post_message',
      description: 'Sends a message to a Slack channel or DM, on behalf of the user. For a CHANNEL, pass the channel id (C..., see slack_list_channels). For a DM, pass the USER id (U..., see slack_list_users) — the tool opens the DM by itself. For yourself, pass channel="me". NEVER make up a channel/DM id. ALWAYS confirm the destination and the text with the user BEFORE sending; do not send without their explicit ok.',
      parameters: { type: 'object', properties: { channel: { type: 'string', description: 'Channel id (C...), user id for a DM (U...), or "me" for oneself. Never make one up.' }, text: { type: 'string' } }, required: ['channel', 'text'] },
      async run({ channel, text }) {
        let ch = String(channel || '').trim();
        // "me"/"eu"/"self" -> resolves to the user themselves (token owner).
        if (/^(me|self|eu|mim)$/i.test(ch)) {
          const who = await slReq(token, 'auth.test', {});
          ch = who.user_id;
        }
        // User id (U.../W...) -> opens the DM and uses the returned channel (D...).
        if (/^[UW][A-Z0-9]{6,}$/.test(ch)) {
          const dm = await slReq(token, 'conversations.open', { users: ch }, true);
          ch = dm.channel?.id || ch;
        }
        const j = await slReq(token, 'chat.postMessage', { channel: ch, text }, true);
        return JSON.stringify({ ok: true, channel: j.channel, ts: j.ts, note: 'Mensagem enviada.' });
      },
    },
  ];
}

// ── Microsoft Graph (Hotmail / Outlook.com) ──
const GRAPH = 'https://graph.microsoft.com/v1.0';

async function msReq(token, path, { method = 'GET', body, headers, redirect } = {}) {
  const r = await fetch(GRAPH + path, {
    method, ...(redirect ? { redirect } : {}),
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 202 || r.status === 204) return { httpStatus: r.status, requestId: r.headers?.get('request-id') || null };
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// ── OneDrive (Microsoft Graph /me/drive) ──
// Delegated scope `Files.ReadWrite`: reaches THE PERSON's drive (the least
// privileged one that works). Whoever connected Outlook before this scope
// existed keeps the old token, so EVERY tool here checks the stored `scope`
// before calling the API and asks for reconnection instead of blowing up with
// an opaque 403.
const FILES_SCOPE_RE = /Files\.(ReadWrite|Read)(\.All)?/i;
// null/'' = old connection with no `scope` field stored: there's no way to state
// anything, lets the API decide. With the field, the response is deterministic.
export const microsoftHasFiles = (scope) => scope == null || scope === '' || FILES_SCOPE_RE.test(String(scope));
export const RECONECTAR_MSG ='A conexão Microsoft desta pessoa foi feita ANTES de o OneDrive existir aqui, então o token dela não tem permissão de arquivos. Diga a ela pra reconectar em Conexões > Hotmail/Outlook (clicar em conectar de novo; e-mail e agenda continuam funcionando igual). Sem essa reconexão não dá pra ler nem subir arquivo no OneDrive.';

// GET of BYTES from Graph (content download). /content responds with a 302 to a
// pre-authenticated download host (*.sharepoint.com on a work account,
// *.files.1drv.com on a personal account); fetch follows the redirect on its own
// and the token does NOT travel to the second host (the URL is already signed).
async function msGetBytes(token, path) {
  const r = await fetch(GRAPH + path, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return Buffer.from(await r.arrayBuffer());
}

const driveItemBrief = (i) => ({
  id: i.id,
  nome: i.name,
  tipo: i.folder ? 'pasta' : (i.file?.mimeType || 'arquivo'),
  tamanho: i.size,
  modificado: i.lastModifiedDateTime,
  link: i.webUrl,
});

// File/folder name accepted by OneDrive (the same ones forbidden by Windows).
const odSafeName = (s, fallback = 'arquivo') =>
  String(s ?? '').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || fallback;

// Ensures the assistant's folder at the root of OneDrive and returns its id. Same
// policy as Google Drive: everything the assistant saves falls into a single
// folder, never loose at the root nor inside the person's folders. Here the
// folder is found by PATH (Graph has no appProperties), so renaming the folder
// makes the assistant create another one — that's the price of not having its
// own marker.
export async function ensureOneDriveFolder(token, folderName = marca().nome) {
  const name = odSafeName(folderName, marca().nome);
  try {
    const found = await msReq(token, `/me/drive/root:/${encodeURIComponent(name)}?$select=id,name,folder`);
    if (found?.id && found.folder) return found.id;
  } catch { /* 404 = doesn't exist yet */ }
  try {
    const created = await msReq(token, '/me/drive/root/children', {
      method: 'POST',
      body: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
    });
    return created.id;
  } catch (e) {
    // 409 = someone created it between the GET and the POST (or a FILE with that
    // name already exists): re-reads to return the right id instead of failing
    // the write.
    const again = await msReq(token, `/me/drive/root:/${encodeURIComponent(name)}?$select=id,name,folder`);
    if (again?.id) return again.id;
    throw e;
  }
}

// Uploads a file to OneDrive via SIMPLE upload (PUT .../content), which works up
// to 250 MB; above that Graph requires a chunked upload session, which we don't
// implement — better to refuse with a notice than to throw a raw error.
// Repeated name REPLACES the content of the file already there (the link doesn't
// change), same as Google's uploadBinaryToDrive: it's what makes "update the same
// spreadsheet" work without generating a new copy every time.
const OD_SIMPLE_MAX = 250 * 1024 * 1024;
export async function uploadToOneDrive({ token, name, buffer, mimeType = 'application/octet-stream', folderId = null }) {
  const safe = odSafeName(name);
  if (buffer.length > OD_SIMPLE_MAX) {
    throw new Error(`Arquivo de ${(buffer.length / 1024 / 1024).toFixed(1)} MB: o envio direto pro OneDrive vai até 250 MB.`);
  }
  const base = folderId ? `/me/drive/items/${encodeURIComponent(folderId)}:` : '/me/drive/root:';
  const itemPath = `${base}/${encodeURIComponent(safe)}`;
  let existed = false;
  try {
    const prev = await msReq(token, `${itemPath}?$select=id`);
    existed = !!prev?.id;
  } catch { /* doesn't exist yet */ }
  const r = await fetch(`${GRAPH}${itemPath}:/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${await token()}`, 'content-type': mimeType },
    body: buffer,
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  const f = await r.json();
  return { id: f.id, name: f.name, link: f.webUrl, size: f.size, updated: existed };
}

// ── Outlook Calendar (Microsoft Graph /me/events) ──
const DEFAULT_TZ = 'America/Sao_Paulo';
// Builds Graph's start/end object. Accepts ISO ("2026-08-12T15:00") and sends the
// timezone along; Graph interprets the time in that timezone (avoids the bug of
// falling back to UTC). Normalizes to full RFC3339 (same reason as Google's
// calTime): the model sometimes sends only HH:MM and Graph rejects/misinterprets
// it without seconds.
const gRfc3339 = (v) => {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return s;
  const [, Y, Mo, D, h, mi, se, frac, off] = m;
  return `${Y}-${Mo}-${D}T${h.padStart(2, '0')}:${mi}:${se || '00'}${frac || ''}${off || ''}`;
};
const gWhen = (iso, tz) => ({ dateTime: gRfc3339(iso), timeZone: tz || DEFAULT_TZ });
const recipients = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean)
  .map((address) => ({ emailAddress: { address } }));

const eventBrief = (e) => ({
  id: e.id,
  serie_id: e.seriesMasterId || undefined,
  tipo: e.type || undefined,
  titulo: e.subject,
  inicio: e.start?.dateTime,
  fim: e.end?.dateTime,
  fuso: e.start?.timeZone,
  dia_inteiro: e.isAllDay || undefined,
  local: e.location?.displayName || undefined,
  online: e.isOnlineMeeting || undefined,
  link_online: e.onlineMeeting?.joinUrl || undefined,
  organizador: e.organizer?.emailAddress?.address || undefined,
  convidados: (e.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean),
  status: e.responseStatus?.response || undefined,
});

// ── Outlook calendars ──────────────────────────────────────────────────────
// Same gap as Google's (audit 2026-09-04): `/me/calendarView` only reads the
// mailbox's DEFAULT calendar, so whoever separates work and personal into two
// calendars got half an answer and the tool didn't even know what was missing.
// Here calendars start being discovered. No new scope: Calendars.ReadWrite already
// covers the whole mailbox.
// (Editing/deleting still goes through /me/events/{id}: in Graph the event id is
// unique across the mailbox, no need to know the calendar. Only creation needs
// to choose.)
const msSemAcento = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

async function msListCalendars(token) {
  try {
    const j = await msReq(token, '/me/calendars?$select=id,name,isDefaultCalendar,canEdit&$top=50');
    const items = (j.value || []).filter((c) => c.id).map((c) => ({
      id: c.id, nome: c.name || c.id, principal: !!c.isDefaultCalendar, editavel: c.canEdit !== false,
    }));
    if (items.length) return items;
  } catch { /* cai no fallback */ }
  return [];
}

function msPickCalendars(cals, agenda) {
  const q = msSemAcento(agenda);
  if (!q) return cals;
  if (q === 'todas' || q === 'all') return cals;
  if (q === 'principal' || q === 'padrao') {
    const p = cals.filter((c) => c.principal);
    if (p.length) return p;
  }
  const exato = cals.filter((c) => c.id === agenda || msSemAcento(c.nome) === q);
  if (exato.length) return exato;
  return cals.filter((c) => msSemAcento(c.nome).includes(q) || q.includes(msSemAcento(c.nome)));
}

const mailBrief = (m) => ({
  id: m.id,
  link: m.webLink || '',
  assunto: m.subject,
  de: m.from?.emailAddress?.address || m.sender?.emailAddress?.address,
  nome: m.from?.emailAddress?.name,
  data: m.receivedDateTime,
  lido: m.isRead,
  anexos: m.hasAttachments,
  previa: (m.bodyPreview || '').slice(0, 300),
});

export function microsoftTools({ token, scopes = null, folderName = marca().nome, onSheetLoad = null, onUsage = () => {} }) {
  // `scopes` = what Microsoft actually granted on this connection (stored in the
  // token). null = we don't know (old connection without the field): lets it
  // through and the API's error sorts it out. With the field, the response is
  // deterministic and explains what to do, without spending a call.
  const semArquivos = () => !microsoftHasFiles(scopes);
  // Same read pipeline as Google Drive: PDF text and, if the PDF is scanned
  // (no text layer), OCR by vision. Vision usage is billed, which is why it
  // goes through onUsage.
  const lerPdf = async (buf, nome, mime) => {
    let text = '', pages, truncated;
    try { ({ text, pages, truncated } = await extractPdfText(buf, { maxChars: 20000 })); }
    catch (e) { console.error('[onedrive] extractPdfText erro:', e?.message ?? e); }
    if (text) return JSON.stringify({ nome, mimeType: mime, pages, truncated, text });
    try {
      const { text: ocr, usage } = await ocrPdf(buf);
      if (usage) onUsage({ usage, kind: 'vision' });
      if (ocr) return JSON.stringify({ nome, mimeType: mime, ocr: true, text: ocr });
    } catch (e) { console.error('[onedrive] ocrPdf falhou:', e?.message ?? e); }
    return JSON.stringify({ nome, mimeType: mime, note: 'PDF sem texto extraível (escaneado); o OCR também não conseguiu ler.' });
  };
  // Download ceiling on reads: above this it doesn't make sense to pull the
  // whole file into the turn (and the response would be truncated anyway).
  const OD_READ_MAX = 25 * 1024 * 1024;
  const ODSELECT = 'id,name,size,lastModifiedDateTime,webUrl,file,folder';
  const drivePages = searchPagination({ defaultMax: 10, cap: 25 });
  const pages = emailPagination({ defaultMax: 15, cap: 30 });
  return [
    {
      name: 'hotmail_search',
      description: 'Searches emails in the user\'s Hotmail/Outlook account. With "q" it searches by text (subject/body/sender); without "q" it brings the most recent ones from the inbox. Returns messages (id, subject, sender, date, preview), has_more and next_cursor. ' + EMAIL_PAGINATION_RULE,
      parameters: { type: 'object', properties: { q: { type: 'string', description: 'Text to search for (optional).' }, max: { type: 'integer', minimum: 1, description: 'Page size: default 15, capped at 30.' }, cursor: emailCursorSchema } },
      async run({ q = '', max, cursor } = {}) {
        const page = pages.request(q, max, cursor);
        const top = page.pageSize;
        const collection = q ? '/me/messages' : '/me/mailFolders/inbox/messages';
        const select = 'id,subject,from,sender,receivedDateTime,bodyPreview,isRead,hasAttachments,webLink';
        let path;
        if (q) {
          // $search doesn't combine with $orderby in Graph.
          path = `/me/messages?$search="${encodeURIComponent(q)}"&$top=${top}&$select=${select}`;
        } else {
          path = `/me/mailFolders/inbox/messages?$orderby=receivedDateTime%20desc&$top=${top}&$select=${select}`;
        }
        if (page.position) path = graphEmailNextPath(page.position, collection);
        const j = await msReq(token, path, { redirect: 'error' });
        if (!j || !Array.isArray(j.value) || j.value.length > page.pageSize) throw new Error('Resposta de busca Microsoft inválida ou acima do limite; não considere ausência de e-mail.');
        const next = j['@odata.nextLink'];
        if (next != null) graphEmailNextPath(next, collection);
        const out = j.value.map(mailBrief);
        return pages.result(page, out, next);
      },
    },
    {
      name: 'hotmail_read',
      description: 'Reads a Hotmail/Outlook email by id (use hotmail_search to find the id). Returns subject, sender, recipients and the email body.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        const select = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,hasAttachments,webLink';
        const m = await msReq(token, `/me/messages/${encodeURIComponent(id)}?$select=${select}`);
        const content = limitEmailBody(normalizeEmailBody(m.body?.content || m.bodyPreview || '',m.body?.contentType || 'text'));
        const addrs = (arr) => (arr || []).map((x) => x.emailAddress?.address).filter(Boolean);
        return JSON.stringify({
          id: m.id,
          link: m.webLink || '',
          assunto: m.subject,
          de: m.from?.emailAddress?.address,
          para: addrs(m.toRecipients),
          cc: addrs(m.ccRecipients),
          data: m.receivedDateTime,
          anexos: m.hasAttachments,
          corpo: content.body,
          truncated: content.truncated, chars: content.chars, links: content.links, links_truncated: content.links_truncated,
        });
      },
    },
    {
      name: 'hotmail_send',
      description: 'Sends an email through the user\'s Hotmail/Outlook account. ALWAYS confirm recipient, subject and body with the user BEFORE sending; do not send without their explicit ok.',
      parameters: { type: 'object', properties: { to: { type: 'string', description: 'Recipient(s), comma-separated.' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string', description: 'CC (optional), comma-separated.' } }, required: ['to', 'subject', 'body'] },
      async run({ to, subject, body, cc }) {
        const rec = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }));
        const message = { subject, body: { contentType: 'Text', content: body }, toRecipients: rec(to) };
        const ccList = rec(cc);
        if (ccList.length) message.ccRecipients = ccList;
        const receipt = await msReq(token, '/me/sendMail', { method: 'POST', body: { message, saveToSentItems: true } });
        return JSON.stringify({ ok: true, to, httpStatus: receipt.httpStatus, requestId: receipt.requestId,
          note: 'Pedido aceito pelo Outlook; processamento e entrega não confirmados.' });
      },
    },
    {
      name: 'outlook_calendar_list',
      description: 'Lists the events of the user\'s Outlook calendars in a period. Without dates, brings the next 7 days. By default it reads ALL the calendars in their mailbox (personal, work), not only the default one; each event comes with the `agenda` field saying which one it came from. Pass `agenda` to restrict to a single one. Returns id, title, start, end, location, organizer and attendees. Use to see the calendar, find a free slot or get an event id to edit/delete.',
      parameters: { type: 'object', properties: { inicio: { type: 'string', description: 'Start of the window, ISO (e.g. 2026-08-12T00:00:00). Default: now.' }, fim: { type: 'string', description: 'End of the window, ISO. Default: 7 days ahead.' }, fuso: { type: 'string', description: `IANA timezone (default ${DEFAULT_TZ}).` }, max: { type: 'integer', description: 'Max number of events (default 25, cap 50).' }, agenda: { type: 'string', description: 'OPTIONAL. Name of ONE calendar, when the owner asked only for it. Omit to read all (the normal case).' } } },
      async run({ inicio, fim, fuso, max = 25, agenda } = {}) {
        const tz = fuso || DEFAULT_TZ;
        const {from:startISO,to:endISO}=calendarWindow({inicio,fim,fuso:tz,days:7});
        if (!Number.isSafeInteger(max) || max<1) throw Error('max deve ser um inteiro positivo.');
        const top = Math.min(max, 50);
        const select = 'id,subject,start,end,location,isAllDay,isOnlineMeeting,onlineMeeting,organizer,attendees,responseStatus,seriesMasterId,type';
        const qs = `startDateTime=${encodeURIComponent(startISO)}&endDateTime=${encodeURIComponent(endISO)}`
          + `&$orderby=start/dateTime&$top=${top}&$select=${select}`;
        // Prefer makes Graph return times already converted to the requested timezone.
        const opts = { headers: { Prefer: `outlook.timezone="${tz}"` } };
        const cals = await msListCalendars(token);
        // Without discovered calendars (old permission, Graph error), keeps the
        // previous behavior: the default mailbox. Half an answer is better than
        // none, but the owner sees in `cobertura` that only the default one was read.
        if (!cals.length) {
          const j = await msReq(token, `/me/calendarView?${qs}`, opts);
          const out = (j.value || []).map(eventBrief);
          return JSON.stringify({partial:true,cobertura:{agendas_lidas:['padrão'],nota:'Só a agenda padrão pôde ser consultada.'},periodo:{inicio:startISO,fim:endISO},eventos:out});
        }
        const alvos = msPickCalendars(cals, agenda);
        if (!alvos.length) {
          return JSON.stringify({ erro: `Não achei agenda com o nome "${agenda}".`, agendas_disponiveis: cals.map((c) => c.nome) });
        }
        const lidas = alvos.slice(0, 8);
        const falhas = [];
        const incompletas = [];
        const listas = await Promise.all(lidas.map(async (c) => {
          try {
            const j = await msReq(token, `/me/calendars/${encodeURIComponent(c.id)}/calendarView?${qs}`, opts);
            if (j['@odata.nextLink']) incompletas.push(c.nome);
            return (j.value || []).map((e) => ({ ...eventBrief(e), agenda: c.nome }));
          } catch {
            // A broken calendar doesn't bring down the response, but it doesn't
            // disappear silently either.
            falhas.push(c.nome);
            return [];
          }
        }));
        // Sorting by text here is safe: the Prefer header makes Graph return
        // ALL calendars already in the same timezone, so the ISO offset doesn't vary.
        const todos = listas.flat().sort((a, b) => String(a.inicio || '').localeCompare(String(b.inicio || '')));
        const out = todos.slice(0, top);
        const cobertura = {
          periodo:{inicio:startISO,fim:endISO},
          partial:!!(incompletas.length || falhas.length || alvos.length>lidas.length || todos.length>out.length),
          ...(incompletas.length ? {agendas_com_mais_paginas:incompletas} : {}),
          agendas_lidas: lidas.map((c) => c.nome),
          ...(alvos.length > lidas.length ? { agendas_nao_lidas: alvos.slice(8).map((c) => c.nome) } : {}),
          ...(falhas.length ? { agendas_com_erro: falhas } : {}),
          // Same as Google: with several calendars the ceiling gets split and the
          // list might stop in the middle of the window. Stating this avoids
          // "there's nothing" about what didn't come in.
          ...(todos.length > out.length ? {
            corte: `Couberam só os ${out.length} eventos mais próximos (${todos.length - out.length} ficaram de fora). A lista cobre até ${out[out.length - 1]?.inicio || '?'}, e NÃO diz nada sobre o resto da janela: peça um período menor, uma agenda só, ou um max maior.`,
          } : {}),
        };
        if (!out.length) return JSON.stringify({ nota: 'Nenhum evento na agenda do Outlook nesse período.', ...cobertura });
        return JSON.stringify({ ...cobertura, eventos: out });
      },
    },
    {
      name: 'outlook_calendar_create',
      description: 'For a recurring request, fill in recorrencia and confirm the cadence and the end; never silently replace it with a single event. Creates an event in the user\'s Outlook calendar. Provide title, start and end (ISO, e.g. 2026-08-12T15:00:00). Confirm the details with the user BEFORE creating. You can add location, description and attendees; attendees receive an invitation from Microsoft.',
      parameters: { type: 'object', properties: {
        recorrencia: recurrenceSchema,
        titulo: { type: 'string' },
        inicio: { type: 'string', description: 'Start ISO (e.g. 2026-08-12T15:00:00).' },
        fim: { type: 'string', description: 'End ISO. If omitted, 1 hour after the start.' },
        fuso: { type: 'string', description: `IANA timezone (default ${DEFAULT_TZ}).` },
        local: { type: 'string' },
        descricao: { type: 'string' },
        convidados: { type: 'string', description: 'Comma-separated emails (optional).' },
        online: { type: 'boolean', description: 'If true, creates an online meeting (Teams).' },
        agenda: { type: 'string', description: 'OPTIONAL. Name of the calendar to create it in, when it is not the default one (use the name that came in outlook_calendar_list).' },
      }, required: ['titulo', 'inicio'] },
      async run({ titulo, inicio, fim, fuso, local, descricao, convidados, online, agenda, recorrencia }) {
        let repeat;
        try { repeat = calendarRecurrence(recorrencia, inicio, fuso); }
        catch (e) { return JSON.stringify({ ok: false, error: e.message }); }
        const tz = fuso || DEFAULT_TZ;
        const endISO = fim || (repeat ? recurrenceDefaultEnd(inicio) : new Date(new Date(inicio).getTime() + 3600e3).toISOString().slice(0, 19));
        const ev = { subject: titulo, start: gWhen(inicio, tz), end: gWhen(endISO, tz) };
        if (repeat) ev.recurrence = repeat.outlook;
        if (local) ev.location = { displayName: local };
        if (descricao) ev.body = { contentType: 'Text', content: descricao };
        const att = recipients(convidados);
        if (att.length) ev.attendees = att.map((a) => ({ ...a, type: 'required' }));
        if (online) { ev.isOnlineMeeting = true; ev.onlineMeetingProvider = 'teamsForBusiness'; }
        // Without `agenda`, /me/events falls back to the default one (usual behavior).
        let alvo = null;
        if (agenda) {
          const cals = await msListCalendars(token);
          const achadas = msPickCalendars(cals, agenda).filter((c) => c.editavel);
          if (!achadas.length) return JSON.stringify({ ok: false, error: `Não achei agenda do Outlook onde eu possa criar com o nome "${agenda}". Você tem: ${cals.map((c) => c.nome).join(', ')}.` });
          if (achadas.length > 1) return JSON.stringify({ ok: false, error: `"${agenda}" casou com mais de uma agenda (${achadas.map((c) => c.nome).join(', ')}). Diga qual.` });
          alvo = achadas[0];
        }
        const path = alvo ? `/me/calendars/${encodeURIComponent(alvo.id)}/events` : '/me/events';
        const created = await msReq(token, path, { method: 'POST', body: ev });
        return JSON.stringify({ ok: true, agenda: alvo?.nome || 'padrão', evento: eventBrief(created) });
      },
    },
    {
      name: 'outlook_calendar_update',
      description: 'Edits an existing Outlook calendar event (by id, obtained from outlook_calendar_list). Only send the fields you want to change. Confirm with the user BEFORE editing.',
      parameters: { type: 'object', properties: {
        id: { type: 'string' },
        titulo: { type: 'string' },
        inicio: { type: 'string', description: 'New start ISO.' },
        fim: { type: 'string', description: 'New end ISO.' },
        fuso: { type: 'string', description: `IANA timezone (default ${DEFAULT_TZ}).` },
        local: { type: 'string' },
        descricao: { type: 'string' },
        convidados: { type: 'string', description: 'Replaces the attendee list (comma-separated emails).' },
      }, required: ['id'] },
      async run({ id, titulo, inicio, fim, fuso, local, descricao, convidados }) {
        const tz = fuso || DEFAULT_TZ;
        const patch = {};
        if (titulo != null) patch.subject = titulo;
        if (inicio != null) patch.start = gWhen(inicio, tz);
        if (fim != null) patch.end = gWhen(fim, tz);
        if (local != null) patch.location = { displayName: local };
        if (descricao != null) patch.body = { contentType: 'Text', content: descricao };
        if (convidados != null) patch.attendees = recipients(convidados).map((a) => ({ ...a, type: 'required' }));
        if (!Object.keys(patch).length) return 'Nada pra atualizar: informe ao menos um campo além do id.';
        const upd = await msReq(token, `/me/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
        return JSON.stringify({ ok: true, evento: eventBrief(upd) });
      },
    },
    {
      name: 'outlook_calendar_delete',
      description: 'Deletes an Outlook calendar event by id (obtained from outlook_calendar_list). IRREVERSIBLE action: confirm with the user BEFORE deleting. If the event has attendees, they may receive the cancellation.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        await msReq(token, `/me/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return JSON.stringify({ ok: true, deletedId: id, note: 'Evento apagado da agenda do Outlook.' });
      },
    },
    {
      name: 'onedrive_search',
      description: 'Searches files/folders in OneDrive by name/content. Without query, lists the root. Returns items with id, name, type, size, date and link; use onedrive_read to read. ' + SEARCH_PAGINATION_RULE,
      parameters: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'integer', minimum: 1, description: 'Page: default 10, maximum 25.' }, cursor: searchCursorSchema } },
      async run({ query = '', max, cursor } = {}) {
        if (semArquivos()) return RECONECTAR_MSG;
        const page = drivePages.request(query,max,cursor);
        const q = query.trim();
        const collection = q ? `/me/drive/root/search(q='${encodeURIComponent(q.replace(/'/g,"''"))}')` : '/me/drive/root/children';
        const path = page.position || `${collection}?$top=${page.pageSize}&$select=${ODSELECT}${q ? '' : '&$orderby=lastModifiedDateTime%20desc'}`;
        const j = await msReq(token,path,{ redirect: 'error' });
        const items = searchItems(j?.value,page,'id').map(driveItemBrief);
        const next = j['@odata.nextLink'] == null ? null : graphSearchNextPath(j['@odata.nextLink'],collection);
        return drivePages.result(page,items,{ next });
      },
    },
    {
      name: 'onedrive_read',
      description: 'Reads the content of a OneDrive file by id (obtained from onedrive_search): PDF, Word (.docx), PowerPoint (.pptx), image (extracts the text) and text/JSON/Markdown files. A SPREADSHEET (Excel or CSV) is opened in the analysis environment and only the structure comes back (sheets, columns, rows), never the cells: for any question about the data use analisar_planilha. For other binary formats it returns only the metadata.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run({ id }) {
        if (semArquivos()) return RECONECTAR_MSG;
        const item = encodeURIComponent(id);
        const meta = await msReq(token, `/me/drive/items/${item}?$select=${ODSELECT}`);
        if (meta.folder) {
          return JSON.stringify({ ...driveItemBrief(meta), note: 'Isso é uma PASTA, não um arquivo. Use onedrive_search pra achar o arquivo dentro dela.' });
        }
        const nome = meta.name || '';
        const mime = meta.file?.mimeType || '';
        if (Number(meta.size) > OD_READ_MAX) {
          return JSON.stringify({ ...driveItemBrief(meta), note: `Arquivo de ${(Number(meta.size) / 1024 / 1024).toFixed(1)} MB: grande demais pra eu ler inteiro aqui (teto 25 MB).` });
        }
        if (mime === 'application/pdf' || /\.pdf$/i.test(nome)) {
          return await lerPdf(await msGetBytes(token, `/me/drive/items/${item}/content`), nome, mime || 'application/pdf');
        }
        if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|tiff?|bmp)$/i.test(nome)) {
          const buf = await msGetBytes(token, `/me/drive/items/${item}/content`);
          try {
            const { text, usage } = await describeImage(buf, mime || 'image/jpeg', 'Extraia TODO o texto legível desta imagem em português do Brasil.');
            if (usage) onUsage({ usage, kind: 'vision' });
            if (text) return JSON.stringify({ nome, mimeType: mime, ocr: true, text });
          } catch (e) { console.error('[onedrive] describeImage falhou:', e?.message ?? e); }
          return JSON.stringify({ nome, mimeType: mime, note: 'Imagem sem texto legível.' });
        }
        // Spreadsheet (Excel, CSV): goes to the analysis environment and the
        // result only carries the structure, never the cells (see planilha.mjs).
        if (tipoPlanilha(nome, mime)) {
          const buf = await msGetBytes(token, `/me/drive/items/${item}/content`);
          return JSON.stringify({ nome, mimeType: mime, analise: await analisePlanilhaConector(onSheetLoad, buf, nome || 'planilha.xlsx', mime) });
        }
        // Word/PowerPoint: Graph converts the file to PDF on the fly
        // (?format=pdf) and the text comes out through the same extractor from
        // there. It's the equivalent of Google Docs' export.
        if (/wordprocessingml|presentationml|msword|ms-powerpoint/i.test(mime) || /\.(docx?|pptx?)$/i.test(nome)) {
          const buf = await msGetBytes(token, `/me/drive/items/${item}/content?format=pdf`);
          return await lerPdf(buf, nome, mime || 'application/pdf');
        }
        if (mime.startsWith('text/') || /^application\/(json|xml)/i.test(mime) || /\.(txt|md|json|xml|log|ya?ml)$/i.test(nome)) {
          const buf = await msGetBytes(token, `/me/drive/items/${item}/content`);
          // A large text file came out silently truncated, unlike the PDF and
          // the spreadsheet right above, which already say `truncated`.
          const arq = recortar(buf.toString('utf8'), 12000, 'arquivo');
          return JSON.stringify({ nome, mimeType: mime, text: arq.corpo, truncated: arq.truncado || undefined });
        }
        return JSON.stringify({ ...driveItemBrief(meta), note: 'Formato binário; não consigo ler o conteúdo como texto.' });
      },
    },
    {
      name: 'onedrive_upload',
      description: `Creates or updates a TEXT file (txt, md, csv, json, html) in the user's OneDrive, always inside the assistant's folder ("${folderName}") at the root. For a BINARY file (PDF, image, spreadsheet) use onedrive_upload_arquivo. UPDATE AT THE SAME LINK: repeating the name of a file that is already in the folder rewrites its content and the link stays the same; only change the name when the user really wants a separate file. Confirm name and content first.`,
      parameters: { type: 'object', properties: {
        nome: { type: 'string', description: 'File name (e.g. notas.txt).' },
        conteudo: { type: 'string', description: 'Text content.' },
        mimeType: { type: 'string', description: 'File MIME type (default text/plain).' },
      }, required: ['nome', 'conteudo'] },
      async run({ nome, conteudo, mimeType = 'text/plain' }) {
        if (semArquivos()) return JSON.stringify({ ok: false, error: RECONECTAR_MSG });
        // GUARD against "undefined": content that didn't arrive (arg cut off in a
        // long generation) must NEVER become a file, otherwise OneDrive ends up
        // with the literal string "undefined" (the same bug drive_upload already blocks).
        if (conteudo == null || String(conteudo).trim() === '' || String(conteudo).trim() === 'undefined') {
          return JSON.stringify({ ok: false, error: 'Não recebi o conteúdo do arquivo (veio vazio/undefined). Não gravei nada. Se o texto for longo, ele pode ter sido cortado na chamada: reenvie, quebre em partes menores, ou salve num arquivo do sandbox e use onedrive_upload_arquivo.' });
        }
        const folderId = await ensureOneDriveFolder(token, folderName);
        const f = await uploadToOneDrive({
          token, name: nome, buffer: Buffer.from(String(conteudo), 'utf8'),
          mimeType: `${mimeType}; charset=utf-8`, folderId,
        });
        return JSON.stringify({
          ok: true, id: f.id, nome: f.name, link: f.link, atualizado: f.updated,
          note: f.updated
            ? `Já existia um "${f.name}" na pasta "${folderName}" do OneDrive: atualizei o conteúdo DELE. O link é o mesmo de antes.`
            : `Arquivo criado no OneDrive, na pasta "${folderName}".`,
        });
      },
    },
  ].filter(tool => microsoftToolAllowed(tool.name, scopes));
}

// ── Nuvemshop / Tiendanube (read-only for now) ──
// Per-store API: https://api.nuvemshop.com.br/v1/{store_id}/... with header
// Authentication: bearer <token> and a REQUIRED User-Agent.
const NUV = 'https://api.nuvemshop.com.br/v1';

async function nuvReq(storeId, token, path) {
  const r = await fetch(`${NUV}/${storeId}${path}`, {
    headers: {
      Authentication: `bearer ${await token()}`,
      'User-Agent': uaApi({ comContato: true }),
      'Content-Type': 'application/json',
    },
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const money = (v) => (v == null ? undefined : String(v));
const nameOf = (n) => (n && typeof n === 'object' ? n.pt || n.es || n.en || Object.values(n)[0] : n);

const productBrief = (p) => ({
  id: p.id,
  nome: nameOf(p.name),
  publicado: p.published,
  variantes: (p.variants || []).map((v) => ({
    id: v.id,
    sku: v.sku,
    preco: money(v.price),
    promocional: money(v.promotional_price),
    estoque: v.stock == null ? 'ilimitado' : v.stock,
    valores: (v.values || []).map((x) => nameOf(x)).filter(Boolean),
  })),
  url: p.canonical_url || p.permalink || undefined,
});

const orderBrief = (o) => ({
  id: o.id,
  numero: o.number,
  status: o.status,
  pagamento: o.payment_status,
  envio: o.shipping_status,
  total: money(o.total),
  moeda: o.currency,
  cliente: o.customer?.name,
  itens: (o.products || []).length,
  criado: o.created_at,
});

// Pages through ALL orders in a window (no truncation). The store report's bug
// (suppressed days) came from pulling only the 1st page in descending order and
// summing in the model: above 200 orders/month the oldest days vanished silently.
// Here we sweep page by page in ASCENDING order until exhausted, with a safety
// ceiling.
async function nuvFetchOrders(storeId, token, { desde, ate, status, payment_status, maxPages = 80 } = {}) {
  const orders = [];
  let truncado = false;
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({ per_page: '200', page: String(page), sort_by: 'created-at-ascending' });
    if (desde) params.set('created_at_min', desde);
    if (ate) params.set('created_at_max', `${ate}T23:59:59`);
    if (status) params.set('status', status);
    if (payment_status) params.set('payment_status', payment_status);
    let batch;
    try {
      batch = await nuvReq(storeId, token, `/orders?${params.toString()}`);
    } catch (e) {
      // A page past the end returns 404 in some versions: treated as the end, not an error.
      if (String(e?.message || '').startsWith('404')) break;
      throw e;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    orders.push(...batch);
    if (batch.length < 200) break; // last page
    if (page === maxPages) truncado = true; // bateu o teto: pode faltar
  }
  return { orders, truncado };
}

export function nuvemshopTools({ token, storeId }) {
  return [
    {
      name: 'nuvemshop_loja',
      description: 'Shows the data of the connected Nuvemshop store (name, email, currency, plan, country).',
      parameters: { type: 'object', properties: {} },
      async run() {
        const s = await nuvReq(storeId, token, '/store');
        return JSON.stringify({
          id: s.id, nome: nameOf(s.name), email: s.email, moeda: s.main_currency,
          idioma: s.main_language, pais: s.country, plano: s.plan_name, url: nameOf(s.url),
        });
      },
    },
    {
      name: 'nuvemshop_produtos',
      description: 'Lists the products in the store catalog, with price and stock of each variant. Use to see the catalog and the stock situation. Accepts text search (q).',
      parameters: { type: 'object', properties: { q: { type: 'string', description: 'Filter by name (optional).' }, max: { type: 'integer', description: 'Default 30 (max 200).' } } },
      async run({ q, max = 30 } = {}) {
        const params = new URLSearchParams({ per_page: String(Math.min(max, 200)), page: '1', fields: 'id,name,published,variants,canonical_url,permalink' });
        if (q) params.set('q', q);
        const j = await nuvReq(storeId, token, `/products?${params.toString()}`);
        const out = (Array.isArray(j) ? j : []).map(productBrief);
        return out.length ? JSON.stringify(out) : 'Nenhum produto encontrado.';
      },
    },
    {
      name: 'nuvemshop_produto',
      description: 'Details a specific store product by id, with all variants, prices and stock. Use to check the stock of an item.',
      parameters: { type: 'object', properties: { id: { type: 'integer', description: 'Product id.' } }, required: ['id'] },
      async run({ id }) {
        const p = await nuvReq(storeId, token, `/products/${id}`);
        return JSON.stringify({ ...productBrief(p), descricao: (nameOf(p.description) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800) });
      },
    },
    {
      name: 'nuvemshop_pedidos',
      description: 'LISTS the store orders (sales), from most recent to oldest, with payment/shipping status and amount. Use to SEE recent or individual orders. Filters by status (open, closed, cancelled), payment (paid, pending...) and date (desde/ate, ISO YYYY-MM-DD). Do NOT use it to sum the total/revenue of a period: this list is partial (only the most recent ones) and summing gives a wrong number; for that use nuvemshop_resumo_vendas.',
      parameters: { type: 'object', properties: { status: { type: 'string' }, payment_status: { type: 'string' }, desde: { type: 'string', description: 'Minimum creation date, ISO (e.g. 2026-07-01).' }, ate: { type: 'string', description: 'Maximum creation date, ISO (includes the whole day).' }, max: { type: 'integer', description: 'Default 30 (max 200).' } } },
      async run({ status, payment_status, desde, ate, max = 30 } = {}) {
        const per = Math.min(max, 200);
        const params = new URLSearchParams({ per_page: String(per), page: '1', sort_by: 'created-at-descending' });
        if (status) params.set('status', status);
        if (payment_status) params.set('payment_status', payment_status);
        if (desde) params.set('created_at_min', desde);
        if (ate) params.set('created_at_max', `${ate}T23:59:59`);
        const j = await nuvReq(storeId, token, `/orders?${params.toString()}`);
        const arr = Array.isArray(j) ? j : [];
        const out = arr.map(orderBrief);
        if (!out.length) return 'Nenhum pedido encontrado.';
        // If it came back full up to the ceiling, there MAY be more orders in the
        // period — never hide this (it was the cause of the report with missing
        // days). Warns and points to the summary, which pages through everything
        // and sums it in code.
        if (arr.length >= per) {
          return JSON.stringify({ truncado: true, vieram: out.length, aviso: `Listagem PARCIAL (só os ${out.length} mais recentes). Para total/faturamento de um período use nuvemshop_resumo_vendas (pagina tudo e soma no código).`, pedidos: out });
        }
        return JSON.stringify(out);
      },
    },
    {
      name: 'nuvemshop_resumo_vendas',
      description: 'Store SALES SUMMARY for a period, with the numbers summed IN CODE (deterministic, the model sums nothing). Pages through ALL the orders in the period (does not truncate) and returns revenue, number of orders, average ticket, breakdown by payment status and by day. ALWAYS use it when the request is a sales total/report for a period (e.g. "quanto vendi em agosto", "faturamento da semana", "vendas por dia no mês"). desde/ate in ISO YYYY-MM-DD (ate includes the whole day).',
      parameters: { type: 'object', properties: {
        desde: { type: 'string', description: 'Start date ISO YYYY-MM-DD (inclusive).' },
        ate: { type: 'string', description: 'End date ISO YYYY-MM-DD (inclusive). Default: today.' },
        payment_status: { type: 'string', description: 'Optional: restricts to one payment status (paid, pending...).' },
      }, required: ['desde'] },
      async run({ desde, ate, payment_status } = {}) {
        const hoje = new Date().toISOString().slice(0, 10);
        const ini = desde;
        const fim = ate || hoje;
        const { orders, truncado } = await nuvFetchOrders(storeId, token, { desde: ini, ate: fim, payment_status });
        // Window filter in CODE (source of truth, robust to the API's timezone):
        // compares only the YYYY-MM-DD part of created_at (already comes in the
        // store's timezone).
        const inWin = orders.filter((o) => {
          const d = String(o.created_at || '').slice(0, 10);
          return d && d >= ini && d <= fim;
        });
        const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
        const round2 = (n) => Math.round(n * 100) / 100;
        const soma = (arr) => round2(arr.reduce((s, o) => s + num(o.total), 0));
        const naoCancel = inWin.filter((o) => o.status !== 'cancelled');
        const pagos = inWin.filter((o) => o.payment_status === 'paid');
        // Per day (base = non-cancelled orders).
        const porDiaMap = {};
        for (const o of naoCancel) {
          const d = String(o.created_at).slice(0, 10);
          (porDiaMap[d] ||= { dia: d, pedidos: 0, faturamento: 0 });
          porDiaMap[d].pedidos++; porDiaMap[d].faturamento += num(o.total);
        }
        const por_dia = Object.values(porDiaMap)
          .sort((a, b) => a.dia.localeCompare(b.dia))
          .map((x) => ({ ...x, faturamento: round2(x.faturamento) }));
        // Per payment status (base = all orders in the window).
        const por_status_pagamento = {};
        for (const o of inWin) {
          const k = o.payment_status || 'sem_status';
          (por_status_pagamento[k] ||= { pedidos: 0, faturamento: 0 });
          por_status_pagamento[k].pedidos++; por_status_pagamento[k].faturamento += num(o.total);
        }
        for (const k of Object.keys(por_status_pagamento)) por_status_pagamento[k].faturamento = round2(por_status_pagamento[k].faturamento);
        const bruto = soma(naoCancel);
        const moeda = inWin[0]?.currency || naoCancel[0]?.currency;
        return JSON.stringify({
          periodo: { desde: ini, ate: fim },
          moeda,
          pedidos_no_periodo: inWin.length,
          pedidos_considerados: naoCancel.length,
          cancelados: inWin.length - naoCancel.length,
          faturamento_bruto: bruto,          // all from the period, except cancelled
          faturamento_pago: soma(pagos),     // only payment_status = paid
          ticket_medio: naoCancel.length ? round2(bruto / naoCancel.length) : 0,
          por_status_pagamento,
          por_dia,
          premissa: 'faturamento_bruto = todos os pedidos do período exceto cancelados; faturamento_pago = só os pagos. Dia = data de criação (created_at) no fuso da loja.',
          ...(truncado ? { truncado: true, aviso: 'Volume muito alto: atingiu o teto de páginas; o total pode estar incompleto.' } : {}),
        });
      },
    },
    {
      name: 'nuvemshop_pedido',
      description: 'Details a specific order by id, with purchased items, customer, shipping address and amounts.',
      parameters: { type: 'object', properties: { id: { type: 'integer', description: 'Order id.' } }, required: ['id'] },
      async run({ id }) {
        const o = await nuvReq(storeId, token, `/orders/${id}`);
        return JSON.stringify({
          ...orderBrief(o),
          contato: { email: o.contact_email, telefone: o.contact_phone },
          entrega: o.shipping_address ? { cidade: o.shipping_address.city, estado: o.shipping_address.province, cep: o.shipping_address.zipcode } : undefined,
          produtos: (o.products || []).map((p) => ({ nome: nameOf(p.name), qtd: p.quantity, preco: money(p.price), sku: p.sku })),
        });
      },
    },
  ];
}

// ── LinkedIn (user token; post to the member's own profile) ──
// Scopes: openid profile (identity -> author URN) + w_member_social (write).
// author URN comes from the connect step (meta.member_urn); if missing, resolves
// it on the fly.
// NOTE: LinkedIn's API for a regular app ONLY grants identity (userinfo) + posting
// a share to one's own profile (ugcPosts). Commenting and reading engagement/
// statistics fall into 403 ACCESS_DENIED at /v2/socialActions (requires LinkedIn's
// Community Management API product, which only ships with partner approval).
// There's also no reading of feed/messages/connections for a regular app. That's
// why we only expose me + post: offering comment/stats made the model try and
// fail, looking broken.
const LI = 'https://api.linkedin.com';

async function liReq(token, path, { method = 'GET', body, headers } = {}) {
  const r = await fetch(LI + path, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      'X-Restli-Protocol-Version': '2.0.0',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${r.status}: ${txt.slice(0, 300)}`);
  const json = txt ? JSON.parse(txt) : {};
  // The id of the created post usually comes only in the header, not in the body.
  return { json, restliId: r.headers.get('x-restli-id') || r.headers.get('x-linkedin-id') || null };
}

export function linkedinTools({ token, memberUrn }) {
  // Resolves the author URN: uses the one from connect or fetches it on the fly
  // via /userinfo|/me.
  let cached = memberUrn || null;
  async function author() {
    if (cached) return cached;
    const who = await linkedinIdentity(await token());
    if (!who) throw new Error('Não consegui descobrir seu id de membro no LinkedIn. O app precisa do escopo de identidade (openid+profile, produto "Sign In with LinkedIn using OpenID Connect", ou r_liteprofile). Sem isso não dá pra postar/comentar em seu nome.');
    cached = who.urn;
    return cached;
  }
  return [
    {
      name: 'linkedin_me',
      description: 'Confirms the LinkedIn connection and returns your name and member id (author URN). Use to check that the connection is up before posting.',
      parameters: { type: 'object', properties: {} },
      async run() {
        const who = await linkedinIdentity(await token());
        if (!who) return 'Conectado, mas sem escopo de identidade (openid/profile ou r_liteprofile) — não dá pra postar/comentar em seu nome.';
        return JSON.stringify({ urn: who.urn, name: who.name });
      },
    },
    {
      name: 'linkedin_post',
      description: 'Publishes a text post on your LinkedIn profile (optionally with a link). ALWAYS confirm the exact text with the user BEFORE publishing; do not post without their explicit ok. Returns the id/URN of the created post.',
      parameters: { type: 'object', properties: { text: { type: 'string', description: 'Post text.' }, link: { type: 'string', description: 'Optional URL to attach to the post.' }, visibility: { type: 'string', description: 'PUBLIC (default) or CONNECTIONS.' } }, required: ['text'] },
      async run({ text, link, visibility = 'PUBLIC' }) {
        const vis = visibility === 'CONNECTIONS' ? 'CONNECTIONS' : 'PUBLIC';
        const share = { shareCommentary: { text }, shareMediaCategory: 'NONE' };
        if (link) {
          share.shareMediaCategory = 'ARTICLE';
          share.media = [{ status: 'READY', originalUrl: link }];
        }
        const body = {
          author: await author(),
          lifecycleState: 'PUBLISHED',
          specificContent: { 'com.linkedin.ugc.ShareContent': share },
          visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': vis },
        };
        const { json, restliId } = await liReq(token, '/v2/ugcPosts', { method: 'POST', body });
        const id = restliId || json.id || null;
        return JSON.stringify({ ok: true, id, note: 'Post publicado.' });
      },
    },
  ];
}
