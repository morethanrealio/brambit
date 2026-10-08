// "busca_email"-type routine: config/normalization, composition with curation,
// Gmail/Graph query, and paginated execution with fake fetch (no network, no DB).
import assert from 'node:assert/strict';
import {
  normalizeEmailSearchConfig, prepareEmailSearchChange, looksLikeEmailSearch,
  describeEmailSearch, editableEmailSearch, pruneEmailSearchTools,
} from './web/email-search-config.mjs';
import { prepareCurationChange } from './web/curation-config.mjs';
import {
  buildGmailQuery, buildGraphQuery, executeEmailSearch, emailSearchPromptBlock,
  emailSearchFailureBlock, describeEmailSearchTest,
} from './web/email-search-runtime.mjs';

globalThis.fetch = async () => { throw new Error('rede proibida no teste'); };

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok -', name); };
const throwsPt = (fn, re) => assert.throws(fn, (e) => { assert.match(e.message, re); return true; });

// ---- normalization ----
await test('normalize applies defaults and strips quotes/parentheses', () => {
  const c = normalizeEmailSearchConfig({ terms: ['quinto andar', '"docusign"', ' (x) '], senders: ['QuintoAndar.com.br'] });
  assert.deepEqual(c, { version: 1, provider: 'gmail', account: null, terms: ['quinto andar', 'docusign', 'x'], senders: ['quintoandar.com.br'], days: 2, unreadOnly: false, withAttachment: false });
});
await test('normalize rejects unknown key, invalid sender, days out of range, wrong provider', () => {
  throwsPt(() => normalizeEmailSearchConfig({ foo: 1 }), /campo desconhecido/);
  throwsPt(() => normalizeEmailSearchConfig({ senders: ['quinto andar'] }), /senders.*inválido/);
  throwsPt(() => normalizeEmailSearchConfig({ days: 0 }), /days/);
  throwsPt(() => normalizeEmailSearchConfig({ days: 31 }), /days/);
  throwsPt(() => normalizeEmailSearchConfig({ days: 1.5 }), /days/);
  throwsPt(() => normalizeEmailSearchConfig({ provider: 'yahoo' }), /provider/);
  throwsPt(() => normalizeEmailSearchConfig({ account: 'nao-e-email' }), /account/);
  throwsPt(() => normalizeEmailSearchConfig({ unreadOnly: 'sim' }), /unreadOnly/);
  throwsPt(() => normalizeEmailSearchConfig({ terms: Array.from({ length: 11 }, (_, i) => 't' + i) }), /no máximo 10/);
});
await test('normalize accepts a comma-separated string list and account', () => {
  const c = normalizeEmailSearchConfig({ terms: 'a, b;c', account: 'X@Y.com', provider: 'outlook', days: 7, unreadOnly: true });
  assert.deepEqual(c.terms, ['a', 'b', 'c']); assert.equal(c.account, 'x@y.com'); assert.equal(c.provider, 'outlook'); assert.equal(c.days, 7); assert.equal(c.unreadOnly, true);
});

// ---- heuristic ----
await test('looksLikeEmailSearch', () => {
  assert.equal(looksLikeEmailSearch('verifique meus e-mails do quinto andar e me resuma'), true);
  assert.equal(looksLikeEmailSearch('Busque no Gmail mensagens da QuintoAndar'), true);
  assert.equal(looksLikeEmailSearch('resuma minha agenda e meus e-mails'), false);
  assert.equal(looksLikeEmailSearch('me lembre de beber água'), false);
});

