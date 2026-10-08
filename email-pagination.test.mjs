// Strictly offline DRY-RUN: no real credential, server, DB, or channel.
// Sockets and child processes blocked BEFORE importing the product modules.
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
const forbidden = () => { throw new Error('I/O REAL PROIBIDO NO DRY-RUN'); };
net.Socket.prototype.connect = forbidden; tls.connect = forbidden;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = forbidden;
syncBuiltinESMExports();
globalThis.fetch = forbidden;
const { googleTools } = await import('./web/connectors.mjs');
const { microsoftTools } = await import('./web/connectors-ext.mjs');
const { emailPagination, graphEmailNextPath, trackEmailPagination, EMAIL_PAGINATION_RULE } = await import('./web/email-pagination.mjs');
const { createEmailResearchSession } = await import('./web/email-research-session.mjs');
const { EMAIL_RESEARCH_CONTRACT } = await import('./web/email-answer-contract.mjs');
const { runAgent, ToolRegistry } = await import('./core-proto/core.mjs');
let checks = 0, queue = [], requests = [];
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const reject = async (fn, label) => { await assert.rejects(fn, undefined, label); checks++; };
const throws = (fn, label) => { assert.throws(fn, undefined, label); checks++; };
const gmail = () => googleTools({ token: async () => 'MOCK_ONLY', caps: { gmail: { read: true } } }).find(t => t.name === 'gmail_search');
const outlook = () => microsoftTools({ token: async () => 'MOCK_ONLY' }).find(t => t.name === 'hotmail_search');
const data = id => ({ id, snippet: 'Mensagem de teste sem destinatário real', payload: { headers: [{ name: 'Subject', value: id }] } });
const gmPage = (ids, next, estimate) => ({ messages: ids.map(id => ({ id })), ...(next ? { nextPageToken: next } : {}), ...(estimate === undefined ? {} : { resultSizeEstimate: estimate }) });
const mock = (...responses) => { assert.equal(queue.length, 0, 'previous responses consumed'); queue = responses; requests = []; };
globalThis.fetch = async (url, opts = {}) => {
 assert.equal(opts.method ?? 'GET', 'GET', 'only GET allowed');
 assert.equal(opts.headers.Authorization, 'Bearer MOCK_ONLY');
 const parsed = new URL(url);
 assert.ok(['gmail.googleapis.com', 'graph.microsoft.com'].includes(parsed.hostname));
 if (parsed.hostname === 'graph.microsoft.com') assert.equal(opts.redirect, 'error', 'redirects blocked');
 requests.push(String(url));
 assert.ok(queue.length, 'no unexpected call, repetition or real network');
 const entry = queue.shift();
 if (entry.error) return { ok: false, status: entry.error, text: async () => 'MOCK ERROR' };
 return { ok: true, status: 200, json: async () => entry };
};
// First page -> the sought email is only on the SECOND page.
const g = gmail();
mock(gmPage(['primeiro'], 'native+/token=', 42), data('primeiro'));
const first = JSON.parse(await g.run({ query: 'from:mock@example.invalid', max: 50 }));
check(first.has_more, 'Gmail signals more pages'); equal(first.returned, 1); equal(first.page_size, 10); equal(first.estimated_total, 42);
check(first.next_cursor && !first.next_cursor.includes('native'), 'opaque cursor'); check(first.note.includes('PARCIAL'));
equal(requests.length, 2, 'one page and metadata, no automatic search'); check(requests[0].includes('maxResults=10'));
mock(gmPage(['procurado']), data('procurado'));
const second = JSON.parse(await g.run({ query: first.query, cursor: first.next_cursor }));
equal(second.messages[0].id, 'procurado'); equal(second.page, 2); equal(second.has_more, false); equal(second.next_cursor, null);
equal(new URL(requests[0]).searchParams.get('pageToken'), 'native+/token=', 'encoded token without corruption');
equal(new URL(requests[0]).searchParams.get('q'), first.query); equal(new URL(requests[0]).searchParams.get('maxResults'), '10');
// Final empty vs. empty WITH continuation.
mock({ resultSizeEstimate: 0 }); const empty = JSON.parse(await g.run({ query: 'nenhum' })); equal(empty.messages, []); equal(empty.has_more, false); equal(empty.estimated_total, 0);
mock(gmPage([], 'skip-empty')); const emptyMore = JSON.parse(await g.run({ query: 'vazio-parcial' })); check(emptyMore.has_more); check(emptyMore.next_cursor); check(emptyMore.note.includes('PARCIAL'));
mock(gmPage([], 'skip-empty')); const repeated = JSON.parse(await g.run({ query: 'vazio-parcial', cursor: emptyMore.next_cursor })); check(repeated.has_more); equal(repeated.next_cursor, null); check(repeated.note.includes('repetiu'));
// Invalid values are rejected before any call.
for (const max of [0, -1, 1.5, null, '10', Infinity, NaN, {}, Number.MAX_SAFE_INTEGER + 1]) await reject(() => g.run({ query: 'x', max }), 'invalid max');
for (const query of [null, 3, [], 'x'.repeat(2049)]) await reject(() => g.run({ query }), 'invalid query');
for (const cursor of [null, '', 'inventado', 'https://evil.invalid', {}, 3]) await reject(() => g.run({ query: first.query, cursor }), 'invalid cursor');
await reject(() => g.run({ query: 'outra', cursor: first.next_cursor }));
await reject(() => g.run({ query: first.query, max: 3, cursor: first.next_cursor }));
await reject(() => gmail().run({ query: first.query, cursor: first.next_cursor }), 'cursor does not cross account/instance');
for (const bad of [{ messages: {} }, { messages: [null] }, { messages: [{ id: null }] }, [], null]) {
 mock(bad); await reject(() => g.run({ query: 'bad' }), 'invalid Gmail response');
}
mock(gmPage(Array.from({ length: 6 }, (_, i) => String(i)))); await reject(() => g.run({ query: 'big' }), 'metadata limit'); equal(requests.length, 1);
mock({ error: 401 }); await reject(() => g.run({ query: 'erro' }));
mock(gmPage(['x']), { error: 404 }); await reject(() => g.run({ query: 'erro-metadata' }), 'an error turns into no e-mail');
// Outlook follows the WHOLE nextLink, exactly as received, only on the safe list.
const m = outlook();
const link = 'https://graph.microsoft.com/v1.0/me/messages?$search=%22mock%22&$top=30&$skiptoken=a%2Bb%3D&$select=id,subject';
mock({ value: [{ id: 'ms1', subject: 'um' }], '@odata.nextLink': link });
const mf = JSON.parse(await m.run({ q: 'mock', max: 100 })); check(mf.has_more); equal(mf.page_size, 30); check(mf.next_cursor); check(!JSON.stringify(mf).includes('graph.microsoft.com'));
mock({ value: [{ id: 'ms-alvo', subject: 'procurado' }] });
const ms = JSON.parse(await m.run({ q: 'mock', cursor: mf.next_cursor })); equal(requests[0], link, 'nextLink intact'); equal(ms.messages[0].id, 'ms-alvo'); equal(ms.has_more, false); equal(ms.page, 2);
const inboxLink = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=15';
mock({ value: [], '@odata.nextLink': inboxLink }); const inbox = JSON.parse(await m.run()); check(inbox.has_more); check(requests[0].includes('/mailFolders/inbox/messages?'));
mock({ value: [] }); const inboxEnd = JSON.parse(await m.run({ cursor: inbox.next_cursor })); equal(inboxEnd.has_more, false); equal(requests[0], inboxLink);
await reject(() => m.run({ q: 'outra', cursor: mf.next_cursor })); await reject(() => outlook().run({ q: 'mock', cursor: mf.next_cursor }));
for (const bad of ['https://evil.invalid/v1.0/me/messages', 'http://graph.microsoft.com/v1.0/me/messages', 'https://graph.microsoft.com@evil.invalid/v1.0/me/messages', 'https://graph.microsoft.com/v1.0/users/other/messages', 'https://graph.microsoft.com/v1.0/me/messages/id', 'https://graph.microsoft.com/v1.0/me/messages#frag', 'https://graph.microsoft.com/v1.0/me/messages\n', 'https://graph.microsoft.com/v1.0/me/messages\\foo', 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages']) {
 throws(() => graphEmailNextPath(bad, '/me/messages'), 'unauthorized URL');
 mock({ value: [], '@odata.nextLink': bad }); await reject(() => m.run({ q: 'mock' }), 'does not emit an unsafe cursor'); equal(requests.length, 1, 'did not follow link');
}
for (const bad of [{}, { value: null }, { value: {} }, { value: Array(16).fill({ id: 'x' }) }]) { mock(bad); await reject(() => m.run(), 'invalid Graph/limit'); }
mock({ error: 429 }); await reject(() => m.run(), 'no automatic retry'); equal(requests.length, 1);
// TTL and memory limit, without timer or persistent storage.
let time = 0; const pages = emailPagination({ defaultMax: 5, cap: 10, now: () => time });
const req = pages.request('x'); const cursor = JSON.parse(pages.result(req, [], 'p')).next_cursor;
equal(pages.request('x', undefined, cursor).position, 'p'); time = 900000; throws(() => pages.request('x', undefined, cursor), 'expired TTL');
const old = JSON.parse(pages.result(req, [], 'old')).next_cursor;
for (let i = 0; i < 100; i++) pages.result(req, [], 'p' + i);
throws(() => pages.request('x', undefined, old), 'limited cache');
// Synthesis protection: it doesn't disappear on the worker -> main path.
let response = { query: 'x', has_more: true }; const fake = { name: 'gmail_search', run: async () => JSON.stringify(response) };
const tracker = trackEmailPagination([fake, { name: 'unrelated', run: async () => 'raw' }]);
await tracker.tools[0].run({}); check(tracker.finish('Não encontrei.').includes('AVISO DE BUSCA PARCIAL'));
response = { query: 'y', has_more: false }; await tracker.tools[0].run({}); check(tracker.finish('Resultado y').includes('AVISO'), 'another query does not clear the previous one');
response = { query: 'x', has_more: false }; await tracker.tools[0].run({}); check(tracker.finish('Tudo').startsWith('Tudo')); check(!tracker.finish('Tudo').includes('AVISO DE BUSCA PARCIAL')); equal(tracker.coverage().map(r=>r.status), ['complete','complete']); equal(await tracker.tools[1].run({}), 'raw');
// Dry-run of the REAL tool-loop and the real orchestration functions extracted from the
// file, without importing server.mjs (which would initialize database and channels).
const source = readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
function orchestration(name, provider) {
 const start = source.indexOf('async function ' + name + '('), end = source.indexOf('\n}\n', start) + 2;
 assert.ok(start >= 0 && end > start);
 const deps = { ToolRegistry, runAgent, makeSubagentProvider: () => provider, trackEmailPagination, createEmailResearchSession, EMAIL_RESEARCH_CONTRACT, comIdioma: s => s, GOOGLE_SUBAGENT_SYSTEM: EMAIL_PAGINATION_RULE };
 return new Function(...Object.keys(deps), source.slice(start, end) + '; return ' + name)(...Object.values(deps));
}
for (const [name, toolFactory, toolName, args] of [['runGoogleSubagent', gmail, 'gmail_search', { query: 'alvo' }], ['runConnectorSubagent', outlook, 'hotmail_search', { q: 'alvo' }]]) {
 for (const continuePage of [true, false]) {
  if (toolName === 'gmail_search') mock(gmPage(['um'], 'PAGE2'), data('um'), ...(continuePage ? [gmPage(['alvo']), data('alvo')] : []));
  else mock({ value: [{ id: 'um' }], '@odata.nextLink': link }, ...(continuePage ? [{ value: [{ id: 'alvo' }] }] : []));
  let step = 0;
  const provider = { name: 'offline-fake', complete: async ({ messages }) => {
   step++;
   if (step === 1) return { stop: 'tool', toolCalls: [{ id: 't1', name: toolName, args }] };
   const result = JSON.parse(messages.filter(x => x.role === 'tool').at(-1).content);
   if (step === 2) { check(result.has_more, 'LLM simulado recebeu aviso'); if (continuePage) return { stop: 'tool', toolCalls: [{ id: 't2', name: toolName, args: { ...args, cursor: result.next_cursor } }] }; }
   return { stop: 'end', text: continuePage ? 'Encontrado na segunda página: ' + result.messages[0].id : 'Síntese que omitiu a limitação.' };
  } };
  const result = await orchestration(name, provider)({ objetivo: 'Buscar alvo (simulado)', account:toolName==='gmail_search' ? 'mock@example.invalid' : undefined, readTools: [toolFactory()], system: EMAIL_PAGINATION_RULE });
  const bundle = JSON.parse(result.split('\n').find(line => line.startsWith('{')));
  equal(bundle.consulta.partial, !continuePage, "factual limitation survives the worker's omission");
  equal(bundle.consulta.status, 'sucesso_com_resultados', 'synthesis without JSON extraction does not turn a source into absence');
  equal(bundle.sources.map(row=>row.id), continuePage ? ['um','alvo'] : ['um']);
 }
}
equal(queue.length, 0); console.log(`OK: ${checks} verificações; dry-run com tool-loop real, Gmail/Outlook simulados, rede/processos bloqueados. Nenhuma mensagem ou dado real utilizado.`);
