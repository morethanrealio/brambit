// Vidu (vidu.com), the service that animates an assistant's face: given a photo
// and the speech audio, it draws the talking face live. Brambit keeps the
// brain, the voice and the transcription; Vidu only draws.
// Off unless VIDU_API_KEY is set. VIDU_HOST picks the account's region
// (api.vidu.com by default, api.vidu.cn for an account opened there).
// Docs: platform.vidu.com, S2-Avatar > Component and Image Upload.
//
// Photos (/live/v1/avatars): registering a photo returns its avatar id, which
// opens a session in about 3 s (a raw photo takes about 15 s). Registration is
// by content: sending the same photo again returns the id that already exists,
// with its original creation date. Vidu deletes a photo 90 days after it was
// created, so callers renew it before that (avatar-photos.mjs).
//
// Sessions (/live/s_avatar/component): a session with a photo opens an RTC
// channel (managed_rtc, Agora) where Vidu publishes the face with the voice;
// the browser only watches it. Vidu bills per second from the session's
// creation until it sees the hangup on the stream, or the stream closes.
// The stream (/live/v1/external-lives/{id}/stream) is a WebSocket from the
// server: the speech goes in as PCM, the reply's text as type 10.
import { randomUUID } from 'node:crypto';

export const SAMPLE_RATE = 24000;   // PCM s16le mono, the only format Vidu takes
export const FRAME_BYTES = 4800;    // 100 ms of it

export function viduConfig({ key = process.env.VIDU_API_KEY, host = process.env.VIDU_HOST } = {}) {
  key = String(key || '').trim();
  if (!key) return null;
  return { host: String(host || '').trim() || 'api.vidu.com', key };
}

// Ids are int64: a big number loses precision in JSON.parse, so it is quoted first.
const parse = (body) => JSON.parse(String(body).replace(/("id"\s*:\s*)(\d{16,})/g, '$1"$2"'));

async function call({ host, key, fetchImpl = fetch }, method, route, body) {
  const res = await fetchImpl(`https://${host}${route}`, {
    method,
    headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`vidu ${res.status}: ${text.slice(0, 300)}`), { status: res.status, body: text });
  return text;
}

const photoOf = (body) => {
  const d = parse(body);
  if (d?.id == null) throw new Error(`vidu: photo reply without id (${String(body).slice(0, 200)})`);
  return { id: String(d.id), status: d.status, createdAt: d.created_at };
};

// image: data URI (data:image/jpeg;base64,...). status: created → success | failed.
export async function registerPhoto(vidu, { image, name }) {
  return photoOf(await call(vidu, 'POST', '/live/v1/avatars', { image_uri: image, name }));
}

