// Public support over the web: a site's chat widget, or a server, talks to an
// assistant's public mode over HTTP. The turn itself is public-support.mjs's, with
// channel 'web'; this module only decides who may call and which contact it is.
//
// The agent goes in the query string (?agent=<id>), so one installation serves
// as many public assistants as there are owners who turned the web channel on.
// The owner turns it on in /public-support (public-support-owner.mjs) and chooses how it
// is called:
//  - From a browser: only from the origins the owner listed (CORS). The contact
//    is a token this module issues on the first message and signs with the
//    vault key, so nobody reaches another visitor's conversation by guessing.
//  - From a server: `Authorization: Bearer <key>` with the agent's key (stored
//    only as a hash). The caller then names the contact with its own id. The
//    owner may also list the server addresses allowed to use the key; with a
//    list, a call from anywhere else is refused even with the right key.
// There is no cookie here, so the paths are outside the server's CSRF check;
// the origin check below replaces it. The public-support guards (hourly limit,
// daily cap, stop and delete commands) apply as on WhatsApp.
// A message may carry one photo for the model to look at: a server's at any
// time, a browser's only when the assistant asked that contact for one. It is
// not stored: the history keeps the text only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { indiceCego } from './vault.mjs';
import { chaveDoContato, normalizeEvent } from './public-support.mjs';
import { sniffImagem } from './image-sniff.mjs';

export const PUBLIC_WEB_PATH = '/api/public/messages';
export const PUBLIC_WEB_PATHS = new Set([PUBLIC_WEB_PATH]);
export const WEB_ORIGINS_MAX = 20;
export const WEB_KEY_IPS_MAX = 20;
export const WEB_HISTORY_MAX = 50;
export const WEB_CONTACT_MAX = 200;
export const WEB_BODY_MAX = 64 * 1024;
// The photo: decoded size and the formats vision models read. A body that carries
// one may grow by the photo in base64; the rest of it keeps WEB_BODY_MAX.
export const WEB_IMAGE_MAX = 1024 * 1024;
const WEB_IMAGE_B64_MAX = Math.ceil(WEB_IMAGE_MAX / 3) * 4;
const WEB_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// History names the contact in this header, not in the address: an address ends up
// in proxy access logs, and the browser token is all it takes to read the conversation.
export const WEB_CONTACT_HEADER = 'Brambit-Contact';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');
const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// The route has no login, so the body is capped before it is buffered. Past the
// cap the rest is read and dropped (the socket stays usable for the 413).
// Returns { body, size } or null past the cap.
export async function readSmallJson(req, max) {
  if (Number(req.headers['content-length'] || 0) > max) return null;
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= max) chunks.push(chunk);
  }
  if (size > max) return null;
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
  return { body: body && typeof body === 'object' ? body : {}, size };
}

// The photo: a data URL or bare base64. Its bytes decide the type (the declared
// one is ignored). Returns { image: {mimeType, data} } or { status, error }.
function webImage(v) {
  const b64 = typeof v === 'string' ? v.replace(/^data:[^,]*,/, '').replace(/\s+/g, '') : '';
  const bytes = /^[A-Za-z0-9+/]+={0,2}$/.test(b64) ? Buffer.from(b64, 'base64') : null;
  if (bytes?.length > WEB_IMAGE_MAX) return { status: 413, error: 'image_too_large' };
  const type = bytes && sniffImagem(bytes)?.mime;
  if (!WEB_IMAGE_TYPES.has(type)) return { status: 400, error: 'invalid_image' };
  return { image: { mimeType: type, data: bytes.toString('base64') } };
}

