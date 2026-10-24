// A website's visitor talks to the assistant's avatar (avatar.mjs,
// avatar-live.mjs): the site opens a live session for one of its public
// contacts (public-web.mjs), the visitor's browser watches the face on the RTC
// channel (public/public-avatar.js), and each new public-support reply to that
// contact is said by the face. As in the owner's chat, nobody sends the text
// to be spoken: the face says the contact's latest reply from the database.
//
// The owner turns it on per assistant in /public-support and pays for it like
// the rest of public support: its seconds and its speech are billed as kind
// 'publico', so they count in the assistant's daily cap. A session ends within
// a minute when the owner's credit runs out, the cap is reached, the
// assistant's minutes of the day are used, the contact stops or is blocked, or
// public support, the web channel or the avatar goes off. A visitor has their
// own minutes per 24 h, counted by contact and, from a browser, by IP too (a
// new contact token costs one message); those are kept in memory, so a
// restart forgets them.
//
// No cookie here, as on the messages path: a browser call must come from a
// listed origin. Opening names the contact; watching, hushing and ending take
// the session id, which only whoever opened it gets.
import { readSmallJson, createWebCaller } from './public-web.mjs';
import { chaveDoContato, DAILY_CAP_DEFAULT_USD, AVATAR_MINUTES_MAX, AVATAR_SESSIONS_MAX } from './public-support.mjs';
import { LIVE_MODEL } from './avatar-live.mjs';
import { photoAge, EXPIRES_AFTER } from './avatar-photos.mjs';
import { defaultTimezone } from './locale.mjs';

export const PUBLIC_AVATAR_PATH = '/api/public/avatar';
export const PUBLIC_AVATAR_PATHS = new Set([PUBLIC_AVATAR_PATH, `${PUBLIC_AVATAR_PATH}/hush`, `${PUBLIC_AVATAR_PATH}/end`]);
const PUBLIC_KINDS = { live: 'publico', speech: 'publico' };
const BODY_MAX = 4096;
const DAY = 24 * 3600e3;
// What a turn's motivo (public-support.mjs) does to the contact's face.
const STOPS = new Set(['parado', 'apagado', 'bloqueado']);
const UNAVAILABLE = new Set(['sem_saldo', 'teto_diario']);

// What the face says of a reply: its text and the text that goes with a
// button; images, links and the rest stay on the page.
export function spokenReply(row) {
  if (!Array.isArray(row?.outputs)) return row?.content || '';
  return row.outputs.filter((o) => (o?.tipo === 'texto' || o?.tipo === 'botao') && typeof o.texto === 'string').map((o) => o.texto).join('\n\n');
}

const whole = (v, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : undefined);

// Owner form → fields, same contract as camposDaConfig: {campos} or {erro}.
export function avatarFieldsFromBody(b = {}) {
  const c = {};
  if (b.avatarEnabled !== undefined) {
    if (typeof b.avatarEnabled !== 'boolean') return { erro: 'server.public_avatar_enabled_invalid' };
    c.enabled = b.avatarEnabled;
  }
  for (const [from, to] of [['avatarDailyMinutes', 'dailyMinutes'], ['avatarVisitorMinutes', 'visitorMinutes']]) {
    if (b[from] === undefined) continue;
    c[to] = whole(b[from], AVATAR_MINUTES_MAX);
    if (c[to] === undefined) return { erro: 'server.public_avatar_minutes_invalid' };
  }
  if (b.avatarMaxSessions !== undefined) {
    c.maxSessions = whole(b.avatarMaxSessions, AVATAR_SESSIONS_MAX);
    if (c.maxSessions === undefined) return { erro: 'server.public_avatar_sessions_invalid' };
  }
  return { campos: c };
}

// What the owner's screen gets.
export const avatarView = (r) => ({ avatarEnabled: r.avatar_enabled, avatarDailyMinutes: r.avatar_daily_minutes,
  avatarVisitorMinutes: r.avatar_visitor_minutes, avatarMaxSessions: r.avatar_max_sessions });

