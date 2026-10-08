// ── Video generation worker client (ComfyUI/H3, via HTTP wrapper) ──
// People's video generation runs OUTSIDE the harness, on a GPU worker (ComfyUI)
// exposed by a thin HTTP wrapper. The flow is ASYNCHRONOUS:
//   1) createRender() creates the job (POST /v1/render) and returns { job_id, ... }
//   2) getRender(jobId) polls (GET /v1/render/{id}) until status done|error
//   3) fetchRenderVideo(jobId) downloads the mp4 (GET /v1/render/{id}/video)
//
// Contract (05/08): image_url and audio_url may be presigned S3 URLs (the
// worker downloads over HTTPS when the job is created). duration is REQUIRED
// when there's no audio_url; with audio, the duration comes from the audio.
// The 15s cap is on the worker too (duration>15 -> 400), but we validate first.
//
// Billing: by the REAL `video_seconds` returned by GET when done, not by the
// estimated `credits_seconds` of the POST nor by processing time.

import { lerCorpoComTeto } from './baixar-corpo.mjs';

const COMFY_URL = () => (process.env.COMFY_URL || '').replace(/\/+$/, '');
const COMFY_TOKEN = () => process.env.COMFY_TOKEN || '';

export const MAX_VIDEO_SECONDS = 15;
// Download ceiling for the mp4. A video of up to 15s doesn't come close to this; the ceiling is
// here so a body that never ends doesn't eat up the process's memory.
export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;

// Only enables the feature when both variables are present. While the
// endpoint isn't alive, the tool doesn't even offer to generate (stays "coming soon").
export function videoGenEnabled() {
  return !!(COMFY_URL() && COMFY_TOKEN());
}

// ── PRODUCT guard: video generation UNDER REVIEW (2026-09-22) ──
// Unlike videoGenEnabled() above (which only says whether the GPU worker is up),
// this is the PRODUCT guard: while the feature is under review by the team, the
// `gerar_video` tool is not registered and the identity verification section disappears from the
// app. This way the assistant doesn't even know video exists and doesn't promise what it can't
// deliver (that's what used to happen: the promise originated from the tool's description, and the
// guard only kicked in later, inside the run).
// ON BY DEFAULT: turning the feature back on is an explicit act (VIDEO_EM_REVISAO=0 in
// the box's .env), never an oversight.
// The poller (pollVideoJobs) keeps running on purpose: a job created BEFORE the
// review keeps being delivered to the owner.
export function videoEmRevisao() {
  return String(process.env.VIDEO_EM_REVISAO ?? '1') !== '0';
}

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${COMFY_TOKEN()}`, ...extra };
}

// ATTENTION (finding #26): the clock only applies while the inner function is
// running. The finally clears the timer, so READING THE BODY of the response after
// withTimeout has returned means reading with no deadline at all and nobody to abort it. Anything that
// needs to fit within the deadline has to happen INSIDE the callback.
async function withTimeout(promise, ms, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`${label} timeout (${ms}ms)`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Creates the job. Returns { job_id, status, estimated_video_seconds, credits_seconds }.
//   imageUrl        (req): FRONT anchor photo (presigned S3 URL) -> <Picture 1>
//   prompt          (req): ONLY the scene/action (in clone mode the speech is NOT here)
//   audioUrl        (opt): reference audio
//   voiceCloneOnly  (opt): clone mode: audioUrl is only a TIMBRE reference and the
//                           speech comes from speechText (the server does NOT repeat
//                           the audio). Needs audioUrl + speechText. Duration comes
//                           from the text (don't send duration, or speech bunches up).
//   speechText      (opt): the exact words to speak (required in clone mode).
//   duration        (opt): seconds; REQUIRED when there's no audioUrl. In clone mode,
//                           leave null so the server sizes it from the text.
//   appImageUrl     (opt): app reference (screenshot) -> comes later in the numbering
//   faceRefUrls     (opt): up to 2 EXTRA photos of the SAME face (other angle/expression),
//                           presigned S3 URLs. They enter as <Picture 2>/<Picture 3>
//                           "same person, other angle" and help rebuild the features.
//                           Contract 07/08: list of strings, max 2 (L40S VRAM); more
//                           than that the worker rejects with 400. Omit when the
//                           user only has the anchor (backward compatible).
export async function createRender({ imageUrl, prompt, audioUrl = null, voiceCloneOnly = false, speechText = null, duration = null, appImageUrl = null, faceRefUrls = [] } = {}) {
  if (!videoGenEnabled()) throw new Error('video gen desabilitado (COMFY_URL/COMFY_TOKEN ausentes)');
  if (!imageUrl) throw new Error('imageUrl obrigatório');
  if (!prompt || !String(prompt).trim()) throw new Error('prompt obrigatório');
  if (voiceCloneOnly && (!audioUrl || !speechText || !String(speechText).trim())) {
    throw new Error('modo clone exige audioUrl e speechText');
  }
  if (!audioUrl && duration == null) throw new Error('duration obrigatório quando não há audioUrl');
  if (duration != null && Number(duration) > MAX_VIDEO_SECONDS) throw new Error(`duration excede ${MAX_VIDEO_SECONDS}s`);

  const body = { image_url: imageUrl, prompt: String(prompt) };
  if (audioUrl) body.audio_url = audioUrl;
  if (voiceCloneOnly) { body.voice_clone_only = true; body.speech_text = String(speechText); }
  // In clone mode the duration comes from speech_text; we only send duration outside of clone mode.
  if (duration != null && !voiceCloneOnly) body.duration = Number(duration);
  if (appImageUrl) body.app_image_url = appImageUrl;
  // Extra photos of the same face (max 2). Only non-empty strings; capped at 2 so it doesn't
  // get a 400 from the worker (its validation requires a list of strings, length <= 2).
  const refs = (Array.isArray(faceRefUrls) ? faceRefUrls : [])
    .filter((u) => typeof u === 'string' && u).slice(0, 2);
  if (refs.length) body.face_ref_urls = refs;

  const j = await withTimeout(async (signal) => {
    const res = await fetch(`${COMFY_URL()}/v1/render`, {
      method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body), signal,
    });
    if (!res.ok) throw new Error(`createRender ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }, 30_000, 'createRender');
  if (!j?.job_id) throw new Error('createRender: resposta sem job_id');
  return j;
}

