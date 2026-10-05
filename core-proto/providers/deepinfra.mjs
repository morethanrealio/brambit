import {makeCompativel} from './compativel.mjs';
// ── Adapter real: DeepInfra (OpenAI-compatible Chat Completions) ──
// Predefinição do motor compatível (compativel.mjs). A chave vem de
// process.env.DEEPINFRA_API_KEY (NUNCA hardcode no repo). Serve pra TESTAR o
// GLM-5.2 (zai-org/GLM-5.2) lado a lado com o Gemini e a OpenAI.
//
// IMPORTANTE: o GLM na DeepInfra NÃO tem busca embutida como o Gemini. Aqui o
// parâmetro `search` é ignorado; o grounding vem da tool `buscar_web` (backend =
// busca no Gemini), injetada no tool-loop pra qualquer provider não-Gemini.
//
// GLM-5.2 é OpenAI-compatible padrão: usa max_tokens + temperature (não é da
// família gpt-5/o*, então não mexe com max_completion_tokens/reasoning_effort).

const BASE = process.env.DEEPINFRA_URL || 'https://api.deepinfra.com/v1/openai/chat/completions';

export function deepinfraEnabled() {
  return !!process.env.DEEPINFRA_API_KEY;
}

export function makeDeepInfra({
  model = 'zai-org/GLM-5.2',
  maxTokens = 8192,     // teto rígido de saída (anti-loop, igual ao Gemini)
  temperature = 0.7,
  reasoning,            // ex: { enabled: false } desliga o "pensamento" do GLM.
                        // GLM-4.7 é um modelo que raciocina antes de responder e
                        // isso custa 5-10s + tokens escondidos até num "bom dia";
                        // com o raciocínio off ele responde em ~1-2s, sem perder
                        // qualidade em chat/tool-calling (ver evals/eval-texto-glm47).
} = {}) {
  return makeCompativel({
    provedor: 'deepinfra', model, url: BASE, chave: process.env.DEEPINFRA_API_KEY,
    campos: () => ({ max_tokens: maxTokens, temperature, ...(reasoning !== undefined ? { reasoning } : {}) }),
    camposDiretos: () => ({ max_tokens: maxTokens, temperature, reasoning: { enabled: false } }),
    // Resposta vazia: refaz sem raciocínio (mesma proteção da Together, bug do
    // caso de 02/07). Resíduo de tool-call do GLM: aqui NÃO re-amostra (o GLM da
    // DeepInfra é lento); lança direto pra cadeia de fallback assumir.
    retryVazio: 'simples', residuoGlmLanca: true,
  });
}
