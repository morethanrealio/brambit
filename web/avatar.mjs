// An assistant's avatar: the owner gives it a face photo, says whose face it
// is and picks the ready-made voice it speaks with (assistant settings,
// avatar-settings.js); the photo is registered at the avatar service
// (vidu.mjs) and kept alive there (avatar-photos.mjs). Talking to the avatar
// is avatar-live.mjs. The settings card only shows when the installation has
// the avatar service (VIDU_API_KEY) and a speech provider (audio-provider.mjs).
import { createHash, randomUUID } from 'node:crypto';
import { readBody } from './http-body.mjs';
import { pool, S, getAgentOwned, getThreadOwned } from './db.mjs';
import { sniffImagem } from './image-sniff.mjs';
import { audioProvider } from './audio-provider.mjs';
import { synthesizeSpeech, synthesizePcm } from './media.mjs';
import { productI18n } from './i18n.mjs';
import { readyVoices, defaultVoice, isReadyVoice } from './tts-voices.mjs';
import { viduConfig, deletePhoto } from './vidu.mjs';
import { registerReadyPhoto, registrationError, RENEW_AFTER } from './avatar-photos.mjs';
import { CONSENTS, avatarSchema, createAvatarStore } from './avatar-store.mjs';
import { createAvatarLive, registerAvatarLive, LIMITS } from './avatar-live.mjs';

export { avatarSchema };

const MAX_PHOTO = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWEEP_EVERY = 6 * 3600e3;
const STUCK_AFTER = 10 * 60e3;
const RETRYABLE = new Set(['provider_unavailable', 'photo_not_ready']);

export const avatarAvailable = () => !!viduConfig() && !!audioProvider();

// The browser watches the face on an Agora channel (avatar-live.js, with the
// Agora Web SDK in vendor/): the page may connect to Agora's servers, which
// use ports other than 443, only while the installation has the avatar.
const AGORA = ['https://*.agora.io:*', 'wss://*.agora.io:*', 'https://*.sd-rtn.com:*', 'wss://*.sd-rtn.com:*'];
export const avatarCsp = () => (avatarAvailable() ? { 'connect-src': AGORA } : {});

// The limits an installation sets (.env.example), read on every session.
export function avatarLimits() {
  const number = (v) => Number(String(v ?? '').trim() || NaN);
  const minutes = (v, fallback, { zero = false } = {}) => {
    const n = number(v);
    return Number.isFinite(n) && (n > 0 || (zero && n === 0)) ? n * 60e3 : fallback;
  };
  const sessions = number(process.env.BRAMBIT_AVATAR_MAX_SESSIONS);
  return {
    max: minutes(process.env.BRAMBIT_AVATAR_SESSION_MINUTES, LIMITS.max),
    daily: minutes(process.env.BRAMBIT_AVATAR_DAILY_MINUTES, LIMITS.daily, { zero: true }),
    sessions: Number.isInteger(sessions) && sessions >= 0 ? sessions : LIMITS.sessions,
  };
}

const voiceOf = (row, provider = audioProvider()) => (isReadyVoice(provider, row.voice) ? row.voice : defaultVoice(provider));

// What the settings screen gets about an avatar (never the photo bytes).
function view(row, provider) {
  if (!row) return null;
  return {
    photoUrl: `/api/agent/avatar/photo?agentId=${row.agent_id}&v=${row.photo_sha256.slice(0, 12)}`,
    consent: row.consent,
    voice: voiceOf(row, provider),
    status: row.provider_status,
    error: row.provider_error,
    updatedAt: row.updated_at,
  };
}

