import {makeCompativel} from './compativel.mjs';
// ── Real adapter: OpenAI (Chat Completions, OpenAI-compatible) ──
// Default of the compatible engine (compativel.mjs). The key comes from
// process.env.OPENAI_API_KEY (NEVER hardcode in the repo). Used to TEST OpenAI
// models (GPT-5 mini, GPT-4.1 mini/nano) side by side with Gemini.
//
// IMPORTANT: OpenAI does NOT have built-in search like Gemini (google_search). Here
// the `search` parameter is ignored — without grounding, factual/real-time responses
// can hallucinate. For production it would need the web_search tool turned on (billed
// separately) in the tool-loop. For a raw CAPABILITY test, running without search is fine.
//
// Reasoning models (gpt-5*, o*) don't accept `temperature` != 1 and use
// `max_completion_tokens` instead of `max_tokens`; we handle both cases.

const BASE = process.env.OPENAI_URL || 'https://api.openai.com/v1/chat/completions';

export function openaiEnabled() {
  return !!process.env.OPENAI_API_KEY;
}

// Credit reservation for image in a configured model: we don't know how many tokens
// each provider charges per image, so we hold a high margin (the largest case in
// OpenAI's table, above ~10k). It's only the reservation; the final charge is the real usage.
const GENERIC_IMAGE_RESERVE = 12000;
function estimateGenericInput(spec){
 const body=JSON.parse(JSON.stringify(spec.body));let images=0;
 for(const m of body.messages||[]){
  if(!Array.isArray(m.content))continue;
  m.content=m.content.map(p=>p?.type==='image_url'?(images++,{type:'image_url',image_url:{url:'[imagem]'}}):p);
 }
 return images*GENERIC_IMAGE_RESERVE+Buffer.byteLength(JSON.stringify(body),'utf8')+512*((body.messages||[]).length+(body.tools||[]).length+1);
}

export function makeOpenAI({
  model = 'gpt-5-mini',
  maxTokens = 8192,          // hard output ceiling (anti-loop, same as Gemini)
  temperature = 0.7,         // ignored on reasoning models
  reasoningEffort = 'low',   // only applies to reasoning models (gpt-5*/o*)
  // Any OpenAI-compatible provider (modelos.yaml): address, key and name
  // come from the configuration. Without them, it's the usual OpenAI. apiKey null = provider
  // without a key (e.g.: Ollama on the local machine).
  url = BASE,
  apiKey,
  provider = 'openai',
  extras,                    // extra model parameters, merged into the body last
} = {}) {
  const generic = provider !== 'openai';
  const reasoning = /^(o\d|gpt-5)/.test(model);
  return makeCompativel({
    provedor: provider, model, url, chave: apiKey === undefined ? process.env.OPENAI_API_KEY : apiKey,
    // WARNING: some new models (e.g.: gpt-5.4-mini) do NOT accept
    // `reasoning_effort` together with function tools on /v1/chat/completions
    // (400 error "use /v1/responses instead"). Since our tool-loop almost
    // always sends tools, we only send reasoning_effort when there are NO tools.
    campos: (comTools) => reasoning
      ? { max_completion_tokens: maxTokens, ...(reasoningEffort && !comTools ? { reasoning_effort: reasoningEffort } : {}) }
      : { max_tokens: maxTokens, temperature },
    // OpenAI rejects (400 array_above_max_length) when there are more than 128
    // tools. GLM/Together can handle more, so tool-heavy agents only
    // blow up HERE, in the fallback; the excess ones are left out just for this call.
    limiteTools: { max: 128, aviso: (n) => `[openai] ${n} tools > teto 128 da OpenAI; cortando pras 128 primeiras neste turno.` },
    extras,
    ...(generic ? { contarEntrada: estimateGenericInput } : {}),
    // Open models (GLM, DeepSeek) sometimes write the tool call
    // as text; that's a model thing, not a provider thing, so it applies to any
    // configured endpoint. The real OpenAI doesn't do this.
    ferramentaEmTexto: generic ? 'comTools' : false,
  });
}
