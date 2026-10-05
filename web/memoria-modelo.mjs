// Modelo das tarefas de manutenção de memória: extração de fatos por turno,
// patch/reescrita do perfil, reconciliação de fatos em conflito e resumo
// rolante da conversa. Trocado de gemini-3.5-flash (1,50 in / 9,00 out) para
// o DeepSeek V4.1 Flash na Together (0,30 in / 1,20 out), decisão do Marcos
// em 27/09/2026. Raciocínio no mínimo ('low'), equivalente ao thinkingBudget 0
// que o Gemini usava aqui. Sem chave da Together, volta pro Gemini.
import { makeTogether, togetherEnabled, TOGETHER_FLASH_MODEL } from '../core-proto/providers/together.mjs';
import { makeGemini } from '../core-proto/providers/gemini.mjs';
import { modeloPara } from '../core-proto/modelos.mjs';

export function makeMemoriaModel({ maxTokens = 8192 } = {}) {
  const cfg = modeloPara('memoria', { maxTokens }); if (cfg) return cfg; // modelos.yaml
  if (togetherEnabled()) return makeTogether({ model: TOGETHER_FLASH_MODEL, maxTokens, reasoningEffort: 'low' });
  return makeGemini({ model: 'gemini-3.5-flash', thinkingBudget: 0, maxOutputTokens: maxTokens });
}
