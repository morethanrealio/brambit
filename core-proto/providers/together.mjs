import {TOGETHER_FLASH_MODEL,flashReasoning,estimateTogetherFlashInput,togetherRejectionDiagnostic} from './together-flash-contract.mjs';
import {makeCompativel} from './compativel.mjs';
export {TOGETHER_FLASH_MODEL} from './together-flash-contract.mjs';
export {parseGlmToolCalls,parseDsmlToolCalls,stripDsml,hasDsmlResidue} from './ferramenta-em-texto.mjs';
// ── Real adapter: Together AI (OpenAI-compatible Chat Completions) ──
// Preset of the compatible engine (compativel.mjs). The key comes from
// process.env.TOGETHER_API_KEY (NEVER hardcoded in the repo). It runs
// GLM-5.2 (zai-org/GLM-5.2) MUCH faster than DeepInfra: DeepInfra serves the
// model in FP4 at ~40 tok/s (the slowest of all), Together serves the same
// model at ~347 tok/s (~8.5x faster) and without FP4 quantization.
//
// IMPORTANT: GLM on Together has NO built-in search like Gemini. The `search`
// parameter is ignored here; grounding comes from the `buscar_web` tool,
// injected in the tool loop for any non-Gemini provider.
//
// REASONING: GLM-5.2 reasons by default at `reasoning_effort:'max'` (long chain
// of thought). Since `max_tokens` is the TOTAL generation cap (reasoning +
// visible text), with a low cap the reasoning can eat the WHOLE budget and
// leave ~0 tokens for text → empty answer (bug of 02/07, out=8192
// reason=8191). So reasoning never monopolizes the output:
//   (a) we run at `reasoning_effort:'high'` (less reasoning than the 'max' default);
//   (b) generous `max_tokens` (16384) so reasoning finishes and room is left;
//   (c) HARD GUARANTEE: if content still comes back empty, we redo the call on
//       the SAME GLM with reasoning OFF (reasoning:{enabled:false}) asking for a
//       direct answer; we never deliver empty. (No fallback to GPT, decided
//       02/07.)


const BASE = process.env.TOGETHER_URL || 'https://api.together.xyz/v1/chat/completions';

export function togetherEnabled() {
  return !!process.env.TOGETHER_API_KEY;
}

// Provider HTTP contract differs from the reference model's numeric effort.
export function togetherReasoning(model,effort,direct=false){
  return model===TOGETHER_FLASH_MODEL ? flashReasoning(effort,direct)
    : direct ? {reasoning:{enabled:false}} : {reasoning_effort:effort??'high'};
}

export function makeTogether({
  model = 'zai-org/GLM-5.2',
  maxTokens = 16384,          // TOTAL output ceiling (reasoning + text). Generous so the
                              // reasoning finishes and ALWAYS leaves room for the visible text.
  temperature = model === TOGETHER_FLASH_MODEL ? 1.0 : 0.7,
  reasoningEffort,   // GLM-5.2: 'high' | 'max' (model default = 'max'). We use
                              // 'high' so reasoning doesn't monopolize the output ceiling.
} = {}) {
  const reasoning = togetherReasoning(model, reasoningEffort);
  return makeCompativel({
    provedor: 'together', model, url: BASE, chave: process.env.TOGETHER_API_KEY,
    campos: () => ({ max_tokens: maxTokens, temperature, ...reasoning }),
    camposDiretos: () => ({ max_tokens: maxTokens, temperature, ...togetherReasoning(model, reasoningEffort, true) }),
    // Streaming to measure INACTIVITY: a stuck GLM would sit at undici's default
    // timeout (~minutes) before "fetch failed". Together (serverless) occasionally
    // returns 503/429 due to capacity (the retry is a common rule, regras.mjs).
    stream: { inatividadeMs: 25_000, diagnosticoRecusa: togetherRejectionDiagnostic },
    ...(model === TOGETHER_FLASH_MODEL ? { contarEntrada: estimateTogetherFlashInput } : {}),
    // GLM and DeepSeek sometimes write the call as TEXT when the Together
    // parser fails on a long generation (bug from 2026-07-01; DSML from two cases
    // on 2026-09-01). Recovers; if that doesn't work, re-samples; residue never leaks.
    ferramentaEmTexto: 'sempre', reamostrarResiduo: 2, vazioSemUsoLanca: true, retryVazio: 'completo',
  });
}
