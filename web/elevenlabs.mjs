// ElevenLabs (elevenlabs.io) as the voice that speaks the replies, picked with
// BRAMBIT_SPEECH_PROVIDER=elevenlabs (audio-provider.mjs). It only speaks:
// transcription stays with BRAMBIT_AUDIO_PROVIDER. Its voices belong to the
// account (cloned or picked from its library), so the installation lists the
// ones it offers in ELEVENLABS_VOICES ("id" or "id:Name", comma separated);
// the first is the default. ELEVENLABS_MODEL picks the model.
// ElevenLabs bills per character of text, so the usage counts characters as
// input (priced per million in pricing.mjs).

const URL_BASE = 'https://api.elevenlabs.io/v1';
export const ELEVENLABS_DEFAULT_MODEL = 'eleven_v4_turbo';
// Voice ids are alphanumeric; anything else never reaches the request path.
const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;

export const elevenlabsModel = () => String(process.env.ELEVENLABS_MODEL || '').trim() || ELEVENLABS_DEFAULT_MODEL;

// [{ id, name }] from ELEVENLABS_VOICES, invalid ids and repeats left out.
export function elevenlabsVoices(value = process.env.ELEVENLABS_VOICES) {
  const voices = [];
  for (const entry of String(value || '').split(',')) {
    const at = entry.indexOf(':');
    const id = (at < 0 ? entry : entry.slice(0, at)).trim();
    const name = at < 0 ? '' : entry.slice(at + 1).trim();
    if (VOICE_ID.test(id) && !voices.some((v) => v.id === id)) voices.push({ id, name: name || id });
  }
  return voices;
}

export const elevenlabsReady = () => !!process.env.ELEVENLABS_API_KEY && elevenlabsVoices().length > 0;

// Speech as raw PCM s16le 24 kHz mono → { buffer, rate, usage }. A voice the
// installation does not list speaks with the first one.
export async function elevenlabsPcm(text, voice, fetchImpl = fetch) {
  const voices = elevenlabsVoices();
  const id = voices.some((v) => v.id === voice) ? voice : voices[0]?.id;
  if (!id) throw new Error('elevenlabs: no voice in ELEVENLABS_VOICES');
  const model = elevenlabsModel();
  const res = await fetchImpl(`${URL_BASE}/text-to-speech/${id}?output_format=pcm_24000`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
  });
  if (!res.ok) throw new Error(`elevenlabs ${model} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error(`elevenlabs ${model}: no audio in the reply`);
  const chars = text.length;
  return { buffer, rate: 24000, usage: { model, in: chars, cached: 0, out: 0, think: 0, total: chars } };
}