export function createPublicAvatarStore(pool, { S = 'mtr_harness', fuso = defaultTimezone() } = {}) {
  return {
    async config(agentId) {
      const { rows: [r] } = await pool.query(
        `SELECT p.user_id, p.ativo, p.web_enabled, p.avatar_enabled, p.avatar_daily_minutes, p.avatar_visitor_minutes, p.avatar_max_sessions,
                coalesce(p.teto_diario_usd, ${DAILY_CAP_DEFAULT_USD})::float AS cap
           FROM ${S}.public_agents p JOIN ${S}.agents a ON a.id = p.agent_id AND a.user_id = p.user_id
          WHERE p.agent_id = $1 AND a.archived_at IS NULL`, [agentId]);
      return r ? { userId: r.user_id, enabled: r.avatar_enabled, on: r.ativo && r.web_enabled && r.avatar_enabled, cap: r.cap,
        dailyMinutes: r.avatar_daily_minutes, visitorMinutes: r.avatar_visitor_minutes, maxSessions: r.avatar_max_sessions } : null;
    },

    // Only the owner, and only an assistant already configured for public support.
    async configure(agentId, userId, { enabled, dailyMinutes, visitorMinutes, maxSessions } = {}) {
      const { rows } = await pool.query(
        `UPDATE ${S}.public_agents SET avatar_enabled = coalesce($3, avatar_enabled), avatar_daily_minutes = coalesce($4, avatar_daily_minutes),
                avatar_visitor_minutes = coalesce($5, avatar_visitor_minutes), avatar_max_sessions = coalesce($6, avatar_max_sessions), atualizado_em = now()
          WHERE agent_id = $1 AND user_id = $2 RETURNING avatar_enabled, avatar_daily_minutes, avatar_visitor_minutes, avatar_max_sessions`,
        [agentId, userId, enabled ?? null, dailyMinutes ?? null, visitorMinutes ?? null, maxSessions ?? null]);
      return rows[0] || null;
    },

    // The web contact, WITHOUT creating it.
    async contact(agentId, address) {
      const { rows: [r] } = await pool.query(
        `SELECT id, parado_em, bloqueado_em FROM ${S}.public_contacts WHERE agent_id = $1 AND canal = 'web' AND chave = $2`,
        [agentId, chaveDoContato('web', address)]);
      return r ? { id: r.id, stopped: !!r.parado_em, blocked: !!r.bloqueado_em } : null;
    },

    latestReply: async (contactId) => (await pool.query(
      `SELECT id, content, outputs FROM ${S}.public_messages WHERE contact_id = $1 AND role = 'assistant' ORDER BY id DESC LIMIT 1`,
      [contactId])).rows[0] || null,

    // The assistant's face time with visitors since midnight (timezone), in seconds.
    async secondsToday(agentId) {
      const { rows } = await pool.query(
        `SELECT coalesce(sum(tok_out), 0)::float AS s FROM ${S}.usage_events
          WHERE agent_id = $1 AND kind = 'publico' AND model = $3
            AND ts >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`, [agentId, fuso, LIVE_MODEL]);
      return rows[0].s;
    },
  };
}

