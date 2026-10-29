// Talking to an assistant's avatar (step two of the avatar, avatar.mjs): the
// owner opens a live session in one of the assistant's chats, the browser
// watches the face on the RTC channel the avatar service opens (vidu.mjs),
// and each new assistant reply in that chat is spoken by the face in the
// assistant's voice. The browser never sends the text to be spoken: /speak
// reads the chat's latest reply from the database, so the face only says what
// the assistant said.
//
// The service bills every second a session is open, so a session also ends by
// itself: when nobody watches it (the events stream closed) for a while, when
// nothing was said for a while, after a maximum length, when its owner's
// minutes of the day or credit run out, when its owner opens another one, when
// the avatar changes or goes, and when the server stops. Its seconds are
// billed to the owner every minute and at the end (model LIVE_MODEL, kind
// 'avatar'), so a server that dies mid-session loses at most a minute of it.
// Logs carry the session's length and why it ended, never what was said.
//
// A visitor of a website talks to the face the same way (extensions/public-support/public-avatar.mjs):
// its sessions pass their own key, where the reply comes from, what to check
// every minute and the kind they are billed as, and the owner pays them.
import { randomUUID } from 'node:crypto';
import * as viduApi from './vidu.mjs';
import { readBody } from './http-body.mjs';
import { photoAge, EXPIRES_AFTER } from './avatar-photos.mjs';
import { spokenText, speechChunks, toFrames, sendPaced, wait } from './avatar-speech.mjs';

// Times in ms. daily: a person's talk time in 24 h; sessions: how many are
// open at once in the installation (0 = no limit, both).
export const LIMITS = { unwatched: 20e3, idle: 300e3, max: 1800e3, daily: 3600e3, sessions: 5, billEvery: 60e3 };
export const LIVE_MODEL = 'vidu-s1-live';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const event = (name, data = {}) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
// The usage kinds of an owner's talk time and of the face's speech.
const OWNER_KINDS = { live: 'avatar', speech: 'tts' };

function onProcessStop(fn) {
  process.once('SIGTERM', fn);
  process.once('SIGINT', fn);
}

