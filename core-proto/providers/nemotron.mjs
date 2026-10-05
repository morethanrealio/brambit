import {makeCompativel} from './compativel.mjs';
// ── Adapter real: Nemotron (NVIDIA NIM, OpenAI-compatible) ──
// Modelo PROPRIETÁRIO rodando em máquina nossa (4×L40S) atrás de HTTPS, sem API
// key. Predefinição do motor compatível (compativel.mjs). É um
// modelo de RACIOCÍNIO: gera um bloco <think>…</think> antes da resposta; aqui
// a gente separa o raciocínio (fora da resposta final) do texto entregue.
//
// Endpoint/modelo vêm do ambiente (NUNCA hardcode da máquina no repo):
//   NEMOTRON_URL   ex https://seu-servidor/v1/chat/completions (endpoint compatível com OpenAI)
//   NEMOTRON_MODEL ex nvidia/nemotron-3-super-120b-a12b

const DEFAULT_URL = process.env.NEMOTRON_URL || '';
const DEFAULT_MODEL = process.env.NEMOTRON_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

// Tira o bloco de raciocínio do texto final. O NIM/vLLM costuma emitir o
// raciocínio SEM a tag <think> de abertura mas COM </think> de fechamento — então
// a resposta final é tudo que vem DEPOIS do último </think>. Trata também pares
// completos <think>…</think> e bloco aberto/truncado por garantia.
function stripThink(s) {
  if (!s) return '';
  let out = s;
  const close = out.lastIndexOf('</think>');
  if (close !== -1) out = out.slice(close + '</think>'.length);
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = out.indexOf('<think>');
  if (open !== -1) out = out.slice(0, open); // raciocínio truncado -> sem resposta final
  return out.trim();
}

export function makeNemotron({
  url = DEFAULT_URL,
  model = DEFAULT_MODEL,
  maxTokens = 8192,          // raciocínio consome muito; precisa de teto folgado
  temperature = 0.6,         // recomendado p/ Nemotron reasoning
  topP = 0.95,
} = {}) {
  return makeCompativel({
    provedor: 'nemotron', model, url, chave: null, semProntidao: true, erroSemUrl: 'NEMOTRON_URL não configurada',
    campos: () => ({ max_tokens: maxTokens, temperature, top_p: topP }),
    // Alguns servidores põem o raciocínio num campo à parte; aqui vem inline no content.
    visao: false, limparTexto: stripThink, usoSemCache: true, cortePorTeto: false,
  });
}