// ---- prepare ----
await test('prepare: typed creation stores normalized email_search', () => {
  const cfg = prepareEmailSearchChange(null, { tipo: 'busca_email', busca_email: { terms: ['quintoandar'], days: 1 }, prompt: 'resuma', channel: 'telegram' });
  assert.equal(cfg.email_search.version, 1); assert.deepEqual(cfg.email_search.terms, ['quintoandar']); assert.equal(cfg.email_search.days, 1);
});
await test('prepare: busca_email type without parameters / geral that looks like a search / invalid channel', () => {
  throwsPt(() => prepareEmailSearchChange(null, { tipo: 'busca_email', prompt: 'x', channel: 'telegram' }), /Faltam os parâmetros/);
  throwsPt(() => prepareEmailSearchChange(null, { tipo: 'geral', prompt: 'verifique meus e-mails do quinto andar e resuma', channel: 'telegram' }), /use tipo "busca_email"/);
  throwsPt(() => prepareEmailSearchChange(null, { tipo: 'busca_email', busca_email: { terms: ['a'] }, prompt: 'x', channel: 'sms' }), /Canal inválido/);
  throwsPt(() => prepareEmailSearchChange(null, { tipo: 'geral', busca_email: { terms: ['a'] }, prompt: 'x', channel: 'email' }), /só vale com tipo/);
  assert.equal(prepareEmailSearchChange(null, { tipo: 'geral', prompt: 'me lembre de beber água', channel: 'telegram' }), undefined);
  assert.equal(prepareEmailSearchChange(null, { prompt: 'qualquer', channel: 'telegram' }), undefined);
});
await test('prepare: editing a typed routine preserves the rest of the config and does not turn into geral/curadoria', () => {
  const row = { channel: 'telegram', config: { email_search: normalizeEmailSearchConfig({ terms: ['a'] }), execution: { x: 1 } } };
  const cfg = prepareEmailSearchChange(row, { busca_email: { terms: ['b'], days: 3 } });
  assert.deepEqual(cfg.email_search.terms, ['b']); assert.equal(cfg.email_search.days, 3); assert.deepEqual(cfg.execution, { x: 1 });
  throwsPt(() => prepareEmailSearchChange(row, { tipo: 'geral', prompt: 'outra coisa' }), /é uma busca de e-mail/);
  throwsPt(() => prepareEmailSearchChange(row, { tipo: 'curadoria' }), /não vira curadoria/);
  assert.equal(prepareEmailSearchChange(row, { prompt: 'novo texto' }), undefined); // prompt only: nothing changes in the config
  throwsPt(() => prepareEmailSearchChange(row, { channel: 'sms' }), /Canal inválido/);
});
await test('prepare: curadoria/monitor does not turn into an email search; and curation-config rejects the reverse', () => {
  const cur = { channel: 'email', config: { curation: { source: 'web' } } };
  throwsPt(() => prepareEmailSearchChange(cur, { busca_email: { terms: ['a'] } }), /não vira busca de e-mail/);
  throwsPt(() => prepareCurationChange(cur, { tipo: 'busca_email' }), /curadoria; não vira busca de e-mail/);
  throwsPt(() => prepareCurationChange(null, { tipo: 'busca_email', curadoria: { source: 'web' }, prompt: 'x', channel: 'email' }), /OU busca_email/);
  // busca_email type goes through curation without requiring criteria or triggering the curation heuristic
  assert.equal(prepareCurationChange(null, { tipo: 'busca_email', prompt: 'resuma as notícias e artigos de IA', channel: 'email' }), undefined);
});

// ---- descriptions / prune ----
await test('describe/editable/prune', () => {
  const c = normalizeEmailSearchConfig({ terms: ['quintoandar', 'quinto andar'], senders: ['quintoandar.com.br'], days: 2, unreadOnly: true, account: 'a@b.com' });
  const d = describeEmailSearch(c);
  assert.match(d, /Busca no Gmail \(conta a@b.com\)/); assert.match(d, /"quintoandar" ou "quinto andar"/); assert.match(d, /últimos 2 dias; só não lidos/);
  assert.equal('version' in editableEmailSearch(c), false); assert.deepEqual(editableEmailSearch(c).terms, c.terms);
  const reg = { map: new Map([['google', 1], ['memoria_ler', 1], ['pesquisar', 1], ['criar_rotina', 1]]) };
  pruneEmailSearchTools(reg);
  assert.deepEqual([...reg.map.keys()], ['memoria_ler']);
});