// deps: rotas; avatar = what registerAvatar returns (live, store, voiceOf,
// available, registerAgent); store = the public-support store (its gastoDoDia);
// webStore and avatarStore; creditStatus(userId) from the server;
// send/fail/tooManyRequests/clientIp; available() as in createWebCaller.
// → what the messages path and the owner's routes call.
export function registerPublicAvatar({ rotas, avatar, store, webStore, avatarStore, creditStatus, send, fail, tooManyRequests,
  clientIp = (req) => req.socket?.remoteAddress, available = async () => true, now = Date.now }) {
  const { live } = avatar;
  const { caller, preflight } = createWebCaller({ webStore, clientIp, available });
  const answer = (res, c) => send(res, c.status, { error: c.error || 'not_found' });
  const keyOf = (agentId, address) => `public:${agentId}:${address}`;

  // Visitors' ended sessions in the last 24 h, in the order they ended.
  const spent = [];
  function used(agentId, field, value) {
    const since = now() - DAY;
    while (spent.length && spent[0].to < since) spent.shift();
    let ms = 0;
    for (const e of spent) if (e.agentId === agentId && e[field] === value) ms += e.to - Math.max(e.from, since);
    for (const s of live.where((x) => x.meta.public && x.agentId === agentId && x.meta[field] === value)) ms += now() - Math.max(s.started, since);
    return ms;
  }
  const ended = (s) => spent.push({ agentId: s.agentId, address: s.meta.address, ip: s.meta.ip, from: s.started, to: s.endedAt });

  // Talk time left in ms: the assistant's of the day and the visitor's.
  async function left(agentId, cfg, address, ip) {
    const day = cfg.dailyMinutes * 60e3 - (await avatarStore.secondsToday(agentId)) * 1000;
    const visitor = cfg.visitorMinutes * 60e3 - Math.max(used(agentId, 'address', address), ip ? used(agentId, 'ip', ip) : 0);
    return Math.min(day, visitor);
  }
  async function canPay(agentId, cfg) {
    const credit = await creditStatus(cfg.userId);
    return !!credit && credit.over === false && (await store.gastoDoDia(agentId)) < cfg.cap;
  }
  // Every minute of a session: true, or why it ends.
  async function stillOn(s) {
    if (!avatar.available() || !(await available())) return 'unavailable';
    const cfg = await avatarStore.config(s.agentId);
    if (!cfg?.on) return 'unavailable';
    const contact = await avatarStore.contact(s.agentId, s.meta.address);
    if (!contact || contact.id !== s.meta.contactId || contact.stopped || contact.blocked) return 'stopped';
    if (!(await canPay(s.agentId, cfg))) return 'unavailable';
    if ((await left(s.agentId, cfg, s.meta.address, s.meta.ip)) <= 0) return 'daily';
    return true;
  }

  for (const path of PUBLIC_AVATAR_PATHS) rotas.registrar('OPTIONS', path, (req, res, url) => preflight(req, res, url, 'POST'));

  // Body {contact, sayLatest?}: sayLatest = the face first says the reply already on the page.
  rotas.registrar('POST', PUBLIC_AVATAR_PATH, async (req, res, url) => {
    res.setHeader('Cache-Control', 'no-store');
    if (tooManyRequests(req, res, 'public-avatar', 10, 60_000)) return;
    try {
      const read = await readSmallJson(req, BODY_MAX);
      if (!read) return send(res, 413, { error: 'body_too_large' });
      const b = read.body;
      const c = await caller(req, res, url, b.contact);
      if (!c.address) return answer(res, c);
      if (c.fresh) return send(res, 400, { error: 'contact_required' });
      if (!avatar.available()) return send(res, 503, { error: 'avatar_unavailable' });
      const cfg = await avatarStore.config(c.agentId);
      if (!cfg?.enabled) return send(res, 403, { error: 'avatar_disabled' });
      const face = await avatar.store.get(c.agentId, cfg.userId);
      if (face?.provider_status !== 'ready' || !face.provider_photo_id) return send(res, 409, { error: 'avatar_not_ready' });
      // Close to the service's 90 days: renewed first, a later try opens.
      if (photoAge(face.provider_photo_created_at) > EXPIRES_AFTER) {
        avatar.registerAgent(c.agentId);
        return send(res, 409, { error: 'avatar_not_ready' });
      }
      const contact = await avatarStore.contact(c.agentId, c.address);
      if (!contact) return send(res, 409, { error: 'message_first' });
      if (contact.stopped || contact.blocked) return send(res, 403, { error: 'contact_stopped' });
      if (!(await canPay(c.agentId, cfg))) return send(res, 503, { error: 'unavailable' });
      // A server calls for all its visitors from one address.
      const ip = c.address.startsWith('browser:') ? String(clientIp(req) || '') || null : null;
      const latest = await avatarStore.latestReply(contact.id);
      const s = live.open({
        key: keyOf(c.agentId, c.address), userId: cfg.userId, agentId: c.agentId, photoId: face.provider_photo_id, voice: avatar.voiceOf(face),
        lastReplyId: b.sayLatest === true ? null : latest?.id ?? null, left: await left(c.agentId, cfg, c.address, ip),
        group: `public:${c.agentId}`, groupMax: cfg.maxSessions, kinds: PUBLIC_KINDS, canSpend: stillOn, onEnd: ended,
        reply: async () => { const r = await avatarStore.latestReply(contact.id); return r && { id: r.id, content: spokenReply(r) }; },
        meta: { public: true, contactId: contact.id, address: c.address, ip },
      });
      if (b.sayLatest === true) await live.speak(s);
      return send(res, 200, { id: s.id });
    } catch (e) {
      if (e?.code === 'daily') return send(res, 429, { error: 'avatar_daily_limit' });
      if (e?.code === 'busy') return send(res, 503, { error: 'avatar_busy' });
      return fail(res, 500, 'public_avatar_failed', e);
    }
  });

  // A visitor's session of this agent; from a browser, only on a listed origin.
  async function session(req, res, url, id) {
    const agentId = String(url.searchParams.get('agent') || '');
    const s = live.get(String(id || ''));
    if (!s?.meta.public || s.agentId !== agentId) { send(res, 404, { error: 'session_not_found' }); return null; }
    const origin = req.headers.origin;
    if (origin) {
      if (!(await webStore.config(agentId))?.origins.includes(origin)) { send(res, 403, { error: 'origin_not_allowed' }); return null; }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    return s;
  }
  const byBody = (path, act) => rotas.registrar('POST', path, async (req, res, url) => {
    res.setHeader('Cache-Control', 'no-store');
    if (tooManyRequests(req, res, 'public-web', 60, 60_000)) return;
    try {
      const read = await readSmallJson(req, BODY_MAX);
      if (!read) return send(res, 413, { error: 'body_too_large' });
      const s = await session(req, res, url, read.body.id);
      if (!s) return;
      act(s);
      return send(res, 200, { ok: true });
    } catch (e) { return fail(res, 500, 'public_avatar_failed', e); }
  });

  // The events stream: rtc (the way into the channel), ready, error, end.
  rotas.registrar('GET', `${PUBLIC_AVATAR_PATH}/events`, async (req, res, url) => {
    if (tooManyRequests(req, res, 'public-web', 60, 60_000)) return;
    try {
      const s = await session(req, res, url, url.searchParams.get('id'));
      if (s) live.watch(s, res);
    } catch (e) { return fail(res, 500, 'public_avatar_failed', e); }
  });
  // The visitor started to speak: the face stops.
  byBody(`${PUBLIC_AVATAR_PATH}/hush`, (s) => live.hush(s));
  // Also the beacon of a page that closes (a text/plain body).
  byBody(`${PUBLIC_AVATAR_PATH}/end`, (s) => live.end(s, 'hangup'));

  const sessionsOf = (agentId) => live.where((s) => s.meta.public && s.agentId === agentId);
  return {
    // After a turn on the messages path: the contact's face says the reply, or ends.
    afterTurn({ agentId, address, result }) {
      const [s] = live.where((x) => x.key === keyOf(agentId, address));
      if (!s) return;
      if (STOPS.has(result?.motivo)) return live.end(s, 'stopped');
      if (UNAVAILABLE.has(result?.motivo)) return live.end(s, 'unavailable');
      return live.speak(s);
    },
    // For the owner's screen (public-support-owner.mjs).
    available: () => avatar.available(),
    fields: avatarFieldsFromBody,
    view: avatarView,
    configure: (agentId, userId, campos) => avatarStore.configure(agentId, userId, campos),
    face: async (agentId, userId) => (await avatar.store.get(agentId, userId))?.provider_status ?? null,
    // The owner saved: sessions the new settings no longer allow end now, the rest within a minute.
    async agentChanged(agentId) {
      for (const s of sessionsOf(agentId)) {
        const verdict = await stillOn(s).catch(() => true);
        if (verdict !== true) live.end(s, verdict);
      }
    },
    contactClosed: (contactId) => live.endWhere((s) => s.meta.public && s.meta.contactId === contactId, 'stopped'),
  };
}
