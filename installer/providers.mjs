// The AI providers the setup page offers, how to list the models a key can use
// (which also tests the key, without spending anything) and the modelos.yaml
// written from the choice. Each provider has a recommended model the core
// already prices (web/pricing.mjs); the person may pick any other chat model the
// key lists. "other" is any service speaking the OpenAI protocol (OpenRouter,
// Ollama, vLLM...), with the model picked from its list or typed by hand.
import { stringify } from 'yaml';

export const PROVIDERS = {
  together: { url: 'https://api.together.xyz/v1', model: 'deepseek-ai/DeepSeek-V4.1-Flash', keyVar: 'TOGETHER_API_KEY' },
  openai: { url: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', keyVar: 'OPENAI_API_KEY' },
  gemini: { type: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.7-flash', keyVar: 'GEMINI_API_KEY' },
  // DeepInfra lists its models without a key, so the key is checked on an
  // account endpoint that needs one and costs nothing.
  deepinfra: { url: 'https://api.deepinfra.com/v1/openai', model: 'deepseek-ai/DeepSeek-V4.1-Flash', keyVar: 'DEEPINFRA_API_KEY', keyCheck: 'https://api.deepinfra.com/v1/me' },
  // DeepSeek's own API thinks by default, and then wants its reasoning sent back
  // on every call that carries tools. Off, as the core's own DeepSeek route does.
  deepseek: { url: 'https://api.deepseek.com', model: 'deepseek-flash', keyVar: 'DEEPSEEK_API_KEY', options: { thinking: { type: 'disabled' } } },
  other: { url: null, model: null, keyVar: 'OTHER_API_KEY' },
};

// Models in the lists that are not for chat (voice, images, embeddings, live
// sessions...) or that the chat endpoint does not serve. Dated snapshots are
// left out too: the undated name already points at the latest one.
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/;
const OPENAI_NOT_CHAT = /realtime|tts|transcribe|audio|image|embedding|moderation|search|codex|instruct|sora|-pro\b|\d{4}-\d{2}-\d{2}/;
const GEMINI_NOT_CHAT = /tts|image|embedding|live|native-audio|robotics|computer-use|aqa|veo|lyria|transcribe|banana|deep-research|antigravity|translate|gemma/;

// Where the person's AI answers and with which key → {provider, url, key} or {error}.
export function endpoint({ provider, url, key }) {
  const p = PROVIDERS[provider];
  if (!p) return { error: 'invalid_provider' };
  const k = String(key || '').trim();
  if (provider !== 'other') return k ? { provider, url: p.url, key: k } : { error: 'missing_key' };
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return { error: 'invalid_url' }; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return { error: 'invalid_url' };
  return { provider, url: u.href.replace(/\/+$/, ''), key: k };
}

// What the person chose → {provider, url, model, key} or {error}. Without a
// model, the provider's recommended one.
export function choice(p) {
  const e = endpoint(p);
  if (e.error) return e;
  const m = String(p.model || '').trim() || PROVIDERS[e.provider].model;
  if (!m) return { error: 'missing_model' };
  if (m.length > 200 || /\s/.test(m)) return { error: 'invalid_model' };
  return { ...e, model: m };
}

// US$ per million tokens, from the price a provider publishes in its list.
const priceOf = (input, output, cached) => {
  const n = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : null);
  const i = n(input), o = n(output);
  return i !== null && o !== null && (i > 0 || o > 0) ? { in: i, cachedIn: n(cached) ?? i, out: o } : undefined;
};

// The chat models the key can use, the recommended one first:
// {ok:true, models:[{id, price?}], recommended} or {ok:false, error}.
export async function listModels({ provider, url, key }, fetchImpl = fetch) {
  const gemini = PROVIDERS[provider]?.type === 'gemini';
  const headers = gemini ? { 'x-goog-api-key': key } : (key ? { authorization: `Bearer ${key}` } : {});
  let res;
  try { res = await fetchImpl(`${url}/models${gemini ? '?pageSize=1000' : ''}`, { headers, signal: AbortSignal.timeout(15000) }); }
  catch { return { ok: false, error: 'no_connection' }; }
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'key_rejected' };
  if (!res.ok) return { ok: false, error: 'provider_error', status: res.status };
  const check = PROVIDERS[provider]?.keyCheck;
  if (check) {
    let c;
    try { c = await fetchImpl(check, { headers, signal: AbortSignal.timeout(15000) }); }
    catch { return { ok: false, error: 'no_connection' }; }
    if (c.status === 401 || c.status === 403) return { ok: false, error: 'key_rejected' };
    if (!c.ok) return { ok: false, error: 'provider_error', status: c.status };
  }
  const body = await res.json().catch(() => null);
  const list = gemini ? body?.models : (Array.isArray(body) ? body : body?.data);
  if (!Array.isArray(list)) return { ok: false, error: 'provider_error', status: res.status };
  const models = [];
  for (const m of list) {
    const id = String((gemini ? m?.name : m?.id) || '').replace(/^models\//, '');
    if (!id) continue;
    if (provider === 'together' && m.type !== 'chat') continue;
    if (provider === 'openai' && (!OPENAI_CHAT.test(id) || OPENAI_NOT_CHAT.test(id))) continue;
    if (gemini && (!m.supportedGenerationMethods?.includes('generateContent') || GEMINI_NOT_CHAT.test(id))) continue;
    if (provider === 'deepinfra' && !m.metadata?.tags?.includes('chat')) continue;
    const di = m.metadata?.pricing;
    const price = provider === 'together' ? priceOf(m.pricing?.input, m.pricing?.output, m.pricing?.cached_input)
      : provider === 'deepinfra' ? priceOf(di?.input_tokens, di?.output_tokens, di?.cache_read_tokens) : undefined;
    models.push(price ? { id, price } : { id });
  }
  const recommended = models.some((m) => m.id === PROVIDERS[provider].model) ? PROVIDERS[provider].model : null;
  models.sort((a, b) => (b.id === recommended) - (a.id === recommended) || a.id.localeCompare(b.id));
  return { ok: true, models, recommended };
}

// Tests the key and that the model is among the ones it lists → {ok:true,
// price?} or {ok:false, error}.
export async function testKey(c, fetchImpl = fetch) {
  const r = await listModels(c, fetchImpl);
  if (!r.ok) return r;
  // "other" lists every model the service has: the filters above are only for known providers.
  const found = r.models.find((m) => m.id === c.model);
  return found ? { ok: true, ...(found.price ? { price: found.price } : {}) } : { ok: false, error: 'model_missing' };
}

// Voice messages: who transcribes them and speaks the replies. Only these two
// providers do both today (web/audio-provider.mjs).
export const AUDIO_PROVIDERS = ['gemini', 'openai'];

// The audio provider of a saved setup. Setups from before the choice existed
// use the text provider when it does audio, and none otherwise.
export const audioOf = (cfg) => cfg.audio?.provider || (AUDIO_PROVIDERS.includes(cfg.ai.provider) ? cfg.ai.provider : 'none');

// What the person chose for audio, given the text choice → {provider:'none'},
// {provider} (the text key serves both), {provider, key} or {error}. Without a
// choice, the text provider when it does audio.
export function audioChoice({ audio, audioKey }, text) {
  const provider = audio || (AUDIO_PROVIDERS.includes(text.provider) ? text.provider : 'none');
  if (provider === 'none') return { provider };
  if (!AUDIO_PROVIDERS.includes(provider)) return { error: 'invalid_audio' };
  if (provider === text.provider) return { provider };
  const key = String(audioKey || '').trim();
  return key ? { provider, key } : { error: 'audio_missing_key' };
}

// modelos.yaml with a single provider doing every function. The key is NOT in
// it: only the name of the environment variable the launcher fills in. The keys
// of the file itself (provedores, funcoes, padrao...) are the core's format.
// With the price the provider published, the spend the app shows is the real one;
// without it the core uses its own table or a conservative estimate.
export function modelsYaml({ provider, url, model, key, price }) {
  const p = PROVIDERS[provider];
  const prov = p.type === 'gemini' ? { tipo: 'gemini', chave: p.keyVar } : { endereco: url, ...(key ? { chave: p.keyVar } : {}) };
  const doc = { provedores: { [provider]: prov }, funcoes: { padrao: { modelo: `${provider}/${model}`, ...(p.options ? { opcoes: p.options } : {}) } } };
  if (price) doc.precos = { [model]: { entrada: price.in, cache: price.cachedIn, saida: price.out } };
  return `# Generated by the Brambit installer. To change it, run the setup again.\n${stringify(doc)}`;
}
