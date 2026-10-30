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