// ---- consultas ----
await test('buildGmailQuery', () => {
  assert.equal(buildGmailQuery(normalizeEmailSearchConfig({ terms: ['quintoandar', 'quinto andar'], senders: ['quintoandar.com.br', 'x@y.com'], days: 2, unreadOnly: true, withAttachment: true })),
    '(quintoandar OR "quinto andar") (from:quintoandar.com.br OR from:x@y.com) newer_than:2d is:unread has:attachment -from:me');
  assert.equal(buildGmailQuery(normalizeEmailSearchConfig({ terms: ['docusign'], days: 1 })), 'docusign newer_than:1d -from:me');
  assert.equal(buildGmailQuery(normalizeEmailSearchConfig({ days: 3 })), 'newer_than:3d -from:me');
});
await test('buildGraphQuery', () => {
  const since = new Date('2026-09-11T12:00:00Z');
  assert.deepEqual(buildGraphQuery(normalizeEmailSearchConfig({ terms: ['a', 'b c'], senders: ['d.com'], unreadOnly: true }), since), { mode: 'search', text: '(a OR "b c") AND from:d.com AND isRead:false AND received>=2026-09-11' });
  assert.deepEqual(buildGraphQuery(normalizeEmailSearchConfig({ withAttachment: true }), since), { mode: 'filter', text: 'receivedDateTime ge 2026-09-11T12:00:00.000Z and hasAttachments eq true' });
});

// ---- Gmail execution with fake fetch ----
const gmailFake = ({ perPage = 3, total = 7, failIds = [] } = {}) => {
  const calls = [];
  const ids = Array.from({ length: total }, (_, i) => 'm' + (i + 1));
  const msg = (id, full) => {
    const n = Number(id.slice(1));
    const payload = full
      ? { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: `QuintoAndar <no-reply@quintoandar.com.br>` }, { name: 'Subject', value: `Assunto ${n}` }, { name: 'Date', value: `Fri, 1${n % 10} Sep 2026 10:00:00 -0300` }],
          parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(`Corpo do e-mail ${n}`).toString('base64url') } }, { filename: `contrato${n}.pdf`, mimeType: 'application/pdf', body: { attachmentId: 'a' } }] }
      : { headers: [{ name: 'From', value: `QuintoAndar <no-reply@quintoandar.com.br>` }, { name: 'Subject', value: `Assunto ${n}` }, { name: 'Date', value: 'x' }] };
    return { id, internalDate: String(1000 + n), snippet: `trecho ${n}`, labelIds: n % 2 ? ['UNREAD', 'INBOX'] : ['INBOX'], payload };
  };
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization });
    const u = new URL(url);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    const m = u.pathname.match(/\/messages\/([^/]+)$/);
    if (m) {
      if (failIds.includes(m[1])) return { ok: false, status: 500, text: async () => 'boom' };
      return ok(msg(m[1], u.searchParams.get('format') === 'full'));
    }
    const page = Number(u.searchParams.get('pageToken') || 0);
    const size = Number(u.searchParams.get('maxResults'));
    const slice = ids.slice(page * size, (page + 1) * size);
    const j = { messages: slice.map((id) => ({ id })) };
    if ((page + 1) * size < ids.length) j.nextPageToken = String(page + 1);
    return ok(j);
  };
  return { fetchImpl, calls };
};

