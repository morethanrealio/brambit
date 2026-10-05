import {TOGETHER_FLASH_MODEL,flashReasoning,estimateTogetherFlashInput,togetherRejectionDiagnostic} from './together-flash-contract.mjs';
import {makeCompativel} from './compativel.mjs';
export {TOGETHER_FLASH_MODEL} from './together-flash-contract.mjs';
export {parseGlmToolCalls,parseDsmlToolCalls,stripDsml,hasDsmlResidue} from './ferramenta-em-texto.mjs';
// ── Adapter real: Together AI (OpenAI-compatible Chat Completions) ──
// Predefinição do motor compatível (compativel.mjs). A chave vem de
// process.env.TOGETHER_API_KEY (NUNCA hardcode no repo). Serve pra rodar o
// GLM-5.2 (zai-org/GLM-5.2) MUITO mais rápido que a DeepInfra: a DeepInfra serve
// o modelo em FP4 a ~40 tok/s (o mais lento de todos), a Together entrega o mesmo
// modelo a ~347 tok/s (~8,5x mais rápido) e sem quantização FP4.
//
// IMPORTANTE: o GLM na Together NÃO tem busca embutida como o Gemini. Aqui o
// parâmetro `search` é ignorado; o grounding vem da tool `buscar_web`, injetada
// no tool-loop pra qualquer provider não-Gemini.
//
// RACIOCÍNIO: o GLM-5.2 raciocina por padrão em `reasoning_effort:'max'` (cadeia
// de pensamento longa). Como `max_tokens` é o teto TOTAL da geração (raciocínio +
// texto visível), com um teto baixo o raciocínio pode consumir TODO o orçamento e
// sobrar ~0 token pro texto → resposta vazia (bug de 02/07, out=8192
// reason=8191). Pra o raciocínio nunca monopolizar a saída:
//   (a) rodamos em `reasoning_effort:'high'` (menos raciocínio que o 'max' default);
//   (b) `max_tokens` generoso (16384) pra o raciocínio terminar e sobrar espaço;
//   (c) GARANTIA DURA: se ainda assim o content vier vazio, refazemos a chamada no
//       PRÓPRIO GLM com o raciocínio DESLIGADO (reasoning:{enabled:false}) pedindo
//       resposta direta — nunca entregamos vazio. (Sem fallback pro GPT, decisão
//       Marcos 02/07.)


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
  maxTokens = 16384,          // teto TOTAL de saída (raciocínio + texto). Generoso pra o
                              // raciocínio terminar e SEMPRE sobrar espaço pro texto visível.
  temperature = model === TOGETHER_FLASH_MODEL ? 1.0 : 0.7,
  reasoningEffort,   // GLM-5.2: 'high' | 'max' (default do modelo = 'max'). Usamos
                              // 'high' pra o raciocínio não monopolizar o teto de saída.
} = {}) {
  const reasoning = togetherReasoning(model, reasoningEffort);
  return makeCompativel({
    provedor: 'together', model, url: BASE, chave: process.env.TOGETHER_API_KEY,
    campos: () => ({ max_tokens: maxTokens, temperature, ...reasoning }),
    camposDiretos: () => ({ max_tokens: maxTokens, temperature, ...togetherReasoning(model, reasoningEffort, true) }),
    // Streaming pra medir INATIVIDADE: um GLM travado ficava no timeout default do
    // undici (~minutos) antes de "fetch failed". A Together (serverless) devolve
    // 503/429 esporádico por capacidade (a re-tentativa é regra comum, regras.mjs).
    stream: { inatividadeMs: 25_000, diagnosticoRecusa: togetherRejectionDiagnostic },
    ...(model === TOGETHER_FLASH_MODEL ? { contarEntrada: estimateTogetherFlashInput } : {}),
    // GLM e DeepSeek às vezes escrevem a chamada como TEXTO quando o parser da
    // Together falha em geração longa (bug de 01/07; DSML de dois casos
    // de 01/09). Recupera; se não der, re-amostra; resíduo nunca vaza.
    ferramentaEmTexto: 'sempre', reamostrarResiduo: 2, vazioSemUsoLanca: true, retryVazio: 'completo',
  });
}