// deps: {eventos, send, fail, recordUsages, getCreditStatus} from the server;
// store, vidu and register are swappable for tests.
export function registerAvatar(rotas, { eventos, send, fail, recordUsages, getCreditStatus, store = createAvatarStore({ pool, S }), vidu = viduConfig, register = registerReadyPhoto, log = console.error }) {
  const hasCredit = async (userId) => !(await getCreditStatus(userId))?.over;
  // Deletes a photo at Vidu, which would delete it itself within 90 days. → whether it did.
  async function deleteAtVidu(id) {
    const config = vidu();
    if (!config) { log(`[avatar] no VIDU_API_KEY: photo ${id} stays at Vidu until it expires`); return false; }
    return deletePhoto(config, id).then(() => true, (e) => { log(`[avatar] could not delete photo ${id} at Vidu:`, e?.message ?? e); return false; });
  }
  // The provider photos no avatar holds anymore leave Vidu.
  async function release(ids) {
    for (const id of [].concat(ids).filter(Boolean)) if (!(await store.held(id))) await deleteAtVidu(id);
  }

  // Registers the agent's current photo. If the photo changed meanwhile, the
  // new registration is nobody's and leaves (the save already queued another).
  async function registerOnce(agentId) {
    const config = vidu();
    const row = config && await store.forRegistration(agentId);
    if (!row) return;
    const sha = row.photo_sha256;
    await store.markRegistering(agentId, sha);
    try {
      const done = await register({ vidu: config, image: `data:${row.photo_mime};base64,${row.photo.toString('base64')}`, name: `brambit-avatar-${agentId.slice(0, 8)}`, log });
      if (!(await store.markReady(sha, done))) await release(done.id);
    } catch (e) {
      const code = registrationError(e);
      log(`[avatar] agent ${agentId}: photo not registered (${code}):`, e?.message ?? e);
      await store.markFailed(agentId, sha, code, { retry: RETRYABLE.has(code) });
    }
  }
  // One registration per agent at a time; a save during it runs it again after.
  const running = new Map(), again = new Set();
  function registerAgent(agentId) {
    if (running.has(agentId)) { again.add(agentId); return running.get(agentId); }
    const job = registerOnce(agentId)
      .catch((e) => log(`[avatar] agent ${agentId}:`, e?.message ?? e))
      .finally(() => { running.delete(agentId); if (again.delete(agentId)) registerAgent(agentId); });
    running.set(agentId, job);
    return job;
  }

  // Every 6 h: forget avatars of deleted assistants, retry registrations that
  // stopped halfway, and register again the photos close to Vidu's 90 days.
  async function sweep() {
    const config = vidu();
    if (!config) return;
    await release(await store.dropArchived());
    for (const agentId of await store.stuck(STUCK_AFTER)) if (!running.has(agentId)) await registerAgent(agentId);
    for (const row of await store.aging(new Date(Date.now() - RENEW_AFTER))) {
      if (live.holds(row.provider_photo_id)) continue;   // not renewed under a live session
      try {
        const done = await register({ vidu: config, image: `data:${row.photo_mime};base64,${row.photo.toString('base64')}`, name: 'brambit-avatar', log });
        await store.markReady(row.photo_sha256, { ...done, discarded: [row.provider_photo_id, ...done.discarded] });
      } catch (e) {
        log(`[avatar] could not renew photo ${row.provider_photo_id}:`, e?.message ?? e);
      }
    }
  }
  const live = createAvatarLive({ vidu, tts: synthesizePcm, recordUsages, hasCredit, registerAgent, store, limits: avatarLimits, log });
  eventos.agendar({ nome: 'avatar-photos', primeiraEmMs: 2 * 60e3, aCadaMs: SWEEP_EVERY, rodar: sweep });

  // The account is about to be destroyed: its photos leave Vidu too (the rows go with the CASCADE).
  eventos.inscrever('exclusao_final', async ({ userId }) => {
    live.endWhere((s) => s.userId === userId, 'account_deleted');
    for (const id of await store.ownPhotos(userId)) await deleteAtVidu(id);
  });

  async function owned(ctx, res, agentId, { archived = false } = {}) {
    const user = await ctx.currentUser();
    if (!user) { send(res, 401, { error: 'server.log_in_first' }); return null; }
    if (!agentId) { send(res, 400, { error: 'server.enter_agent' }); return null; }
    const agent = UUID.test(agentId) && await getAgentOwned(agentId, user.id, { incluirArquivado: archived });
    if (!agent) { send(res, 404, { error: 'server.assistant_not_found' }); return null; }
    return user;
  }

  rotas.registrar('GET', '/api/agent/avatar', async (req, res, url, ctx) => {
    if (!avatarAvailable()) return send(res, 200, { available: false });
    const agentId = url.searchParams.get('agentId') || '';
    const user = await owned(ctx, res, agentId);
    if (!user) return;
    const provider = audioProvider();
    try {
      return send(res, 200, { available: true, voices: readyVoices(provider), defaultVoice: defaultVoice(provider), avatar: view(await store.get(agentId, user.id), provider) });
    } catch (e) {
      return fail(res, 500, 'server.avatar_failed_load', e);
    }
  });

  rotas.registrar('POST', '/api/agent/avatar', async (req, res, url, ctx) => {
    if (!avatarAvailable()) return send(res, 503, { error: 'server.avatar_unavailable' });
    const body = await readBody(req).catch(() => ({}));
    const agentId = String(body.agentId || '');
    const user = await owned(ctx, res, agentId);
    if (!user) return;
    const provider = audioProvider();
    if (!CONSENTS.includes(body.consent)) return send(res, 400, { error: 'server.avatar_consent_required' });
    if (!isReadyVoice(provider, body.voice)) return send(res, 400, { error: 'server.avatar_voice_invalid' });
    let photo = null;
    if (body.photo) {
      const buffer = Buffer.from(String(body.photo.data || ''), 'base64');
      if (!buffer.length) return send(res, 400, { error: 'server.could_not_read_image' });
      if (buffer.length > MAX_PHOTO) return send(res, 413, { error: 'server.image_too_large' });
      // The settings screen always sends a JPEG it resized; Vidu is only known to take JPEG.
      if (sniffImagem(buffer)?.mime !== 'image/jpeg') return send(res, 400, { error: 'server.avatar_photo_jpeg' });
      photo = { buffer, mime: 'image/jpeg', sha256: createHash('sha256').update(buffer).digest('hex') };
    }
    try {
      const saved = await store.save({ agentId, userId: user.id, photo, consent: body.consent, voice: body.voice });
      if (!saved) return send(res, 400, { error: 'server.avatar_photo_required' });
      live.endWhere((s) => s.agentId === agentId, 'changed');
      if (saved.released) release(saved.released).catch((e) => log('[avatar] release:', e?.message ?? e));
      if (saved.register) registerAgent(agentId);
      return send(res, 200, { ok: true, avatar: view(saved.row, provider) });
    } catch (e) {
      return fail(res, 500, 'server.avatar_failed_save', e);
    }
  });

  // Deleting the avatar deletes the photo at Vidu right away; `providerDeleted`
  // false = Vidu did not answer, and it deletes the photo itself within 90 days.
  rotas.registrar('DELETE', '/api/agent/avatar', async (req, res, url, ctx) => {
    const agentId = url.searchParams.get('agentId') || '';
    const user = await owned(ctx, res, agentId, { archived: true });
    if (!user) return;
    try {
      live.endWhere((s) => s.agentId === agentId, 'removed');
      const id = await store.remove(agentId, user.id);
      const providerDeleted = !id || (await store.held(id)) || (await deleteAtVidu(id));
      return send(res, 200, { ok: true, providerDeleted });
    } catch (e) {
      return fail(res, 500, 'server.avatar_failed_remove', e);
    }
  });

  // The photo, only to its owner.
  rotas.registrar('GET', '/api/agent/avatar/photo', async (req, res, url, ctx) => {
    const agentId = url.searchParams.get('agentId') || '';
    const user = await owned(ctx, res, agentId);
    if (!user) return;
    const row = await store.photo(agentId, user.id).catch(() => null);
    if (!row) return send(res, 404, { error: 'server.avatar_not_found' });
    res.writeHead(200, { 'content-type': row.photo_mime, 'cache-control': 'private, no-store' });
    res.end(row.photo);
  });

  // A sentence in the chosen voice, in the page's language, to hear it before
  // picking. Served from here because the page's policy plays no blob: audio.
  // Kept in memory per voice and language (30 voices × 3 languages at most),
  // and paid by the installation, not the person.
  const samples = new Map();
  rotas.registrar('GET', '/api/agent/avatar/voice-sample', async (req, res, url, ctx) => {
    const user = await ctx.currentUser();
    if (!user) return send(res, 401, { error: 'server.log_in_first' });
    const provider = audioProvider();
    if (!provider) return send(res, 503, { error: 'server.avatar_unavailable' });
    const voice = url.searchParams.get('voice') || '';
    if (!isReadyVoice(provider, voice)) return send(res, 400, { error: 'server.avatar_voice_invalid' });
    const language = res.idiomaResposta;
    const key = `${provider}:${voice}:${language}`;
    if (!samples.has(key)) {
      samples.set(key, synthesizeSpeech(productI18n().t('avatar.voice_sample', language), voice).then((speech) => {
        recordUsages([speech.usage], { userId: user.id, turnId: randomUUID(), kind: 'tts' }, { noBill: true });
        return speech;
      }));
    }
    try {
      const { buffer, mime } = await samples.get(key);
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'private, max-age=86400' });
      res.end(buffer);
    } catch (e) {
      samples.delete(key);
      return fail(res, 502, 'server.avatar_voice_sample_failed', e);
    }
  });

  registerAvatarLive(rotas, { live, store, send, fail, owned, getThreadOwned, registerAgent, available: avatarAvailable, voiceOf, hasCredit });

  return { registerAgent, sweep, release, live };
}
