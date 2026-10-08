import {makeCompativel} from './compativel.mjs';
// ── Real adapter: DeepInfra (OpenAI-compatible Chat Completions) ──
// Default of the compatible engine (compativel.mjs). The key comes from
// process.env.DEEPINFRA_API_KEY (NEVER hardcode in the repo). Used to TEST
// GLM-5.2 (zai-org/GLM-5.2) side by side with Gemini and OpenAI.
//
// IMPORTANT: GLM on DeepInfra does NOT have built-in search like Gemini. Here the
// `search` parameter is ignored; grounding comes from the `buscar_web` tool (backend =
// Gemini search), injected into the tool-loop for any non-Gemini provider.
//
// GLM-5.2 is standard OpenAI-compatible: uses max_tokens + temperature (it's not from
// the gpt-5/o* family, so it doesn't touch max_completion_tokens/reasoning_effort).

const BASE = process.env.DEEPINFRA_URL || 'https://api.deepinfra.com/v1/openai/chat/completions';

export function deepinfraEnabled() {
  return !!process.env.DEEPINFRA_API_KEY;
}

export function makeDeepInfra({
  model = 'zai-org/GLM-5.2',
  maxTokens = 8192,     // hard output ceiling (anti-loop, same as Gemini)
  temperature = 0.7,
  reasoning,            // e.g.: { enabled: false } turns off GLM's "thinking".
                        // GLM-4.7 is a model that reasons before responding and
                        // that costs 5-10s + hidden tokens even for a "good morning";
                        // with reasoning off it responds in ~1-2s, without losing
                        // quality in chat/tool-calling (see evals/eval-texto-glm47).
} = {}) {
  return makeCompativel({
    provedor: 'deepinfra', model, url: BASE, chave: process.env.DEEPINFRA_API_KEY,
    campos: () => ({ max_tokens: maxTokens, temperature, ...(reasoning !== undefined ? { reasoning } : {}) }),
    camposDiretos: () => ({ max_tokens: maxTokens, temperature, reasoning: { enabled: false } }),
    // Empty response: retries without reasoning (same protection as Together, bug from
    // the 2026-07-02 case). GLM tool-call residue: here it does NOT re-sample (DeepInfra's
    // GLM is slow); throws straight to the fallback chain to take over.
    retryVazio: 'simples', residuoGlmLanca: true,
  });
}