// null: the photo no longer exists (deleted or expired).
export async function readPhoto(vidu, id) {
  try {
    return photoOf(await call(vidu, 'GET', `/live/v1/avatars/${encodeURIComponent(id)}`));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function deletePhoto(vidu, id) {
  await call(vidu, 'DELETE', `/live/v1/avatars/${encodeURIComponent(id)}`).catch((e) => { if (e.status !== 404) throw e; });
}

// What the face does while it waits (idle_motion). Left out, Vidu picks from
// its own library, which for a photo can be a single gesture every 10 s: on
// 2026-10-27 the face kept fixing its hair nonstop. Instead, a few subtle face
// and head motions, one drawn every 20 s, hands still.
const IDLE_MOTION = {
  enabled: true,
  source: 'custom',
  recommend: 'random',
  motions: [
    { name: 'smile', content: 'Looks at the camera and smiles naturally, the corners of the mouth rising slightly. Hands do not move.', weight: 2 },
    { name: 'nod', content: 'Looks at the camera and nods once, gently. Hands do not move.', weight: 1 },
    { name: 'head tilt', content: 'Tilts the head slightly, looks at the camera with curiosity, then straightens it. Hands do not move.', weight: 1 },
    { name: 'blink', content: 'Blinks in a relaxed way and keeps looking at the camera. Hands do not move.', weight: 1 },
  ],
  scheduling: { motion_interval: 20, rest_after_motion: 5 },
};

// → {id, rtc: {provider, appId, channel, uid, token}}. photoGone: the photo no
// longer exists at Vidu (it has to be registered again).
export async function createSession(vidu, { avatarId, model = 'vidu-s1' }) {
  let d;
  try {
    d = parse(await call(vidu, 'POST', '/live/s_avatar/component', { model, avatar_id: avatarId, managed_rtc: { provider: 'agora' }, idle_motion: IDLE_MOTION }));
  } catch (e) {
    e.photoGone = e.status === 404 && /avatar_id/.test(e.body || '');
    throw e;
  }
  if (!d?.live?.id) throw new Error(`vidu: session reply without live.id (${JSON.stringify(d).slice(0, 200)})`);
  const c = d.managed_rtc || {};
  return { id: String(d.live.id), rtc: { provider: c.provider, appId: c.app_id, channel: c.channel_id, uid: c.user_id, token: c.token } };
}

// The session's stream. The first frame is conn_init (type 1); an ack with
// NOT_READY means the face is still loading, so conn_init goes again on the
// same socket. Once ready: PCM frames (binary), the reply's text (type 10) and
// a cut of the current speech (type 7). onDrop(reason): after ready, the
// stream closed without a hangup from here (Vidu hung up, the network fell).
export function openStream(vidu, liveId, { onDrop = () => {}, retryEvery = 1000, tries = 40, deadline = 60000, WebSocketImpl = globalThis.WebSocket } = {}) {
  const OPEN = 1, CONNECTING = 0;
  const connId = `brambit-${randomUUID().slice(0, 8)}`;
  const ws = new WebSocketImpl(`wss://${vidu.host}/live/v1/external-lives/${encodeURIComponent(liveId)}/stream?conn_id=${connId}`, { headers: { authorization: `Token ${vidu.key}` } });
  ws.binaryType = 'arraybuffer';
  let seq = 0, ready = false, leaving = false, timer = null;
  const send = (type, payload = {}) => {
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type, live_id: liveId, conn_id: connId, seq_id: ++seq, payload }));
  };
  const init = () => send(1, { conn_init: { version: 1 } });

  const isReady = new Promise((resolve, reject) => {
    let n = 0;
    timer = setTimeout(() => { reject(new Error('vidu: the face was not ready in time')); ws.close(); }, deadline);
    ws.addEventListener('open', init);
    ws.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string') return;
      let m;
      try { m = JSON.parse(data); } catch { return; }
      if (m.type === 2) {
        const ack = m.payload?.conn_init_ack || {};
        if (ack.success) { ready = true; clearTimeout(timer); resolve(); }
        else if (ack.error_code === 'NOT_READY' && ++n < tries) setTimeout(init, retryEvery);
        else { reject(new Error(`vidu conn_init: ${ack.error_code || 'no code'} ${ack.error_msg || ''}`.trim())); ws.close(); }
      } else if (m.type === 6) {
        if (ready && !leaving) onDrop(`vidu hung up (${m.payload?.hangup?.hangup_reason || 'no reason'})`);
        leaving = true;
        ws.close();
      }
    });
    // A refused upgrade (401, 403, 404...) also lands here, with no status.
    ws.addEventListener('error', () => reject(new Error('vidu stream: the connection failed')));
    ws.addEventListener('close', ({ code }) => {
      clearTimeout(timer);
      reject(new Error(`vidu closed the stream (${code})`));
      if (ready && !leaving) onDrop(`stream closed (${code})`);
      leaving = true;
    });
  });
  isReady.catch(() => {});

  const text = (type, content) => {
    if (ready && String(content || '').trim()) send(type, { text_msg: { msg_id: `${connId}-${seq + 1}`, content, timestamp: Date.now() } });
  };
  return {
    ready: isReady,
    isReady: () => ready,
    // Before the ack Vidu drops audio, so none is sent.
    audio(pcm) { if (ready && ws.readyState === OPEN) ws.send(pcm); },
    reply: (content) => text(10, content),
    cut: () => { if (ready) send(7); },
    // Billing only stops when Vidu sees the hangup: while still connecting it
    // waits for the socket to open (closing mid-handshake, Vidu never knows).
    hangup() {
      if (leaving) return;
      leaving = true;
      clearTimeout(timer);
      const bye = () => { send(5, { hangup: { hangup_reason: 'client_hangup' } }); ws.close(); };
      if (ws.readyState === CONNECTING) ws.addEventListener('open', bye, { once: true });
      else bye();
    },
  };
}
