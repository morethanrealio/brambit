import {makeCompativel} from './compativel.mjs';
// ── Real adapter: Nemotron (NVIDIA NIM, OpenAI-compatible) ──
// PROPRIETARY model running on our own machine (4×L40S) behind HTTPS, no API
// key. Default of the compatible engine (compativel.mjs). It's a
// REASONING model: it generates a <think>…</think> block before the response; here
// we separate the reasoning (outside the final response) from the delivered text.
//
// Endpoint/model come from the environment (NEVER hardcode the machine in the repo):
//   NEMOTRON_URL   e.g. https://your-server/v1/chat/completions (OpenAI-compatible endpoint)
//   NEMOTRON_MODEL e.g. nvidia/nemotron-3-super-120b-a12b

const DEFAULT_URL = process.env.NEMOTRON_URL || '';
const DEFAULT_MODEL = process.env.NEMOTRON_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

// Strips the reasoning block from the final text. NIM/vLLM usually emits the
// reasoning WITHOUT the opening <think> tag but WITH the closing </think> — so
// the final response is everything that comes AFTER the last </think>. Also handles
// complete <think>…</think> pairs and an open/truncated block, just in case.
function stripThink(s) {
  if (!s) return '';
  let out = s;
  const close = out.lastIndexOf('</think>');
  if (close !== -1) out = out.slice(close + '</think>'.length);
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = out.indexOf('<think>');
  if (open !== -1) out = out.slice(0, open); // truncated reasoning -> no final response
  return out.trim();
}

export function makeNemotron({
  url = DEFAULT_URL,
  model = DEFAULT_MODEL,
  maxTokens = 8192,          // reasoning consumes a lot; needs a generous ceiling
  temperature = 0.6,         // recomendado p/ Nemotron reasoning
  topP = 0.95,
} = {}) {
  return makeCompativel({
    provedor: 'nemotron', model, url, chave: null, semProntidao: true, erroSemUrl: 'NEMOTRON_URL não configurada',
    campos: () => ({ max_tokens: maxTokens, temperature, top_p: topP }),
    // Some servers put the reasoning in a separate field; here it comes inline in the content.
    visao: false, limparTexto: stripThink, usoSemCache: true, cortePorTeto: false,
  });
}