// deps: vidu() → the service config or null; tts(text, voice) → {pcm, usage};
// recordUsages bills the speech and the session to the owner; hasCredit(userId)
// → whether they can still spend (what an owner's session checks every
// minute); registerAgent(agentId) registers the
// avatar's photo again when the service lost it; limits() → LIMITS, read on
// every open (the admin settings change them while the server runs).
export function createAvatarLive({ vidu, tts, recordUsages, hasCredit = async () => true, registerAgent, store, api = viduApi, limits = () => LIMITS, now = Date.now, onStop = onProcessStop, log = console.error, info = console.log }) {
  const sessions = new Map();   // id → session
  const byKey = new Map();      // key (the owner's id, or a visitor's) → their session (one each)

  const emit = (s, name, data) => { for (const res of s.watchers) res.write(event(name, data)); };
  function arm(s, timer, ms, fn) {
    clearTimeout(s.timers[timer]);
    s.timers[timer] = setTimeout(fn, ms);
    s.timers[timer].unref?.();
  }
  // Speaking counts as activity: a long speech never runs into the idle limit.
  const touch = (s) => arm(s, 'idle', s.limits.idle, () => (s.current ? touch(s) : end(s, 'idle')));

  // The seconds since the last bill, from when the service created the session.
  // → once they are recorded.
  function bill(s) {
    if (!s.billedTo) return Promise.resolve();
    const at = now();
    const seconds = Math.round((at - s.billedTo) / 1000);
    if (seconds <= 0) return Promise.resolve();
    s.billedTo += seconds * 1000;
    return Promise.resolve(recordUsages([{ model: LIVE_MODEL, in: 0, out: seconds, total: seconds }], { userId: s.userId, agentId: s.agentId, threadId: s.threadId, turnId: s.id, kind: s.kinds.live }))
      .catch((e) => log('[avatar] usage:', e?.message ?? e));
  }
  // The check runs after the minute is recorded, so one that sums what was
  // spent counts it: true goes on, false or a reason ends the session.
  function billing(s) {
    arm(s, 'bill', s.limits.billEvery, async () => {
      await bill(s);
      if (s.ended) return;
      const verdict = await s.canSpend(s).catch(() => true);
      if (s.ended) return;
      if (verdict !== true) return end(s, verdict || 'credit');
      billing(s);
    });
  }

  function end(s, reason, detail = '') {
    if (s.ended) return;
    s.ended = true;
    s.endedAt = now();
    for (const t of Object.values(s.timers)) clearTimeout(t);
    s.current?.abort();
    s.next = null;
    s.stream?.hangup();
    bill(s);
    sessions.delete(s.id);
    if (byKey.get(s.key) === s) byKey.delete(s.key);
    info(`[avatar] live ${s.liveId || '-'} agent ${s.agentId.slice(0, 8)}: ${Math.round((now() - s.started) / 1000)} s, end: ${reason}${detail ? ` (${detail})` : ''}`);
    emit(s, 'end', { reason });
    for (const res of s.watchers) res.end();
    s.watchers.clear();
    try { s.onEnd?.(s, reason); } catch (e) { log('[avatar] on end:', e?.message ?? e); }
  }

  async function start(s) {
    try {
      const config = vidu();
      if (!config) throw new Error('no VIDU_API_KEY');
      const created = await api.createSession(config, { avatarId: s.photoId });
      s.liveId = created.id;
      s.billedTo = now();
      s.stream = api.openStream(config, created.id, { onDrop: (why) => end(s, 'provider', why) });
      // Ended while the session was being created: open its stream only to hang up.
      if (s.ended) { s.stream.hangup(); bill(s); info(`[avatar] live ${created.id}: created after its end, hung up`); return; }
      billing(s);
      // The browser only knows how to watch an Agora channel.
      if (created.rtc.provider !== 'agora' || !created.rtc.token) return end(s, 'error', `rtc channel ${created.rtc.provider || 'none'}`);
      s.rtc = created.rtc;
      emit(s, 'rtc', s.rtc);
      await s.stream.ready;
      if (s.ended) return;
      s.ready = true;
      info(`[avatar] live ${s.liveId} ready in ${Math.round((now() - s.started) / 1000)} s`);
      emit(s, 'ready');
      turn(s);
    } catch (e) {
      if (e?.photoGone) {
        registerAgent(s.agentId);
        return end(s, 'avatar_not_ready', e.message);
      }
      end(s, 'error', e?.message ?? String(e));
    }
  }

  // One speech at a time: the next one starts when the current one has played.
  function turn(s) {
    if (!s.next || s.current || s.ended || !s.ready) return;
    const markdown = s.next;
    s.next = null;
    const cut = s.current = new AbortController();
    say(s, markdown, cut.signal)
      .catch((e) => {
        if (cut.signal.aborted) return;
        log(`[avatar] live ${s.liveId}: speech failed:`, e?.message ?? e);
        emit(s, 'error', { code: 'speech' });
      })
      .finally(() => {
        if (s.current === cut) s.current = null;
        if (!s.ended) { touch(s); turn(s); }
      });
  }

  async function speech(s, text) {
    const { pcm, usage } = await tts(text, s.voice);
    Promise.resolve(recordUsages([usage], { userId: s.userId, agentId: s.agentId, turnId: randomUUID(), kind: s.kinds.speech })).catch((e) => log('[avatar] usage:', e?.message ?? e));
    return pcm;
  }

  // The reply is made into speech a few sentences at a time; the next piece is
  // made while the current one plays.
  async function say(s, markdown, signal) {
    const chunks = speechChunks(spokenText(markdown));
    if (!chunks.length) return;
    s.stream.reply(chunks.join(' '));
    let playsUntil = 0;
    let next = speech(s, chunks[0]);
    for (let i = 0; i < chunks.length; i++) {
      const pcm = await next;
      if (signal.aborted) return;
      next = i + 1 < chunks.length ? speech(s, chunks[i + 1]) : null;
      next?.catch(() => {});
      playsUntil = await sendPaced(toFrames(pcm), (frame) => s.stream.audio(frame), { signal, startAt: playsUntil, now });
    }
    await wait(playsUntil - now(), signal);
  }

  const live = {
    // Opening again the session already open for the same chat returns it.
    // usedToday: the owner's talk time in the last 24 h, in ms. Throws
    // {code: 'daily'} when it is all used, {code: 'busy'} when the installation
    // has its most sessions open, or the group its groupMax.
    // A visitor's session (extensions/public-support/public-avatar.mjs) also passes: key, one session per
    // key; reply(s) → the latest {id, content} to say; canSpend(s) → true, or
    // why it ends; kinds, how its talk time and speech are billed; left, its
    // talk time in ms instead of the daily one; onEnd(s, reason); meta, its own.
    open({ userId, agentId, threadId = null, photoId, voice, lastReplyId = null, usedToday = 0,
      key = userId, reply = null, canSpend = null, kinds = OWNER_KINDS, left = null, group = null, groupMax = 0, onEnd = null, meta = {} }) {
      const current = byKey.get(key);
      if (current?.agentId === agentId && current.threadId === threadId) return current;
      const lim = { ...LIMITS, ...limits() };
      left ??= lim.daily ? lim.daily - usedToday : Infinity;
      if (left < 60e3) throw Object.assign(new Error('avatar: no talk time left today'), { code: 'daily' });
      const others = [...sessions.values()].filter((o) => o !== current);
      if (lim.sessions && others.length >= lim.sessions) throw Object.assign(new Error('avatar: too many sessions open'), { code: 'busy' });
      if (group && groupMax && others.filter((o) => o.group === group).length >= groupMax) throw Object.assign(new Error('avatar: too many sessions open'), { code: 'busy' });
      if (current) end(current, 'replaced');
      const s = {
        id: randomUUID(), key, userId, agentId, threadId, photoId, voice, lastReplyId, limits: lim, kinds, group, meta, onEnd,
        reply: reply || (() => store.latestReply(threadId, userId)),
        canSpend: canSpend || (async () => (await hasCredit(userId)) || 'credit'),
        liveId: '', started: now(), endedAt: 0, billedTo: 0, ended: false, ready: false, rtc: null, stream: null,
        watchers: new Set(), timers: {}, current: null, next: null,
      };
      sessions.set(s.id, s);
      byKey.set(key, s);
      arm(s, 'max', Math.min(lim.max, left), () => end(s, lim.max <= left ? 'max' : 'daily'));
      arm(s, 'unwatched', lim.unwatched, () => end(s, 'unwatched'));
      touch(s);
      start(s);
      return s;
    },

    get: (id) => sessions.get(id) || null,

    // The events stream: rtc (the way into the channel), ready, error, end.
    watch(s, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.write(': open\n\n');
      s.watchers.add(res);
      clearTimeout(s.timers.unwatched);
      if (s.rtc) res.write(event('rtc', s.rtc));
      if (s.ready) res.write(event('ready'));
      const beat = setInterval(() => res.write(': ping\n\n'), 20e3);
      beat.unref?.();
      res.on('close', () => {
        clearInterval(beat);
        s.watchers.delete(res);
        if (!s.watchers.size && !s.ended) arm(s, 'unwatched', s.limits.unwatched, () => end(s, 'unwatched'));
      });
    },

    // Queues the chat's latest assistant reply, if it is newer than the last
    // one queued. A reply arriving mid-speech waits for it; of several waiting,
    // only the latest is said. → whether one was queued.
    async speak(s) {
      const reply = await s.reply(s);
      if (!reply || s.ended || (s.lastReplyId != null && BigInt(reply.id) <= BigInt(s.lastReplyId))) return false;
      s.lastReplyId = reply.id;
      s.next = reply.content;
      touch(s);
      turn(s);
      return true;
    },

    hush(s) {
      s.current?.abort();
      s.next = null;
      s.stream?.cut();
      touch(s);
    },

    end,
    endWhere(match, reason) { for (const s of [...sessions.values()]) if (match(s)) end(s, reason); },
    where: (match) => [...sessions.values()].filter(match),
    // Whether a live session uses this provider photo (the sweep does not renew it then).
    holds: (photoId) => [...sessions.values()].some((s) => s.photoId === photoId),
  };
  // A server that stops hangs up its sessions, or they keep billing.
  onStop(() => live.endWhere(() => true, 'shutdown'));
  return live;
}

