// Public support events: what a plugin records with track() and the clicks on
// measured links. Real database (PGlite); only the model is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

process.env.VAULT_KEY = randomBytes(32).toString('base64');
const { createPublicoStore, createAtendimentoPublico } = await import('../web/extensions/public-support/public-support.mjs');
const { createEventsStore } = await import('../web/extensions/public-support/public-support-events.mjs');

const TZ = 'America/Sao_Paulo';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

async function setup(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);
    CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY, user_id uuid REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
      name text, instructions text, profile text, summary text, archived_at timestamptz);
    CREATE TABLE mtr_harness.usage_events(id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), agent_id uuid, kind text, cost_usd numeric(12,6));`);
  const owner = randomUUID(), ag = randomUUID();
  await db.query('INSERT INTO mtr_harness.users VALUES ($1)', [owner]);
  await db.query(`INSERT INTO mtr_harness.agents VALUES ($1,$2,'Lia','','','',null)`, [ag, owner]);
  let queue = Promise.resolve();
  const query = (sql, v) => v ? db.query(sql, v) : db.exec(sql);
  const pool = { query, async connect() { const before = queue; let free; queue = new Promise((r) => { free = r; }); await before; return { query, release: free }; } };
  const store = createPublicoStore(pool); await store.init();
  await store.configurar(ag, owner, { ativo: true, retencaoDias: 30 });
  const events = createEventsStore(pool, { timezone: TZ, log: { error() {} } });
  return { db, store, events, ag };
}

const model = () => ({ name: 'fake', async complete() { return { stop: 'end', text: 'ok', usage: { in: 1, out: 1 } }; } });

test('the plugin records events in the turn; cards count them and follow people through a funnel in order', async (t) => {
  const { store, events, ag } = await setup(t);
  // Each message carries the steps this contact does in that turn.
  const ganchos = { antesDoModelo: async (ctx) => { for (const s of ctx.mensagem.split(' ')) if (s !== '-') await ctx.track(...s.split('=')); return null; },
    metricCards: async ({ events: e }) => {
      const shown = await e.count({ kind: 'shown', refPrefix: 'product:' });
      const [a, b, c] = await e.funnel([{ kind: 'scan_click' }, { kind: 'scan_result' }, { kind: 'shown' }]);
      return [{ label: 'shown', value: `${shown.times}/${shown.people}` }, { label: 'funnel', value: `${a}>${b}>${c}` }];
    } };
  const a = createAtendimentoPublico({ store, makeProvider: model, recordUsage: async () => {}, saldo: async () => ({ over: false }),
    ganchos, events, log: { error() {}, info() {} } });
  const say = (who, msg) => a.turno({ agentId: ag, canal: 'web', endereco: who, mensagem: msg });
  await say('ana', 'scan_click');
  await say('ana', 'scan_result shown=product:1 shown=product:2');
  await say('bia', 'scan_click scan_result');
  await say('caio', 'shown=product:3');
  await say('caio', 'scan_result');   // result without a click: not in the funnel
  await say('dani', 'Bad-Kind=x');   // ignored, the turn goes on
  const cards = await a.metricCards({ agentId: ag, days: 7, from: today(), to: today() });
  assert.deepEqual(cards, [{ label: 'shown', value: '3/2' }, { label: 'funnel', value: '2>2>1' }]);
  // Another period sees nothing.
  assert.deepEqual(await events.count(ag, { from: '2020-01-01', to: '2020-01-31' }, { kind: 'shown' }), { times: 0, people: 0 });
});

test('events go with the conversation, the contact and retention, and are in the contact export', async (t) => {
  const { db, store, events, ag } = await setup(t);
  const c1 = (await store.contato(ag, 'web', 'ana')).id, c2 = (await store.contato(ag, 'web', 'bia')).id, c3 = (await store.contato(ag, 'web', 'caio')).id;
  for (const c of [c1, c2, c3]) {
    await events.record({ agentId: ag, contactId: c, kind: 'bag_add', ref: 'product:9' });
    await events.linkId({ agentId: ag, contactId: c, url: 'https://shop.example/p/9', ref: 'product:9' });
  }
  assert.deepEqual((await store.exportar(c1)).events.map((e) => [e.kind, e.ref]), [['bag_add', 'product:9']]);
  assert.deepEqual((await store.exportar(c1)).links.map((l) => l.url), ['https://shop.example/p/9']);
  const left = async (c) => [(await db.query(`SELECT count(*)::int n FROM mtr_harness.public_support_events WHERE contact_id = $1`, [c])).rows[0].n,
    (await db.query(`SELECT count(*)::int n FROM mtr_harness.public_support_links WHERE contact_id = $1`, [c])).rows[0].n];
  await store.apagarConversa(c1);
  assert.deepEqual(await left(c1), [0, 0]);
  await store.apagarContato(c2);
  assert.deepEqual(await left(c2), [0, 0]);
  await db.query(`UPDATE mtr_harness.public_support_events SET at = now() - interval '31 days'`);
  await db.query(`UPDATE mtr_harness.public_support_links SET created_at = now() - interval '31 days'`);
  const r = await store.limparVencidos();
  assert.deepEqual([r.events, r.links, await left(c3)], [1, 1, [0, 0]]);
});

test('link buttons go out measured: the click is recorded once, previews and HEAD are not, the conversation keeps the real address', async (t) => {
  const { db, store, events, ag } = await setup(t);
  const { createRotas } = await import('../web/routes.mjs');
  const { registerClickRoute, CLICK_PATH } = await import('../web/extensions/public-support/public-support-events.mjs');
  const { createPublicWebStore } = await import('../web/extensions/public-support/public-web.mjs');
  const { measureLinks } = await import('../web/extensions/public-support/public-support-events.mjs');
  const shop = 'https://shop.example/p/9?utm=x';
  const ganchos = { antesDoModelo: async () => ({ pular: true, saidas: [{ tipo: 'texto', texto: 'oi' }, { tipo: 'botao', texto: 'Veja', rotulo: 'Ver', url: shop, ref: 'product:9' }] }) };
  const a = createAtendimentoPublico({ store, makeProvider: model, recordUsage: async () => {}, saldo: async () => ({ over: false }),
    ganchos, events, linkBase: () => 'https://bot.example/', log: { error() {}, info() {} } });
  // The web chat keeps the real url (the page styles a link by its address) and opens clickUrl.
  const r1 = await a.turno({ agentId: ag, canal: 'web', endereco: 'api:ana', mensagem: 'oi' });
  const r2 = await a.turno({ agentId: ag, canal: 'web', endereco: 'api:ana', mensagem: 'de novo' });
  const link = r1.saidas[1].clickUrl;
  assert.match(link, /^https:\/\/bot\.example\/go\?l=[A-Za-z0-9_-]{16}$/);
  assert.equal(r1.saidas[1].url, shop);
  assert.equal(r2.saidas[1].clickUrl, link, 'the same link keeps its id');
  const wa = await a.turno({ agentId: ag, canal: 'whatsapp', endereco: '5511000000002', mensagem: 'oi' });
  assert.match(wa.saidas[1].url, /^https:\/\/bot\.example\/go\?l=/);
  assert.ok(wa.text.includes(wa.saidas[1].url) && !wa.text.includes(shop) && !('clickUrl' in wa.saidas[1]));
  const stored = (await db.query(`SELECT outputs FROM mtr_harness.public_messages WHERE role = 'assistant' ORDER BY id LIMIT 1`)).rows[0].outputs;
  assert.equal(stored[1].url, shop);
  const webStore = createPublicWebStore({ query: (s, v) => db.query(s, v) }, { measure: (o, ident) => measureLinks(events, 'https://bot.example', ident, o, { keepUrl: true }) });
  const old = (await webStore.history(ag, 'api:ana')).find((m) => m.outputs)?.outputs[1];
  assert.deepEqual([old.url, old.clickUrl], [shop, link]);

  const rotas = createRotas();
  registerClickRoute({ rotas, events, send: (res, status, body) => { res.statusCode = status; res.body = body; }, log: { error() {} } });
  const hit = async (method, l, ua = 'Mozilla/5.0') => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, writeHead(s, h) { this.statusCode = s; for (const [k, v] of Object.entries(h)) this.setHeader(k, v); }, end() {} };
    await rotas.atender({ method, headers: { 'user-agent': ua } }, res, new URL(`https://bot.example${CLICK_PATH}?l=${l}`));
    return res;
  };
  const clicks = async () => (await db.query(`SELECT contact_id, ref FROM mtr_harness.public_support_events WHERE kind = 'link_click'`)).rows;
  assert.equal((await hit('GET', link.split('l=')[1], 'WhatsApp/2.23.20.0 A')).headers.location, shop);
  assert.equal((await hit('HEAD', link.split('l=')[1])).statusCode, 302);
  assert.equal((await clicks()).length, 0, 'preview and HEAD are not clicks');
  const go = await hit('GET', link.split('l=')[1]);
  assert.deepEqual([go.statusCode, go.headers.location, go.headers['referrer-policy']], [302, shop, 'no-referrer']);
  await hit('GET', link.split('l=')[1]);
  assert.deepEqual(await clicks(), [{ contact_id: r1.contatoId, ref: 'product:9' }], 'a second tap right away is the same click');
  assert.equal((await hit('GET', 'AAAAAAAAAAAAAAAA')).statusCode, 404);
  assert.equal((await hit('GET', '../etc')).statusCode, 404);
});