// Polls a job. Returns { status, video_seconds, video_url, error }.
// status ∈ queued | processing | done | error.
export async function getRender(jobId) {
  if (!videoGenEnabled()) throw new Error('video gen desabilitado');
  if (!jobId) throw new Error('jobId obrigatório');
  return withTimeout(async (signal) => {
    const res = await fetch(`${COMFY_URL()}/v1/render/${encodeURIComponent(jobId)}`, {
      method: 'GET', headers: authHeaders(), signal,
    });
    if (!res.ok) throw new Error(`getRender ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }, 20_000, 'getRender');
}

// Downloads the generated mp4. Returns { buffer, contentType }.
//
// Finding #26: the 120s only covered the handshake. withTimeout returned the
// response as soon as the HEADERS arrived and the finally already cleared the timer, so
// the file download (which is exactly the slow part) ran with no deadline and
// nobody to abort it. A slow worker or a half-dead socket would hang the video poller
// FOREVER, and since the owner can only have 1 video in progress, they'd be stuck unable to
// request another. Now reading the body happens within the same clock, and with a
// byte ceiling.
export async function fetchRenderVideo(jobId, { timeoutMs = 120_000, maxBytes = MAX_VIDEO_BYTES } = {}) {
  if (!videoGenEnabled()) throw new Error('video gen desabilitado');
  if (!jobId) throw new Error('jobId obrigatório');
  return withTimeout(async (signal) => {
    const res = await fetch(`${COMFY_URL()}/v1/render/${encodeURIComponent(jobId)}/video`, {
      method: 'GET', headers: authHeaders(), signal,
    });
    if (!res.ok) throw new Error(`fetchRenderVideo ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const buffer = await lerCorpoComTeto(res, maxBytes, 'fetchRenderVideo');
    return { buffer, contentType: res.headers.get('content-type') || 'video/mp4' };
  }, timeoutMs, 'fetchRenderVideo');
}