await test('executeEmailSearch Gmail: paginates to the end, body only on the first ones, sorts by date, complete', async () => {
  const { fetchImpl, calls } = gmailFake({ perPage: 3, total: 7 });
  const c = normalizeEmailSearchConfig({ terms: ['quintoandar'], days: 2 });
  const r = await executeEmailSearch(c, { fetchImpl, token: async () => 'TOK', page: 3, bodyLimit: 2 });
  assert.equal(r.provider, 'gmail'); assert.equal(r.query, 'quintoandar newer_than:2d -from:me');
  assert.equal(r.total, 7); assert.equal(r.pages, 3); assert.equal(r.truncated, false); assert.equal(r.partial, false); assert.deepEqual(r.errors, []);
  assert.equal(r.items[0].id, 'm7'); assert.equal(r.items[6].id, 'm1'); // most recent first
  const lists = calls.filter((x) => x.url.includes('/messages?q='));
  assert.equal(lists.length, 3); assert.ok(lists[0].url.includes('q=quintoandar%20newer_than%3A2d')); assert.ok(lists[1].url.includes('pageToken=1'));
  assert.ok(calls.every((x) => x.auth === 'Bearer TOK'));
  assert.equal(calls.filter((x) => x.url.includes('format=full')).length, 2);
  assert.equal(calls.filter((x) => x.url.includes('format=metadata')).length, 5);
  const full = r.items.find((m) => m.id === 'm1'); // idx 0 in listing order → body
  assert.equal(full.body, 'Corpo do e-mail 1'); assert.equal(full.link, 'https://mail.google.com/mail/#all/m1'); assert.deepEqual(full.attachments, ['contrato1.pdf']); assert.equal(full.unread, true); assert.equal(full.subject, 'Assunto 1');
  const meta = r.items.find((m) => m.id === 'm7'); assert.equal(meta.body, ''); assert.equal(meta.snippet, 'trecho 7');
});
await test('executeEmailSearch Gmail: cap cuts it off and marks truncated/partial', async () => {
  const { fetchImpl } = gmailFake({ total: 12 });
  const r = await executeEmailSearch(normalizeEmailSearchConfig({ days: 1 }), { fetchImpl, token: async () => 't', page: 5, cap: 8, bodyLimit: 0 });
  assert.equal(r.truncated, true); assert.equal(r.partial, true); assert.equal(r.total, 8); assert.equal(r.pages, 2);
});
await test('executeEmailSearch Gmail: a message that fails to open becomes an error + partial, without taking down the search', async () => {
  const { fetchImpl } = gmailFake({ total: 4, failIds: ['m2'] });
  const r = await executeEmailSearch(normalizeEmailSearchConfig({ days: 1 }), { fetchImpl, token: async () => 't', page: 10, bodyLimit: 0 });
  assert.equal(r.total, 3); assert.equal(r.errors.length, 1); assert.match(r.errors[0], /^m2: 500/); assert.equal(r.partial, true); assert.equal(r.truncated, false);
});
await test('executeEmailSearch: listing 401 throws (token/account) and requires token to be a function', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'invalid credentials' });
  await assert.rejects(executeEmailSearch(normalizeEmailSearchConfig({}), { fetchImpl, token: async () => 't' }), /401: invalid credentials/);
  await assert.rejects(executeEmailSearch(normalizeEmailSearchConfig({}), { fetchImpl, token: 'abc' }), /token deve ser função/);
});

// ---- Graph execution ----
await test('executeEmailSearch Outlook: $search without $orderby, $top<=25, nextLink, date filter, html-to-text body', async () => {
  const calls = [];
  const now = new Date('2026-09-13T12:00:00Z');
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => '' });
    if (url.includes('/me/messages/')) return ok({ body: { contentType: 'html', content: '<p>Olá <b>mundo</b></p><style>x{}</style>' }, attachments: [{ name: 'doc.pdf' }] });
    if (url.endsWith('&$skip=25')) return ok({ value: [{ id: 'o3', subject: 'S3', from: { emailAddress: { name: 'Ana', address: 'ana@x.com' } }, receivedDateTime: '2026-09-12T09:00:00Z', bodyPreview: 'p3', isRead: false }] });
    return ok({ value: [
      { id: 'o1', subject: 'S1', from: { emailAddress: { name: 'Bia', address: 'bia@x.com' } }, receivedDateTime: '2026-09-13T09:00:00Z', bodyPreview: 'p1', isRead: true },
      { id: 'velho', subject: 'fora da janela', receivedDateTime: '2026-09-01T09:00:00Z', bodyPreview: 'p', isRead: false },
    ], '@odata.nextLink': url + '&$skip=25' });
  };
  const c = normalizeEmailSearchConfig({ provider: 'outlook', terms: ['contrato'], days: 2 });
  const r = await executeEmailSearch(c, { fetchImpl, token: async () => 'MS', page: 50, bodyLimit: 1, now });
  assert.equal(r.provider, 'outlook'); assert.equal(r.pages, 2); assert.equal(r.total, 2); assert.equal(r.truncated, false);
  assert.deepEqual(r.items.map((m) => m.id), ['o1', 'o3']);
  assert.match(r.query, /^\$search=contrato AND received>=2026-09-11$/);
  const first = calls[0].url;
  assert.ok(first.includes('$search=') && first.includes('$top=25') && !first.includes('$orderby'));
  assert.equal(r.items[0].body, 'Olá mundo'); assert.deepEqual(r.items[0].attachments, ['doc.pdf']); assert.equal(r.items[0].unread, false);
  assert.equal(r.items[1].body, ''); assert.equal(r.items[1].unread, true); assert.equal(r.items[1].from, 'Ana <ana@x.com>');
  assert.equal(calls.find((x) => x.url.includes('/me/messages/'))?.headers.Prefer, 'outlook.body-content-type="text"');
});
await test('executeEmailSearch Outlook: without terms uses $filter + $orderby', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' }; };
  const r = await executeEmailSearch(normalizeEmailSearchConfig({ provider: 'outlook', unreadOnly: true }), { fetchImpl, token: async () => 'MS', bodyLimit: 0 });
  assert.equal(r.total, 0); assert.ok(calls[0].includes('$filter=') && calls[0].includes('$orderby=receivedDateTime%20desc') && !calls[0].includes('$search'));
  assert.match(r.query, /^\$filter=receivedDateTime ge .* and isRead eq false$/);
});

