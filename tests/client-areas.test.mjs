// Client areas: a member of one client's area reaches only that area's assistants,
// with what their role allows; the owner keeps everything. Real database (PGlite)
// and the real owner routes; only the model is fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';

process.env.VAULT_KEY = randomBytes(32).toString('base64');
const { createPublicoStore, createAtendimentoPublico } = await import('../web/extensions/public-support/public-support.mjs');
const { registrarRotasDoDono, AGENT_TEXTS_PATH } = await import('../web/extensions/public-support/public-support-owner.mjs');
const { createPublicWebStore } = await import('../web/extensions/public-support/public-web.mjs');
const { createPromptStore } = await import('../web/extensions/public-support/public-support-prompts.mjs');
const { createClientAreaStore, registerClientAreaRoutes, panelScope, CLIENT_AREAS_PATH } = await import('../web/extensions/public-support/client-areas.mjs');
const { createRotas } = await import('../web/routes.mjs');
const { createAccountScope } = await import('../web/account-scope.mjs');

async function setup(t, { mail = { enabled: () => false, send: async () => { throw new Error('no e-mail in tests'); } } } = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, name text,
      password_hash text NOT NULL DEFAULT 'x', deleted_at timestamptz);
    CREATE TABLE mtr_harness.password_resets(token text PRIMARY KEY, user_id uuid NOT NULL REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL, used_at timestamptz);
    CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY, user_id uuid REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
      name text, instructions text, profile text, summary text, archived_at timestamptz);
    CREATE TABLE mtr_harness.usage_events(id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), agent_id uuid, kind text, cost_usd numeric(12,6));`);
  const owner = randomUUID(), adminA = randomUUID(), viewerB = randomUUID(), stranger = randomUUID();
  const agA = randomUUID(), agB = randomUUID(), agOwn = randomUUID(), agStranger = randomUUID();
  await db.query(`INSERT INTO mtr_harness.users (id, email) VALUES ($1,'owner@x.test'), ($2,'admin@a.test'), ($3,'viewer@b.test'), ($4,'stranger@x.test')`,
    [owner, adminA, viewerB, stranger]);
  await db.query(`INSERT INTO mtr_harness.agents VALUES ($1,$4,'A',null,null,null,null), ($2,$4,'B',null,null,null,null),
    ($3,$4,'Own',null,null,null,null), ($5,$6,'S',null,null,null,null)`, [agA, agB, agOwn, owner, agStranger, stranger]);
  let queue = Promise.resolve();
  const query = (sql, v) => v ? db.query(sql, v) : db.exec(sql);
  const pool = { query, async connect() { const before = queue; let release; queue = new Promise((r) => { release = r; }); await before; return { query, release }; } };
  const store = createPublicoStore(pool); await store.init();
  const prompts = createPromptStore(pool); await prompts.init();
  const areas = createClientAreaStore(pool); await areas.init(); await areas.init();
  const model = () => ({ name: 'fake', async complete() { return { stop: 'end', text: 'ok', usage: { in: 1, out: 1 } }; } });
  const turns = createAtendimentoPublico({ store, makeProvider: model, recordUsage: async () => {}, saldo: async () => ({ over: false }),
    agora: () => 'segunda', log: { error() {} } });
  const contact = async (agentId, phone) => {
    await store.configurar(agentId, owner, { ativo: true });
    return (await turns.turno({ agentId, canal: 'whatsapp', endereco: phone, mensagem: 'oi' })).contatoId;
  };
  const rotas = createRotas();
  const send = (res, status, body, headers = {}) => Object.assign(res, { status, body, headers });
  const fail = (res, st, msg, e) => { throw e; };
  registrarRotasDoDono({ rotas, store, webStore: createPublicWebStore(pool), send, fail, tooManyRequests: () => false, agenteDoNumero: () => null,
    prompts, defaultTexts: async () => ({ written: 'default', spoken: null }), areas });
  registerClientAreaRoutes({ rotas, areas, send, fail, tooManyRequests: () => false, publicBase: () => 'https://panel.example/', mail, log: { error() {} } });
  const ask = async (who, method, path, body) => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []); req.method = method;
    const res = { setHeader() {} };
    await rotas.atender(req, res, new URL('http://x' + path), { currentUser: async () => who && { id: who } });
    return res;
  };
  return { db, store, prompts, areas, ask, contact, owner, adminA, viewerB, stranger, agA, agB, agOwn, agStranger };
}

// Owner sets up area A (admin@a) with assistant A and area B (viewer@b) with assistant B.
async function twoClients(s) {
  const { ask, owner, agA, agB } = s;
  const a = (await ask(owner, 'POST', CLIENT_AREAS_PATH, { name: 'Client A' })).body;
  const b = (await ask(owner, 'POST', CLIENT_AREAS_PATH, { name: 'Client B' })).body;
  for (const [agentId, areaId] of [[agA, a.id], [agB, b.id]]) {
    assert.equal((await ask(owner, 'POST', CLIENT_AREAS_PATH + '/agent', { agentId, areaId })).status, 200);
  }
  assert.equal((await ask(owner, 'POST', CLIENT_AREAS_PATH + '/member', { areaId: a.id, email: 'Admin@A.test', role: 'admin' })).status, 200);
  assert.equal((await ask(owner, 'POST', CLIENT_AREAS_PATH + '/member', { areaId: b.id, email: 'viewer@b.test', role: 'viewer' })).status, 200);
  return { a, b, contactA: await s.contact(agA, '5511000000001'), contactB: await s.contact(agB, '5511000000002') };
}

test('a client sees only its own area: another area\'s assistant, contact and texts answer 404', async (t) => {
  const s = await setup(t);
  const { ask, owner, adminA, viewerB, agA, agB, agOwn } = s;
  const { contactA, contactB } = await twoClients(s);

  const listA = (await ask(adminA, 'GET', '/api/publico/agentes')).body.agentes;
  assert.deepEqual(listA.map((x) => [x.nome, x.role, x.areaName]), [['A', 'admin', 'Client A']]);
  assert.equal(listA[0].tetoDiarioUsd, undefined, 'a member does not see the spend cap');
  assert.deepEqual((await ask(viewerB, 'GET', '/api/publico/agentes')).body.agentes.map((x) => [x.nome, x.role]), [['B', 'viewer']]);
  const listOwner = (await ask(owner, 'GET', '/api/publico/agentes')).body.agentes;
  assert.deepEqual(listOwner.map((x) => [x.nome, x.role, x.areaName]), [['A', 'owner', 'Client A'], ['B', 'owner', 'Client B'], ['Own', 'owner', null]]);

  for (const [method, path, body] of [['GET', `/api/publico/contatos?agente=${agB}`], ['GET', `/api/publico/contatos?agente=${agOwn}`],
    ['GET', `/api/publico/conversa?contato=${contactB}`], ['GET', `/api/publico/exportar?contato=${contactB}`],
    ['POST', '/api/publico/bloquear', { contatoId: contactB, bloqueado: true }], ['POST', '/api/publico/apagar', { contatoId: contactB }],
    ['POST', '/api/publico/configurar', { agentId: agB, instrucoes: 'x' }], ['POST', '/api/publico/web-key', { agentId: agB }],
    ['GET', `${AGENT_TEXTS_PATH}?agent=${agB}`], ['POST', AGENT_TEXTS_PATH, { agentId: agB, kind: 'written', content: 'x' }]]) {
    assert.equal((await ask(adminA, method, path, body)).status, 404, `${method} ${path}`);
  }
  assert.equal((await s.store.exportar(contactB)).contato.bloqueadoEm, null);
  assert.deepEqual((await ask(adminA, 'GET', `/api/publico/contatos?agente=${agA}`)).body.contatos.map((c) => c.id), [contactA]);

  // Areas are the owner's: a member or anyone else can neither see nor change them.
  assert.deepEqual((await ask(adminA, 'GET', CLIENT_AREAS_PATH)).body.areas, []);
  const areaB = (await ask(owner, 'GET', CLIENT_AREAS_PATH)).body.areas.find((x) => x.name === 'Client B');
  assert.deepEqual(areaB.members.map((m) => [m.email, m.role]), [['viewer@b.test', 'viewer']]);
  assert.equal((await ask(adminA, 'POST', CLIENT_AREAS_PATH + '/member', { areaId: areaB.id, email: 'admin@a.test', role: 'admin' })).status, 404);
  assert.equal((await ask(adminA, 'POST', CLIENT_AREAS_PATH + '/agent', { agentId: agA, areaId: null })).status, 404);
  assert.equal((await ask(s.stranger, 'POST', CLIENT_AREAS_PATH + '/agent', { agentId: s.agStranger, areaId: areaB.id })).status, 404,
    'an assistant goes only into an area of its own owner');

  // Out of the area = out of everything.
  assert.equal((await ask(owner, 'POST', CLIENT_AREAS_PATH + '/member', { areaId: areaB.id, email: 'viewer@b.test', role: null })).status, 200);
  assert.deepEqual((await ask(viewerB, 'GET', '/api/publico/agentes')).body.agentes, []);
  assert.equal((await ask(viewerB, 'GET', `/api/publico/conversa?contato=${contactB}`)).status, 404);
  assert.equal((await ask(owner, 'POST', CLIENT_AREAS_PATH + '/member', { areaId: areaB.id, email: 'nobody@x.test', role: null })).status, 400);
});

test('roles: the admin edits instructions, texts, link sites and contacts; the viewer only reads; the rest is the owner\'s', async (t) => {
  const s = await setup(t);
  const { ask, owner, adminA, viewerB, agA, agB } = s;
  const { contactA, contactB } = await twoClients(s);

  const saved = await ask(adminA, 'POST', '/api/publico/configurar', { agentId: agA, instrucoes: 'Be brief.', linkSites: ['shop.example'] });
  assert.deepEqual([saved.status, saved.body.instrucoes, saved.body.linkSites], [200, 'Be brief.', ['shop.example']]);
  for (const extra of [{ ativo: false }, { tetoDiarioUsd: 500 }, { limitePorHora: 600 }, { agentHourlyLimit: 9 }, { retencaoDias: 3650 },
    { webEnabled: true }, { webOrigins: ['https://evil.example'] }, { avatarEnabled: true }]) {
    assert.equal((await ask(adminA, 'POST', '/api/publico/configurar', { agentId: agA, instrucoes: 'y', ...extra })).status, 403, JSON.stringify(extra));
  }
  assert.equal((await ask(adminA, 'POST', '/api/publico/web-key', { agentId: agA })).status, 403);
  const a = await s.store.agente(agA);
  assert.deepEqual([a.ativo, a.instrucoes], [true, 'Be brief.'], 'nothing of a refused request was saved');

  const text = await ask(adminA, 'POST', AGENT_TEXTS_PATH, { agentId: agA, kind: 'written', content: 'client text' });
  assert.equal(text.body.content, 'client text');
  assert.equal((await ask(owner, 'GET', `${AGENT_TEXTS_PATH}?agent=${agA}`)).body.written.content, 'client text', 'one text, the same the owner sees');
  assert.deepEqual(await s.prompts.current(agA), { installation: '', written: 'client text', spoken: '' });
  assert.equal((await ask(adminA, 'GET', `/api/publico/exportar?contato=${contactA}`)).status, 200);
  assert.equal((await ask(adminA, 'POST', '/api/publico/bloquear', { contatoId: contactA, bloqueado: true })).status, 200);
  assert.equal((await ask(adminA, 'POST', '/api/publico/apagar', { contatoId: contactA })).status, 200);
  assert.equal(await s.store.exportar(contactA), null);

  assert.equal((await ask(viewerB, 'GET', `/api/publico/conversa?contato=${contactB}`)).status, 200);
  assert.equal((await ask(viewerB, 'GET', `${AGENT_TEXTS_PATH}?agent=${agB}`)).status, 200);
  for (const [method, path, body] of [['POST', '/api/publico/configurar', { agentId: agB, instrucoes: 'x' }],
    ['POST', AGENT_TEXTS_PATH, { agentId: agB, kind: 'written', content: 'x' }], ['POST', AGENT_TEXTS_PATH + '/restore', { agentId: agB, kind: 'written', versionId: '1' }],
    ['POST', '/api/publico/bloquear', { contatoId: contactB, bloqueado: true }], ['POST', '/api/publico/apagar', { contatoId: contactB }],
    ['GET', `/api/publico/exportar?contato=${contactB}`]]) {
    assert.equal((await ask(viewerB, method, path, body)).status, 403, `${method} ${path}`);
  }
  assert.equal((await s.store.exportar(contactB)).contato.bloqueadoEm, null);

  // The owner still changes everything, inside an area too.
  assert.equal((await ask(owner, 'POST', '/api/publico/configurar', { agentId: agA, ativo: false, tetoDiarioUsd: 5 })).status, 200);
  assert.equal((await ask(owner, 'POST', '/api/publico/web-key', { agentId: agB })).status, 200);
});

test('invite: a new e-mail becomes a panel account with a one-time password link; the core holds it to this screen', async (t) => {
  const sent = [];
  const s = await setup(t, { mail: { enabled: () => true, send: async (m) => { sent.push(m); return { ok: true }; } } });
  const { ask, db, areas, owner, stranger, agA } = s;
  const { a } = await twoClients(s);
  const invite = (body) => ask(owner, 'POST', CLIENT_AREAS_PATH + '/member', { areaId: a.id, role: 'admin', ...body });

  const first = await invite({ email: 'New@C.test', sendEmail: true });
  assert.equal(first.status, 200);
  assert.equal(first.body.created, true);
  assert.match(first.body.link, /^https:\/\/panel\.example\/reset\?token=\w+/);
  assert.equal(first.body.emailed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'new@c.test');
  assert.ok(sent[0].text.includes(first.body.link) && sent[0].subject.includes('Client A'));
  const invited = (await db.query(`SELECT id FROM mtr_harness.users WHERE email = 'new@c.test'`)).rows[0].id;
  assert.equal(await areas.isPanelAccount(invited), true);
  assert.equal((await ask(invited, 'GET', '/api/publico/agentes')).body.agentes[0].agentId, agA, 'the panel account sees its area');
  assert.equal((await ask(invited, 'GET', '/api/publico/agentes')).body.panelAccount, true);

  // While it has no password, inviting again gives a new link (no e-mail unless asked); once one is set, no more links.
  const again = await invite({ email: 'new@c.test' });
  assert.equal(again.body.created, false);
  assert.ok(again.body.link && again.body.link !== first.body.link);
  assert.equal(again.body.emailed, false);
  assert.equal(sent.length, 1);
  await db.query(`UPDATE mtr_harness.password_resets SET used_at = now() WHERE user_id = $1`, [invited]);
  assert.equal((await invite({ email: 'new@c.test' })).body.link, undefined);

  // An account that already exists joins as it is: no link, not held.
  const full = await invite({ email: 'stranger@x.test' });
  assert.equal(full.body.link, undefined);
  assert.equal(await areas.isPanelAccount(stranger), false);

  // The core's account scope, with the extension's rules.
  const scope = createAccountScope();
  scope.register(panelScope(areas));
  const as = (id) => async () => id && { id };
  for (const [method, path, verdict] of [
    ['GET', '/chats', { status: 302, location: '/public-support' }],
    ['POST', '/api/chat', { status: 404 }], ['POST', '/api/agent', { status: 404 }], ['GET', '/api/usage', { status: 404 }],
    ['POST', CLIENT_AREAS_PATH, { status: 404 }],
    ['GET', '/public-support', null], ['GET', '/api/publico/agentes', null], ['POST', '/api/public-support/texts/restore', null],
    ['POST', '/api/login', null], ['POST', '/api/reset', null], ['POST', '/api/logout', null],
  ]) assert.deepEqual(await scope.check(method, path, as(invited)), verdict, `${method} ${path}`);
  assert.equal(await scope.check('POST', '/api/chat', as(stranger)), null, 'a full account is not held');
  assert.equal(await scope.check('POST', '/api/chat', as(null)), null);
});

test('account scope: with no panel account loaded, the core does not look the session up', async (t) => {
  const s = await setup(t);
  const scope = createAccountScope();
  scope.register(panelScope(s.areas));
  let lookups = 0;
  const user = async () => { lookups += 1; return { id: s.stranger }; };
  assert.equal(await scope.check('GET', '/chats', user), null);
  assert.equal(lookups, 1, 'checked until the list loads');
  assert.equal(await scope.check('GET', '/chats', user), null);
  assert.equal(lookups, 1);
});