// deps: owned(ctx, res, agentId) → the user, or null after answering;
// getThreadOwned(threadId, userId); voiceOf(row) → the voice to speak with;
// hasCredit(userId) → whether they can still spend.
export function registerAvatarLive(rotas, { live, store, send, fail, owned, getThreadOwned, registerAgent, available, voiceOf, hasCredit }) {
  rotas.registrar('POST', '/api/agent/avatar/live', async (req, res, url, ctx) => {
    if (!available()) return send(res, 503, { error: 'server.avatar_unavailable' });
    const body = await readBody(req).catch(() => ({}));
    const agentId = String(body.agentId || '');
    const threadId = String(body.threadId || '');
    const user = await owned(ctx, res, agentId);
    if (!user) return;
    try {
      const thread = UUID.test(threadId) && await getThreadOwned(threadId, user.id);
      if (!thread || thread.agent_id !== agentId) return send(res, 404, { error: 'server.chat_not_found_reload_page' });
      const row = await store.get(agentId, user.id);
      if (!row) return send(res, 404, { error: 'server.avatar_not_found' });
      if (row.provider_status !== 'ready' || !row.provider_photo_id) return send(res, 409, { error: 'server.avatar_not_ready' });
      // Close to the service's 90 days: renewed first, the next try opens.
      if (photoAge(row.provider_photo_created_at) > EXPIRES_AFTER) {
        registerAgent(agentId);
        return send(res, 409, { error: 'server.avatar_not_ready' });
      }
      if (!(await hasCredit(user.id))) return send(res, 402, { error: 'server.avatar_no_credit' });
      const latest = await store.latestReply(threadId, user.id);
      const usedToday = (await store.liveSecondsSince(user.id, new Date(Date.now() - 24 * 3600e3))) * 1000;
      const s = live.open({ userId: user.id, agentId, threadId, photoId: row.provider_photo_id, voice: voiceOf(row), lastReplyId: latest?.id ?? null, usedToday });
      return send(res, 200, { id: s.id });
    } catch (e) {
      if (e?.code === 'daily') return send(res, 429, { error: 'server.avatar_daily_limit' });
      if (e?.code === 'busy') return send(res, 503, { error: 'server.avatar_busy' });
      return fail(res, 500, 'server.avatar_live_failed', e);
    }
  });

  async function mine(ctx, res, id) {
    const user = await ctx.currentUser();
    if (!user) { send(res, 401, { error: 'server.log_in_first' }); return null; }
    const s = live.get(String(id || ''));
    if (!s || s.userId !== user.id) { send(res, 404, { error: 'server.avatar_live_not_found' }); return null; }
    return s;
  }

  rotas.registrar('GET', '/api/agent/avatar/live/events', async (req, res, url, ctx) => {
    const s = await mine(ctx, res, url.searchParams.get('id'));
    if (s) live.watch(s, res);
  });

  rotas.registrar('POST', '/api/agent/avatar/live/speak', async (req, res, url, ctx) => {
    const body = await readBody(req).catch(() => ({}));
    const s = await mine(ctx, res, body.id);
    if (!s) return;
    try {
      return send(res, 200, { ok: true, queued: await live.speak(s) });
    } catch (e) {
      return fail(res, 500, 'server.avatar_live_failed', e);
    }
  });

  rotas.registrar('POST', '/api/agent/avatar/live/hush', async (req, res, url, ctx) => {
    const body = await readBody(req).catch(() => ({}));
    const s = await mine(ctx, res, body.id);
    if (!s) return;
    live.hush(s);
    return send(res, 200, { ok: true });
  });

  rotas.registrar('DELETE', '/api/agent/avatar/live', async (req, res, url, ctx) => {
    const s = await mine(ctx, res, url.searchParams.get('id'));
    if (!s) return;
    live.end(s, 'hangup');
    return send(res, 200, { ok: true });
  });
}
