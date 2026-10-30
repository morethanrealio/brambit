// A website's visitor talks to the assistant's face (public-avatar.mjs): only
// when the owner turned it on, only for a contact that already wrote, only
// from a listed website, and a talk is reachable only on its own assistant. A
// new contact token from the same address does not give new minutes, and the
// owner turning the face off ends the talks open. Real database (PGlite), real
// live sessions (avatar-live.mjs); the avatar service and the model are fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';

process.env.VAULT_KEY = randomBytes(32).toString('base64');
const { createPublicoStore, createAtendimentoPublico } = await import('../web/extensions/public-support/public-support.mjs');
const { createPublicWebStore, registerPublicWebRoutes } = await import('../web/extensions/public-support/public-web.mjs');
const { createPublicAvatarStore, registerPublicAvatar } = await import('../web/extensions/public-support/public-avatar.mjs');
const { createAvatarLive } = await import('../web/avatar-live.mjs');
const { createRotas } = await import('../web/routes.mjs');

const SITE = { origin: 'https://shop.example.com' };

async function setup(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);
    CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY, user_id uuid REFERENCES mtr_harness.users(id) ON DELETE CASCADE,
      name text, instructions text, profile text, summary text, archived_at timestamptz);
    CREATE TABLE mtr_harness.usage_events(id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(), agent_id uuid, user_id uuid,
      kind text, model text, tok_out bigint, cost_usd numeric(12,6));`);
  const owner = randomUUID(), ag = randomUUID(), ag2 = randomUUID();
  await db.query('INSERT INTO mtr_harness.users VALUES ($1)', [owner]);
  await db.query(`INSERT INTO mtr_harness.agents VALUES ($1,$3,'Lia','','','',null), ($2,$3,'Bia','','','',null)`, [ag, ag2, owner]);
  let line = Promise.resolve();
  const query = (sql, v) => (v ? db.query(sql, v) : db.exec(sql));
  const pool = { query, async connect() { const before = line; let free; line = new Promise((r) => { free = r; }); await before; return { query, release: free }; } };
  const store = createPublicoStore(pool); await store.init();
  const webStore = createPublicWebStore(pool), avatarStore = createPublicAvatarStore(pool);

  const model = () => ({ name: 'fake', complete: async () => ({ stop: 'end', text: 'hello there', usage: { in: 1, out: 1 } }) });
  const { turno } = createAtendimentoPublico({ store, makeProvider: model, recordUsage: async () => {}, saldo: async () => ({ over: false }),
    agora: () => 'monday', log: { error() {} } });
  const api = {
    createSession: async () => ({ id: randomUUID(), rtc: { provider: 'agora', appId: 'app', channel: 'ch', uid: 'u', token: 'tok' } }),
    openStream: () => ({ ready: new Promise(() => {}), audio() {}, reply() {}, cut() {}, hangup() {} }),
  };
  const live = createAvatarLive({ vidu: () => ({ host: 'vidu.test', key: 'k' }), api, store: {}, tts: async () => ({ pcm: Buffer.alloc(0), usage: {} }),
    recordUsages: async () => {}, registerAgent: () => {}, onStop: () => {}, log: () => {}, info: () => {} });
  t.after(() => live.endWhere(() => true, 'shutdown'));
  const photo = { provider_status: 'ready', provider_photo_id: 'p1', provider_photo_created_at: new Date().toISOString() };
  const avatar = { live, store: { get: async () => photo }, voiceOf: () => 'Kore', available: () => true, registerAgent: () => {} };

  const rotas = createRotas();
  const send = (res, status, body) => Object.assign(res, { status, body });
  const common = { rotas, webStore, send, fail: (res, st, msg, e) => { throw e; }, tooManyRequests: () => false, clientIp: (req) => req.headers['x-ip'] };
  const face = registerPublicAvatar({ ...common, avatar, store, avatarStore, creditStatus: async () => ({ over: false }) });
  registerPublicWebRoutes({ ...common, turno, afterTurn: face.afterTurn });

  const call = async (method, path, { body, headers = {} } = {}) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []); req.method = method; req.headers = headers;
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(st) { this.status = st; }, write() {}, end() { this.close?.(); },
      on(name, fn) { if (name === 'close') this.close = fn; } };
    await rotas.atender(req, res, new URL('http://x' + path), {});
    return res;
  };
  await store.configurar(ag, owner, { ativo: true });
  await webStore.configure(ag, owner, { enabled: true, origins: [SITE.origin] });
  const key = await webStore.newKey(ag, owner);
  // A visitor that wrote once: its contact token.
  const visitor = async (ip) => (await call('POST', `/api/public/messages?agent=${ag}`, { body: { message: 'hi' }, headers: { ...SITE, 'x-ip': ip } })).body.contact;
  return { owner, ag, ag2, live, photo, avatarStore, face, call, key, visitor };
}

const at = (ag, path = '') => `/api/public/avatar${path}?agent=${ag}`;

test('a talk opens only when the face is on and ready, for a contact that wrote, from a listed website', async (t) => {
  const { owner, ag, photo, avatarStore, call, key, visitor } = await setup(t);
  const contact = await visitor('198.51.100.1');
  const open = (body, headers = { ...SITE, 'x-ip': '198.51.100.1' }) => call('POST', at(ag), { body, headers });
  assert.equal((await open({ contact })).body.error, 'avatar_disabled');
  await avatarStore.configure(ag, owner, { enabled: true });
  assert.equal((await open({ contact }, { origin: 'https://evil.example.com' })).body.error, 'origin_not_allowed');
  assert.equal((await open({})).body.error, 'contact_required');
  const server = (id) => call('POST', at(ag), { body: { contact: id }, headers: { authorization: 'Bearer ' + key } });
  assert.equal((await server('never-wrote')).body.error, 'message_first');
  photo.provider_status = 'pending';
  assert.equal((await open({ contact })).body.error, 'avatar_not_ready');
  photo.provider_status = 'ready';
  const first = await open({ contact });
  assert.equal(first.status, 200);
  assert.equal(first.headers['Access-Control-Allow-Origin'], SITE.origin);
  assert.equal((await open({ contact })).body.id, first.body.id, 'the same contact gets the talk already open');
});

test('a talk is reached only on its assistant and from a listed website; minutes go by address; turning the face off ends it', async (t) => {
  const { owner, ag, ag2, live, avatarStore, face, call, visitor } = await setup(t);
  await avatarStore.configure(ag, owner, { enabled: true, visitorMinutes: 1 });
  const ip = '198.51.100.1';
  const open = async (contact, from = ip) => call('POST', at(ag), { body: { contact }, headers: { ...SITE, 'x-ip': from } });
  const { body: { id } } = await open(await visitor(ip));
  assert.equal((await call('GET', `${at(ag2, '/events')}&id=${id}`, { headers: SITE })).body.error, 'session_not_found');
  assert.equal((await call('GET', `${at(ag, '/events')}&id=${id}`, { headers: { origin: 'https://evil.example.com' } })).body.error, 'origin_not_allowed');
  assert.equal((await call('POST', at(ag, '/hush'), { body: { id }, headers: { origin: 'https://evil.example.com' } })).body.error, 'origin_not_allowed');
  assert.equal((await call('GET', `${at(ag, '/events')}&id=${id}`, { headers: SITE })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await call('POST', at(ag, '/end'), { body: { id }, headers: SITE })).status, 200);
  assert.equal(live.get(id), null);

  // A new contact token from the same address finds that minute spent.
  assert.equal((await open(await visitor(ip))).body.error, 'avatar_daily_limit');
  const other = await open(await visitor('203.0.113.9'), '203.0.113.9');
  assert.equal(other.status, 200);

  const ends = [];
  live.watch(live.get(other.body.id), { writeHead() {}, write(chunk) { ends.push(chunk); }, end() {}, on() {} });
  await avatarStore.configure(ag, owner, { enabled: false });
  await face.agentChanged(ag);
  assert.equal(live.get(other.body.id), null);
  assert.match(ends.at(-1), /"reason":"unavailable"/);
});
