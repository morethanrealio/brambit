// Which service turns speech into text (STT) and text into speech (TTS), and
// the OpenAI side of it. Gemini's side lives in media.mjs, next to the other
// Gemini media. BRAMBIT_AUDIO_PROVIDER picks one: gemini, openai or none.
// Unset, it is Gemini when GEMINI_API_KEY is there (what every deployment had
// before the choice existed), else OpenAI when OPENAI_API_KEY is there.
// Both return `usage` in the core's shape ({ model, in, cached, out, think,
// total }), priced in pricing.mjs like any other model.

const OPENAI_URL = 'https://api.openai.com/v1';
export const OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe';
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const OPENAI_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
const OPENAI_DEFAULT_VOICE = 'coral';

// 'gemini' | 'openai' | null (no audio).
export function audioProvider() {
  const env = process.env;
  const chosen = String(process.env.BRAMBIT_AUDIO_PROVIDER || '').trim().toLowerCase();
  if (chosen === 'none') return null;
  if (chosen === 'gemini' || chosen === 'openai') return env[chosen === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY'] ? chosen : null;
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.OPENAI_API_KEY) return 'openai';
  return null;
}

const EXT = { 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/flac': 'flac' };
// The file name tells OpenAI the format, so it has to match the bytes.
const extOf = (mime) => EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || 'ogg';

function usageOf(model, u = {}) {
  const input = u.input_tokens ?? 0, output = u.output_tokens ?? 0;
  return { model, in: input, cached: 0, out: output, think: 0, total: u.total_tokens ?? input + output };
}

async function openaiFailure(model, res) {
  return new Error(`openai ${model} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
}

// Transcribes in the language spoken, without translating → { text, usage }.
export async function openaiTranscribe(buffer, mime = 'audio/ogg', fetchImpl = fetch) {
  const form = new FormData();
  form.append('model', OPENAI_STT_MODEL);
  form.append('file', new Blob([buffer], { type: mime }), `audio.${extOf(mime)}`);
  const res = await fetchImpl(`${OPENAI_URL}/audio/transcriptions`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form,
  });
  if (!res.ok) throw await openaiFailure(OPENAI_STT_MODEL, res);
  const data = await res.json();
  return { text: String(data.text || '').trim(), usage: usageOf(OPENAI_STT_MODEL, data.usage) };
}

// Speech as Ogg Opus (the voice-note format WhatsApp and Telegram take, and
// the browser plays) → { buffer, mime, ext, usage }. Only the streamed reply
// carries the token usage, so it is read as server-sent events.
export async function openaiSpeech(text, voice, fetchImpl = fetch) {
  const res = await fetchImpl(`${OPENAI_URL}/audio/speech`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_TTS_MODEL, input: text, voice: OPENAI_VOICES.has(voice) ? voice : OPENAI_DEFAULT_VOICE, response_format: 'opus', stream_format: 'sse' }),
  });
  if (!res.ok) throw await openaiFailure(OPENAI_TTS_MODEL, res);
  const chunks = [];
  let usage;
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('data:')) continue;
    let event;
    try { event = JSON.parse(line.slice(5)); } catch { continue; }
    if (event.type === 'speech.audio.delta' && event.audio) chunks.push(Buffer.from(event.audio, 'base64'));
    else if (event.type === 'speech.audio.done') usage = event.usage;
  }
  if (!chunks.length) throw new Error(`openai ${OPENAI_TTS_MODEL}: no audio in the reply`);
  return { buffer: Buffer.concat(chunks), mime: 'audio/ogg', ext: 'ogg', usage: usageOf(OPENAI_TTS_MODEL, usage) };
}
