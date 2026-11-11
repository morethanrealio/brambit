// Test contacts: whoever is on an assistant's list leaves its volume, event counts,
// funnels and the events spreadsheet, past contacts on save and new ones on arrival;
// the conversation itself stays. Real database (PGlite) and the real owner routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
process.env.VAULT_KEY = randomBytes(32).toString('base64');
const { createPublicoStore } = await import('../web/extensions/public-support/public-support.mjs');
const { createEventsStore } = await import('../web/extensions/public-support/public-support-events.mjs');
const { createMetricsStore, METRICS_PATH } = await import('../web/extensions/public-support/public-support-metrics.mjs');
const { registrarRotasDoDono } = await import('../web/extensions/public-support/public-support-owner.mjs');
const { createTestContactsStore, TEST_CONTACTS_PATH } = await import('../web/extensions/public-support/public-support-test-contacts.mjs');
const { createRotas } = await import('../web/routes.mjs');
const TZ = 'America/Sao_Paulo';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });

test('a listed e-mail (a note) or WhatsApp number leaves every metric; clearing the list brings it back', async (t) => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);
    CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY, user_id uuid, name text, instructions text, profile text, summary text, archived_at timestamptz);
    CREATE TABLE mtr_harness.usage_events(id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), agent_id uuid, kind text, cost_usd numeric(12,6));`);
  const owner = randomUUID(), other = randomUUID(), ag = randomUUID();
  await db.query('INSERT INTO mtr_harness.users VALUES ($1),($2)', [owner, other]);
  await db.query(`INSERT INTO mtr_harness.agents VALUES ($1,$2,'Lia','','','',null)`, [ag, owner]);
  let queue = Promise.resolve();
  const query = (sql, v) => v ? db.query(sql, v) : db.exec(sql);
  const pool = { query, async connect() { const before = queue; let free; queue = new Promise((r) => { free = r; }); await before; return { query, release: free }; } };
  const store = createPublicoStore(pool); await store.init();
  await store.configurar(ag, owner, { ativo: true, retencaoDias: 30 });
  const events = createEventsStore(pool, { timezone: TZ, log: { error() {} } });
  const tc = createTestContactsStore(pool);
  const rotas = createRotas();
  const send = (res, status, body, headers = {}) => Object.assign(res, { status, body, headers });
  let seen;
  registrarRotasDoDono({ rotas, store, send, fail: (r, s, m, e) => { throw e; }, tooManyRequests: () => false, agenteDoNumero: () => null,
    metrics: createMetricsStore(pool, { timezone: TZ }), events, testContacts: tc,
    metricCards: async ({ agentId: a, from, to }) => { const e = events.forCards(a, { from, to }); seen = { c: await e.count({ kind: 'scan' }), f: await e.funnel([{ kind: 'scan' }, { kind: 'buy' }]), top: await e.top({ kind: 'scan' }) }; return []; } });
  const ask = async (who, method, path, body) => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []); req.method = method;
    const res = { setHeader() {}, writeHead(status, headers) { Object.assign(this, { status, headers }); }, end(b) { this.body = b; } };
    await rotas.atender(req, res, new URL('http://x' + path), { currentUser: async () => who && { id: who } });
    return res;
  };
  const wa = await store.contato(ag, 'whatsapp', '5511999990001');
  const web = await store.contato(ag, 'web', 'v-1');
  const real = await store.contato(ag, 'web', 'v-2');
  for (const c of [wa, web, real]) await store.registrar(c.id, [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'ok' }]);
  await store.lembrar(web.id, 'email', 'Tester@Example.com');
  await store.lembrar(real.id, 'email', 'client@example.com');
  for (const c of [wa, web, real]) await db.query(`INSERT INTO mtr_harness.public_support_events (agent_id, contact_id, kind, ref) VALUES ($1,$2,'scan','x'),($1,$2,'buy','y')`, [ag, c.id]);
  const m = async () => { const r = await ask(owner, 'GET', `${METRICS_PATH}?agent=${ag}&days=7`); return { total: r.body.total, ...seen }; };
  const before = await m();
  assert.equal(before.total.people, 3);
  assert.equal((await ask(other, 'POST', TEST_CONTACTS_PATH, { agentId: ag, entries: ['a@b.co'] })).status, 404);
  assert.equal((await ask(owner, 'POST', TEST_CONTACTS_PATH, { agentId: ag, entries: ['nope'] })).status, 400);
  const saved = await ask(owner, 'POST', TEST_CONTACTS_PATH, { agentId: ag, entries: ['tester@example.com', '+55 (11) 99999-0001'] });
  assert.deepEqual(saved.body, { ok: true, entries: ['tester@example.com', '5511999990001'], testContacts: 2 });
  const after = await m();
  assert.equal(after.total.people, 1);
  assert.deepEqual([after.c, after.f, after.top.rows[0].people], [{ times: 1, people: 1 }, [1, 1], 1]);
  assert.equal((await events.list(owner, ag, { from: today(), to: today() })).length, 2, 'only the real contact\'s two events');
  assert.deepEqual((await ask(owner, 'GET', `${TEST_CONTACTS_PATH}?agent=${ag}`)).body.entries, ['tester@example.com', '5511999990001']);
  assert.equal((await ask(other, 'GET', `${TEST_CONTACTS_PATH}?agent=${ag}`)).status, 404);
  // New contacts are marked on arrival, by a note or by their number.
  const late = await store.contato(ag, 'web', 'v-3');
  await store.lembrar(late.id, 'email', 'TESTER@example.com');
  const { rows } = await db.query(`SELECT id, is_test FROM mtr_harness.public_contacts WHERE agent_id=$1`, [ag]);
  assert.equal(rows.find((r) => r.id === late.id).is_test, true, 'a new contact whose note is listed');
  const fresh = await store.contato(ag, 'whatsapp', '+5511999990002');
  await ask(owner, 'POST', TEST_CONTACTS_PATH, { agentId: ag, entries: ['tester@example.com', '5511999990001', '5511999990003'] });
  const newcomer = await store.contato(ag, 'whatsapp', '5511999990003');
  const flag = async (id) => (await db.query('SELECT is_test FROM mtr_harness.public_contacts WHERE id = $1', [id])).rows[0].is_test;
  assert.deepEqual([await flag(fresh.id), await flag(newcomer.id)], [false, true], 'a new WhatsApp number on the list');
  // Clearing the list brings everyone back.
  await ask(owner, 'POST', TEST_CONTACTS_PATH, { agentId: ag, entries: [] });
  assert.equal((await m()).total.people, 3);
  assert.equal((await db.query('SELECT count(*)::int n FROM mtr_harness.public_contacts WHERE is_test')).rows[0].n, 0);
});
