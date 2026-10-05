import test from 'node:test';
import assert from 'node:assert/strict';
import { notionTools } from './web/connectors-vault.mjs';
import { githubTools } from './web/connectors-ext.mjs';

// Leitura parcial que não se declara é o pior tipo de bug de leitura: o modelo
// resume "a página" ou "a issue" tendo visto só o começo, e ninguém percebe.
// Aqui a rede é falsa (fetch trocado), então nada sai do processo.

const comFetch = async (handler, fn) => {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = orig; }
};
const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const tool = (tools, nome) => tools.find((t) => t.name === nome);

const bloco = (txt) => ({ type: 'paragraph', paragraph: { rich_text: [{ plain_text: txt }] } });

test('notion: página com mais de 100 blocos é lida até o fim, não só a primeira leva', async () => {
  const chamadas = [];
  const tools = notionTools({ secret: async () => 'tok' });
  const out = await comFetch(async (url) => {
    chamadas.push(String(url));
    if (String(url).includes('/pages/')) return json({ id: 'p1', url: 'http://n/p1', properties: {} });
    const n = chamadas.filter((u) => u.includes('/children')).length;
    return json({ results: [bloco(`linha da leva ${n}`)], has_more: n < 3, next_cursor: n < 3 ? `c${n}` : null });
  }, () => tool(tools, 'notion_read_page').run({ id: 'p1' }));
  const r = JSON.parse(out);
  assert.match(r.conteudo, /leva 1/);
  assert.match(r.conteudo, /leva 3/, 'parou na primeira leva de blocos');
  assert.equal(r.blocosOmitidos, undefined);
  assert.equal(r.clipped, false);
  assert.ok(chamadas.some((u) => u.includes('start_cursor=c1')), 'não seguiu o cursor');
});

test('notion: página gigante para no teto e DIZ que a leitura foi parcial', async () => {
  const tools = notionTools({ secret: async () => 'tok' });
  const out = await comFetch(async (url) => {
    if (String(url).includes('/pages/')) return json({ id: 'p1', url: 'http://n/p1', properties: {} });
    return json({ results: [bloco('mais uma linha')], has_more: true, next_cursor: 'sempre' });
  }, () => tool(tools, 'notion_read_page').run({ id: 'p1' }));
  const r = JSON.parse(out);
  assert.equal(r.blocosOmitidos, true);
  assert.match(r.nota, /parcial/i);
});

test('github: issue com mais comentários do que a página lida declara quantos ficaram de fora', async () => {
  const tools = githubTools({ token: async () => 'tok' });
  const out = await comFetch(async (url) => {
    if (String(url).includes('/comments')) {
      return json(Array.from({ length: 20 }, (_, i) => ({ user: { login: 'u' }, body: `c${i}` })));
    }
    return json({ number: 7, title: 'bug', state: 'open', user: { login: 'a' }, body: 'corpo', comments: 57, html_url: 'http://gh/7' });
  }, () => tool(tools, 'github_read_issue').run({ owner: 'o', repo: 'r', number: 7 }));
  const r = JSON.parse(out);
  assert.equal(r.commentsTotal, 57);
  assert.equal(r.comments.length, 20);
  assert.equal(r.commentsOmitidos, 37);
  assert.match(r.nota, /37/);
});

test('github: issue curta não ganha aviso nenhum', async () => {
  const tools = githubTools({ token: async () => 'tok' });
  const out = await comFetch(async (url) => {
    if (String(url).includes('/comments')) return json([{ user: { login: 'u' }, body: 'ok' }]);
    return json({ number: 8, title: 't', state: 'closed', user: { login: 'a' }, body: 'curto', comments: 1, html_url: 'http://gh/8' });
  }, () => tool(tools, 'github_read_issue').run({ owner: 'o', repo: 'r', number: 8 }));
  const r = JSON.parse(out);
  assert.equal(r.commentsOmitidos, undefined);
  assert.equal(r.nota, undefined);
  assert.equal(r.bodyTruncated, undefined);
});