test('the events spreadsheet: the owner downloads it, another account gets 404, a formula in a ref goes out as text', async (t) => {
  const { db, store, events, ag } = await setup(t);
  const { createRotas } = await import('../web/routes.mjs');
  const { registrarRotasDoDono } = await import('../web/extensions/public-support/public-support-owner.mjs');
  const { createPublicWebStore } = await import('../web/extensions/public-support/public-web.mjs');
  const { EVENTS_PATH } = await import('../web/extensions/public-support/public-support-events.mjs');
  const owner = (await db.query('SELECT user_id FROM mtr_harness.agents WHERE id = $1', [ag])).rows[0].user_id, other = randomUUID();
  await db.query('INSERT INTO mtr_harness.users VALUES ($1)', [other]);
  const c = (await store.contato(ag, 'whatsapp', '5511000000001')).id;
  await events.record({ agentId: ag, contactId: c, kind: 'bag_add', ref: '=HYPERLINK("x")' });
  const done = [];
  const rotas = createRotas();
  registrarRotasDoDono({ rotas, store, webStore: createPublicWebStore({ query: (s, v) => db.query(s, v) }), send: (res, status, json) => Object.assign(res, { status, json }),
    fail: (res, st, msg, e) => { throw e; }, tooManyRequests: () => false, agenteDoNumero: () => ag,
    metrics: {}, events, activity: { record: async (a) => { done.push([a.action, a.detail]); } } });
  const ask = async (who, days = 7) => {
    const res = { headers: {}, setHeader() {}, writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } };
    await rotas.atender({ method: 'GET' }, res, new URL(`http://x${EVENTS_PATH}?agent=${ag}&days=${days}`), { currentUser: async () => ({ id: who }) });
    return res;
  };
  assert.equal((await ask(other)).status, 404);
  assert.equal((await ask(owner, 5)).status, 400);
  const csv = await ask(owner);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-disposition'], /^attachment; filename="events-[0-9a-f-]+-7d\.csv"$/);
  const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], '"at","contact_id","channel","event","ref"');
  assert.match(lines[1], new RegExp(`^"[0-9: -]+","${c}","whatsapp","bag_add","'=HYPERLINK\\(""x""\\)"$`));
  assert.deepEqual(done, [['events_exported', { days: 7, rows: 1 }]]);
});