// Browser contact token: random part + signature.
const signature = (id) => indiceCego(id, 'public-web-contact').slice(0, 22);
export function newContactToken() {
  const id = randomBytes(18).toString('base64url');
  return `${id}.${signature(id)}`;
}
export function contactFromToken(token) {
  const m = /^([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  return m && sameText(m[2], signature(m[1])) ? m[1] : null;
}

// An origin the owner lists: https (or http on localhost, for testing), no path.
export function normalizeOrigin(v) {
  try {
    const u = new URL(String(v).trim());
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
    if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
    return u.origin;
  } catch { return null; }
}

// '::ffff:203.0.113.7' (an IPv4 caller seen through an IPv6 socket) → '203.0.113.7'.
const plainIp = (ip) => String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

// An address the owner lets use the server key: one IP or a CIDR range
// (203.0.113.7, 203.0.113.0/24, 2001:db8::/32). Returns it as stored, or null.
export function normalizeKeyIp(v) {
  const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(String(v).trim());
  if (!m) return null;
  const ip = plainIp(m[1]), family = isIP(ip);
  if (!family) return null;
  if (m[2] === undefined) return ip;
  const bits = Number(m[2]);
  return bits >= 1 && bits <= (family === 4 ? 32 : 128) ? `${ip}/${bits}` : null;
}

export function ipAllowed(ip, list) {
  const addr = plainIp(ip), family = isIP(addr);
  if (!family) return false;
  const allowed = new BlockList();
  for (const entry of list) {
    const [net, bits] = entry.split('/');
    const type = isIP(net) === 6 ? 'ipv6' : 'ipv4';
    if (bits) allowed.addSubnet(net, Number(bits), type); else allowed.addAddress(net, type);
  }
  return allowed.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

// Owner form → fields. Returns {erro: <server.* key>} on an invalid value (same
// contract as camposDaConfig).
export function webFieldsFromBody(b = {}) {
  const c = {};
  if (b.webEnabled !== undefined) {
    if (typeof b.webEnabled !== 'boolean') return { erro: 'server.public_web_enabled_invalid' };
    c.enabled = b.webEnabled;
  }
  if (b.webOrigins !== undefined) {
    if (!Array.isArray(b.webOrigins) || b.webOrigins.length > WEB_ORIGINS_MAX) return { erro: 'server.public_web_too_many_origins' };
    const origins = b.webOrigins.map(normalizeOrigin);
    if (origins.some((o) => !o)) return { erro: 'server.public_web_origin_invalid' };
    c.origins = [...new Set(origins)];
  }
  if (b.webKeyIps !== undefined) {
    if (!Array.isArray(b.webKeyIps) || b.webKeyIps.length > WEB_KEY_IPS_MAX) return { erro: 'server.public_web_too_many_key_ips' };
    const ips = b.webKeyIps.map(normalizeKeyIp);
    if (ips.some((x) => !x)) return { erro: 'server.public_web_key_ip_invalid' };
    c.keyIps = [...new Set(ips)];
  }
  return { campos: c };
}

export function createPublicWebStore(pool, { S = 'mtr_harness' } = {}) {
  return {
    async config(agentId) {
      const { rows } = await pool.query(
        `SELECT p.ativo, p.web_enabled, p.web_origins, p.web_key_hash, p.web_key_ips FROM ${S}.public_agents p
           JOIN ${S}.agents a ON a.id = p.agent_id AND a.user_id = p.user_id
          WHERE p.agent_id = $1 AND a.archived_at IS NULL`, [agentId]);
      const r = rows[0];
      return r ? { active: r.ativo, enabled: r.web_enabled, origins: r.web_origins || [], keyHash: r.web_key_hash, keyIps: r.web_key_ips || [] } : null;
    },

    // Only the owner, and only an assistant already configured for public support.
    async configure(agentId, userId, { enabled, origins, keyIps } = {}) {
      const { rows } = await pool.query(
        `UPDATE ${S}.public_agents SET web_enabled = coalesce($3, web_enabled), web_origins = coalesce($4, web_origins),
                web_key_ips = coalesce($5, web_key_ips), atualizado_em = now()
          WHERE agent_id = $1 AND user_id = $2 RETURNING web_enabled, web_origins, web_key_ips, web_key_hash IS NOT NULL AS web_has_key`,
        [agentId, userId, enabled ?? null, origins ?? null, keyIps ?? null]);
      return rows[0] || null;
    },

    // New server key; the old one stops working. The key is returned only here.
    async newKey(agentId, userId) {
      const key = 'bpk_' + randomBytes(32).toString('base64url');
      const { rowCount } = await pool.query(
        `UPDATE ${S}.public_agents SET web_key_hash = $3, atualizado_em = now() WHERE agent_id = $1 AND user_id = $2`,
        [agentId, userId, sha256(key)]);
      return rowCount ? key : null;
    },

    // The contact's own conversation, WITHOUT creating the contact.
    async history(agentId, address, limit = WEB_HISTORY_MAX) {
      const { rows } = await pool.query(
        `SELECT role, content, outputs, event, criado_em FROM (
           SELECT m.id, m.role, m.content, m.outputs, m.event, m.criado_em FROM ${S}.public_messages m
             JOIN ${S}.public_contacts c ON c.id = m.contact_id
            WHERE c.agent_id = $1 AND c.canal = 'web' AND c.chave = $2
            ORDER BY m.id DESC LIMIT $3) t ORDER BY id`,
        [agentId, chaveDoContato('web', address), limit]);
      return rows.map((r) => ({ role: r.role, text: r.content, ...(r.outputs ? { outputs: r.outputs } : {}),
        ...(r.event ? { event: r.event } : {}), at: r.criado_em }));
    },
  };
}

// Who may call an assistant's web paths (the messages here, the avatar in
// public-avatar.mjs). available() → false while the installation keeps public
// support off (public-support-channel.mjs).
export function createWebCaller({ webStore, clientIp = (req) => req.socket?.remoteAddress, available = async () => true }) {
  // Who is calling: {agentId, address, token?, fresh?} or {status, error}. The
  // address keeps browser and server contacts apart, so neither can name the other's.
  async function caller(req, res, url, contact) {
    const agentId = String(url.searchParams.get('agent') || '');
    if (!UUID.test(agentId)) return { status: 404 };
    const cfg = await webStore.config(agentId);
    if (!cfg?.active || !cfg.enabled || !(await available())) return { status: 404 };
    const auth = String(req.headers.authorization || '');
    if (auth) {
      // Checked before the key, so a call from elsewhere learns nothing about it.
      if (cfg.keyIps.length && !ipAllowed(clientIp(req), cfg.keyIps)) return { status: 403, error: 'ip_not_allowed' };
      const key = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
      if (!key || !cfg.keyHash || !sameText(sha256(key), cfg.keyHash)) return { status: 401, error: 'invalid_key' };
      const id = typeof contact === 'string' ? contact.trim() : '';
      if (!id || id.length > WEB_CONTACT_MAX) return { status: 400, error: 'contact_required' };
      return { agentId, address: `api:${id}` };
    }
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin)) return { status: 403, error: 'origin_not_allowed' };
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (contact === undefined || contact === null || contact === '') {
      const token = newContactToken();
      return { agentId, address: `browser:${contactFromToken(token)}`, token, fresh: true };
    }
    const id = contactFromToken(contact);
    if (!id) return { status: 400, error: 'invalid_contact' };
    return { agentId, address: `browser:${id}`, token: contact };
  }

  // Browser preflight: answers with CORS only for a listed origin.
  async function preflight(req, res, url, methods) {
    const agentId = String(url.searchParams.get('agent') || '');
    const cfg = UUID.test(agentId) ? await webStore.config(agentId) : null;
    const origin = req.headers.origin;
    const headers = { 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (cfg?.active && cfg.enabled && origin && cfg.origins.includes(origin) && await available()) {
      Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': methods,
        'Access-Control-Allow-Headers': `Content-Type, ${WEB_CONTACT_HEADER}`, 'Access-Control-Max-Age': '600' });
    }
    res.writeHead(204, headers);
    res.end();
  }

  return { caller, preflight };
}

