import {makeCompativel} from './compativel.mjs';
// ── Adapter real: OpenAI (Chat Completions, OpenAI-compatible) ──
// Predefinição do motor compatível (compativel.mjs). A chave vem de
// process.env.OPENAI_API_KEY (NUNCA hardcode no repo). Serve pra TESTAR modelos
// da OpenAI (GPT-5 mini, GPT-4.1 mini/nano) lado a lado com o Gemini.
//
// IMPORTANTE: a OpenAI NÃO tem busca embutida como o Gemini (google_search). Aqui
// o parâmetro `search` é ignorado — sem grounding, respostas factuais/tempo-real
// podem alucinar. Pra produção precisaria ligar a tool web_search (cobrada à
// parte) no tool-loop. Pra um teste de CAPACIDADE crua, rodar sem busca serve.
//
// Modelos de raciocínio (gpt-5*, o*) não aceitam `temperature` != 1 e usam
// `max_completion_tokens` no lugar de `max_tokens`; tratamos os dois casos.

const BASE = process.env.OPENAI_URL || 'https://api.openai.com/v1/chat/completions';

export function openaiEnabled() {
  return !!process.env.OPENAI_API_KEY;
}

// Reserva de crédito pra imagem em modelo configurado: não sabemos quantos tokens
// cada provedor cobra por imagem, então seguramos uma margem alta (o maior caso da
// tabela da OpenAI acima de ~10k). É só a reserva; a cobrança final é o uso real.
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
  maxTokens = 8192,          // teto rígido de saída (anti-loop, igual ao Gemini)
  temperature = 0.7,         // ignorado em modelos de raciocínio
  reasoningEffort = 'low',   // só vale pros modelos de raciocínio (gpt-5*/o*)
  // Qualquer provedor compatível com OpenAI (modelos.yaml): endereço, chave e nome
  // vêm da configuração. Sem eles, é a OpenAI de sempre. apiKey null = provedor
  // sem chave (ex.: Ollama na própria máquina).
  url = BASE,
  apiKey,
  provider = 'openai',
  extras,                    // parâmetros extras do modelo, mesclados no corpo por último
} = {}) {
  const generic = provider !== 'openai';
  const reasoning = /^(o\d|gpt-5)/.test(model);
  return makeCompativel({
    provedor: provider, model, url, chave: apiKey === undefined ? process.env.OPENAI_API_KEY : apiKey,
    // ATENÇÃO: alguns modelos novos (ex: gpt-5.4-mini) NÃO aceitam
    // `reasoning_effort` junto com function tools no /v1/chat/completions
    // (erro 400 "use /v1/responses instead"). Como nosso tool-loop quase
    // sempre manda tools, só enviamos reasoning_effort quando NÃO há tools.
    campos: (comTools) => reasoning
      ? { max_completion_tokens: maxTokens, ...(reasoningEffort && !comTools ? { reasoning_effort: reasoningEffort } : {}) }
      : { max_tokens: maxTokens, temperature },
    // A OpenAI rejeita (400 array_above_max_length) quando passam de 128
    // ferramentas. O GLM/Together aguenta mais, então agentes tool-heavy só
    // estouram AQUI, no fallback; as excedentes ficam de fora só nesta chamada.
    limiteTools: { max: 128, aviso: (n) => `[openai] ${n} tools > teto 128 da OpenAI; cortando pras 128 primeiras neste turno.` },
    extras,
    ...(generic ? { contarEntrada: estimateGenericInput } : {}),
    // Modelos abertos (GLM, DeepSeek) às vezes escrevem a chamada de ferramenta
    // como texto; isso é do modelo, não do provedor, então vale pra qualquer
    // endereço configurado. A OpenAI de verdade não faz isso.
    ferramentaEmTexto: generic ? 'comTools' : false,
  });
}