// ---- prompt blocks ----
await test('emailSearchPromptBlock: full list vs cut, empty sends a one-sentence warning (never silence)', async () => {
  const { fetchImpl } = gmailFake({ total: 2 });
  const c = normalizeEmailSearchConfig({ terms: ['quintoandar'], days: 2, account: 'me@g.com' });
  const r = await executeEmailSearch(c, { fetchImpl, token: async () => 't', bodyLimit: 1 });
  const b = emailSearchPromptBlock(c, r);
  assert.ok(b.startsWith('[BUSCA DE E-MAIL EXECUTADA PELA PLATAFORMA]'));
  assert.match(b, /Gmail \(account me@g.com\) with the exact query: quintoandar newer_than:2d -from:me/);
  assert.match(b, /   Link: https:\/\/mail\.google\.com\/mail\/#all\/m2/);
  assert.match(b, /Result: 2 emails \(complete list, paginated to the end\)/);
  assert.match(b, /do NOT redo the search/); assert.match(b, /1\. From: QuintoAndar <no-reply@quintoandar.com.br> \| Subject: Assunto 2/); assert.match(b, /Body: Corpo do e-mail 1/);
  assert.match(b, /NEVER reply \[ROTINA_SEM_NOVIDADES\]/); assert.ok(b.endsWith('--- FIM DOS E-MAILS ---'));
  const empty = emailSearchPromptBlock(c, { ...r, total: 0, items: [], truncated: false, errors: [] });
  assert.match(empty, /list is EMPTY/); assert.match(empty, /NEVER reply \[ROTINA_SEM_NOVIDADES\]/); assert.match(empty, /found no email/); assert.match(empty, /\(none\)/);
  const cut = emailSearchPromptBlock(c, { ...r, truncated: true, errors: ['m9: 500'] });
  assert.match(cut, /list cut at the cap of 200/); assert.match(cut, /1 message\(s\) did not open/);
  const f = emailSearchFailureBlock(c, new Error('401: invalid credentials'));
  assert.ok(f.startsWith('[BUSCA DE E-MAIL FALHOU]')); assert.match(f, /401: invalid credentials/); assert.match(f, /reconnect it under Connections/);
  assert.match(describeEmailSearchTest(r), /^Testei agora: 2 e-mails nos últimos 2 dias\. Exemplos: "Assunto 2" de QuintoAndar/);
  assert.match(describeEmailSearchTest({ ...r, total: 0, items: [] }), /nenhum e-mail.*vai rodar mesmo assim/);
});

console.log(`\n${passed} testes ok`);