// deps: rotas (routes.mjs), webStore (createPublicWebStore), turno = the public
// turn (createAtendimentoPublico().turno), send/fail/tooManyRequests/clientIp from the server;
// available() as in createWebCaller; afterTurn({agentId, address, result}) hears
// every turn once answered (the avatar says the reply, public-avatar.mjs).
export function registerPublicWebRoutes({ rotas, webStore, turno, send, fail, tooManyRequests, clientIp = (req) => req.socket?.remoteAddress, available = async () => true, afterTurn = null }) {
  const notFound = (res) => send(res, 404, { error: 'not_found' });
  const { caller, preflight } = createWebCaller({ webStore, clientIp, available });
  const answer = (res, c) => (c.status === 404 ? notFound(res) : send(res, c.status, { error: c.error }));

  rotas.registrar('OPTIONS', PUBLIC_WEB_PATH, (req, res, url) => preflight(req, res, url, 'GET, POST'));

  rotas.registrar('POST', PUBLIC_WEB_PATH, async (req, res, url) => {
    res.setHeader('Cache-Control', 'no-store');
    if (tooManyRequests(req, res, 'public-web', 60, 60_000)) return;
    try {
      // Any call may carry a photo, so the cap leaves room for one; the rest of the
      // body keeps WEB_BODY_MAX (checked once the photo is known).
      const read = await readSmallJson(req, WEB_BODY_MAX + WEB_IMAGE_B64_MAX + 1024);
      if (!read) return send(res, 413, { error: 'body_too_large' });
      const b = read.body;
      const c = await caller(req, res, url, b.contact);
      if (!c.address) return answer(res, c);
      if (read.size - (typeof b.image === 'string' ? Buffer.byteLength(b.image) : 0) > WEB_BODY_MAX) return send(res, 413, { error: 'body_too_large' });
      // A turn is either a typed message or a page event ({type, data?}), never both.
      const message = typeof b.message === 'string' && b.message.trim() ? b.message : null;
      if (b.event !== undefined && message) return send(res, 400, { error: 'message_or_event' });
      const event = b.event === undefined ? undefined : normalizeEvent(b.event);
      if (event === null) return send(res, 400, { error: 'invalid_event' });
      if (!message && !event) return send(res, 400, { error: 'message_required' });
      // A photo goes with a typed message. A browser call has no key, and anyone can
      // make one outside a browser, so its photo counts only as the answer to the
      // assistant's request (the turn asks the plugin, inside the contact's queue).
      let image = null;
      if (b.image !== undefined && b.image !== null) {
        if (!message) return send(res, 400, { error: 'image_needs_message' });
        const p = webImage(b.image);
        if (!p.image) return send(res, p.status, { error: p.error });
        image = p.image;
      }
      const r = await turno({ agentId: c.agentId, canal: 'web', endereco: c.address, ...(event ? { event } : { mensagem: message }),
        ...(image ? { imagens: [image], ...(c.address.startsWith('api:') ? {} : { imagesOnRequest: true }) } : {}) });
      if (r.motivo === 'inativo') return notFound(res);
      if (r.motivo === 'photo_not_requested') return send(res, 400, { error: 'image_not_requested' });
      const outputs = r.saidas || (r.text ? [{ tipo: 'texto', texto: r.text }] : []);
      send(res, 200, { ...(c.token ? { contact: c.token } : {}), text: r.text ?? null, outputs });
      if (afterTurn) Promise.resolve().then(() => afterTurn({ agentId: c.agentId, address: c.address, result: r })).catch((e) => console.error('[public-web] after turn:', e?.message ?? e));
      return;
    } catch (e) { return fail(res, 500, 'public_web_failed', e); }
  });

  rotas.registrar('GET', PUBLIC_WEB_PATH, async (req, res, url) => {
    res.setHeader('Cache-Control', 'no-store');
    if (tooManyRequests(req, res, 'public-web', 60, 60_000)) return;
    try {
      const contact = req.headers[WEB_CONTACT_HEADER.toLowerCase()];
      const c = await caller(req, res, url, contact ?? undefined);
      if (!c.address) return answer(res, c);
      if (c.fresh) return send(res, 400, { error: 'contact_required' });
      return send(res, 200, { messages: await webStore.history(c.agentId, c.address) });
    } catch (e) { return fail(res, 500, 'public_web_failed', e); }
  });
}
