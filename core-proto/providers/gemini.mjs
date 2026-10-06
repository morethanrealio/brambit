import {wrapProvider} from '../provider-attempt.mjs';
import {providerAttempt,hasProviderAttempts,throwIfAttemptControl} from '../provider-attempt.mjs';
// ── Adapter real: Google Gemini (generateContent) ──
// Mesmo contrato dos outros providers. A chave vem de process.env.GEMINI_API_KEY
// (NUNCA hardcode no repo). Recomendado: 3.5 Flash como orquestrador padrão e
// 3.1 Pro Preview como fallback de raciocínio pesado.

import { selectedDeepSeek, isDeepSeekTurn } from '../deepseek/scope.mjs';
import { STOP } from '../provider.mjs';
import { createHash } from 'node:crypto';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
let counter = 0;
const nextId = () => `call_${++counter}`;

// ── Retry of TRANSIENT errors on Google's side ──
// 503 UNAVAILABLE ("This model is currently experiencing high demand") and 429
// (rate limit) are short spikes: the same call usually passes seconds later.
// Without retry the whole turn died and the user saw "Failed to talk to the
// model" (a user report on 27/08, iOS app). We only retry statuses that are
// safe to retry (generateContent has no side effect on our side); 400/401/403
// are our own error and surface immediately, without wasting time.
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAYS = [600, 1800]; // ms; jitter somado na hora
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch + retry. Devolve a resposta final (ok ou não); quem chama segue tratando
// !res.ok como antes, então a falha persistente continua escalando pro fallback.
async function fetchRetry(url, init, tag = 'gemini', spec = null) {
  for (let i = 0; ; i++) {
    let res;
    try {
      if(spec&&hasProviderAttempts()){
        const data=await providerAttempt(spec,async body=>{
          const r=await fetch(url,{...init,body:JSON.stringify(body)});
          if(!r.ok){const e=new Error('gemini HTTP '+r.status);e.httpStatus=r.status;e.providerRejected=true;throw e;}
          return r.json();
        });
        res=Response.json(data);
      }else res = await fetch(url, init);
      if (res.ok || !RETRY_STATUS.has(res.status) || i >= RETRY_DELAYS.length) return res;
      console.warn(`[${tag}] ${res.status} transitório, tentativa ${i + 1}/${RETRY_DELAYS.length}`);
    } catch (e) {
      throwIfAttemptControl(e);
      if(e.httpStatus&&!RETRY_STATUS.has(e.httpStatus))throw e;
      // Falha de rede (socket/DNS/timeout): mesma política de retry.
      if (i >= RETRY_DELAYS.length) throw e;
      console.warn(`[${tag}] falha de rede (${e?.message ?? e}), tentativa ${i + 1}/${RETRY_DELAYS.length}`);
    }
    await sleep(RETRY_DELAYS[i] + Math.floor(Math.random() * 400));
  }
}

// ── Saneamento de schema de tool p/ o subset OpenAPI do Gemini ──
// Os schemas das nossas tools são JSON Schema padrão (aceitos por GLM/OpenAI), mas
// o Gemini só aceita um SUBSET do OpenAPI: campos como `additionalProperties`,
// `$schema`, `$defs`, `patternProperties` etc. derrubam a chamada com 400
// ("Unknown name ... Cannot find field"). Isso só aparecia agora porque o Gemini
// era chamado só em caminhos que passavam poucas/nenhuma tool (visão/busca);
// roteando TEXTO por ele, a suíte inteira de tools vai junto e uma delas tem
// additionalProperties. Removemos recursivamente as chaves incompatíveis, sem
// mexer no conteúdo válido (type/description/properties/items/required/enum...).
const GEMINI_SCHEMA_DROP = new Set([
  'additionalProperties', '$schema', '$id', '$ref', '$defs', 'definitions',
  'patternProperties', 'propertyNames', 'unevaluatedProperties', 'dependencies',
  'dependentSchemas', 'dependentRequired',
]);
function sanitizeGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(sanitizeGeminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (GEMINI_SCHEMA_DROP.has(k)) continue;
    out[k] = sanitizeGeminiSchema(v);
  }
  return out;
}

// ── Cache explícito (CachedContent) ──
// O tool-loop chama complete() N vezes no MESMO turno com o MESMO system + tools
// (só `contents` cresce a cada passo). Esse prefixo estável é grande (prompt do
// agente + memória + dezenas de tools) e era reenviado inteiro a cada passo — o
// que fazia um turno de 13 passos custar ~230 créditos. Aqui guardamos esse
// prefixo num CachedContent e referenciamos por `cachedContent`: o input repetido
// cai ~90% (cachedContentTokenCount). Desde o Fix#3 o datetime e os blocos voláteis
// saíram do system (vão no fim da mensagem do usuário), então o prefixo é
// byte-idêntico TAMBÉM entre turnos — o cache serve o turno inteiro E os turnos
// seguintes de uma conversa ativa, enquanto for renovado (ver TTL deslizante).
//
// HISTÓRICO NO CACHE: além de system+tools, cacheamos um PREFIXO do histórico
// da conversa (`contents`), que numa sessão longa de código passa de 100k tokens
// e era reenviado a preço cheio a cada passo (por isso a fatia cacheada travava
// em ~44% enquanto o gpt-5.4-mini fazia 73% com cache implícito). Regras:
// - Só cacheia até `len - HIST_TAIL_KEEP`: as últimas mensagens ainda podem ser
//   mutadas pelo core (pruneTurnBlobs recolhe blobs quando saem da janela
//   recente de TURN_KEEP_RECENT=4); fora dessa cauda o histórico é imutável
//   DENTRO do processo. Entre turnos há duas exceções (compactação de histórico
//   e remoção de imagens no persist) — por isso o prefixo cacheado é validado
//   por HASH a cada uso e recriado quando diverge.
// - O sufixo enviado no request começa sempre numa mensagem de role 'user'
//   (exigência de ordenação da API; preserva pareamento functionCall/Response).
// - Recriar cobra o prefixo UMA vez a preço de input normal; depois cada passo
//   paga 10% sobre ele. Compensa a partir de ~1,1 usos — recriamos quando o
//   sufixo não-cacheado acumula HIST_REFRESH_TOKENS estimados.
const TTL_SEC = 300; // TTL curto evita pagar storage à toa em conversa que acabou
// TTL DESLIZANTE: quando um hit encontra o cache com menos da metade da vida,
// renovamos o TTL via PATCH (barato) — conversa ativa nunca deixa o cache morrer;
// conversa parada expira em ≤5 min e para de pagar storage.
const REFRESH_BELOW_MS = (TTL_SEC * 1000) / 2;
// Mínimo de tokens p/ criar cache no 3.5 Flash = 4096. Estimamos por chars/4
// (que superestima ~15%), então só tentamos acima de 5000 est. p/ não bater
// abaixo do mínimo real e levar 400. Blocos menores não compensam mesmo.
const MIN_EST_TOKENS = 5000;
// Histórico no cache: nunca cacheia as últimas N mensagens (o core ainda pode
// mutá-las — TURN_KEEP_RECENT=4 + margem de segurança).
const HIST_TAIL_KEEP = 6;
// Recria o cache (empurrando o corte pra frente) quando o sufixo não-cacheado
// acumula isso de tokens estimados (chars/4). Abaixo disso, reusar o cache
// existente e pagar o sufixo inteiro sai mais barato que recriar.
const HIST_REFRESH_TOKENS = 5000;
// Hash-miss consecutivos no prefixo (ex.: duas conversas intercalando com o
// MESMO system) -> desiste do histórico por um tempo e cacheia só system+tools,
// senão cada passo recriaria o cache pagando o prefixo a preço cheio.
const HIST_MISS_LIMIT = 3;
const HIST_SKIP_MS = 10 * 60 * 1000;
const caches = new Map(); // hash(model+system+tools) -> {name,expireAt,prefixLen,prefixHash,...} | {skipUntil}

function cacheKey(model, system, toolBlocks) {
  return createHash('sha256')
    .update(model).update('\0').update(system || '').update('\0')
    .update(JSON.stringify(toolBlocks)).digest('hex');
}

// Hash do prefixo do histórico que foi pro cache: valida a cada uso que os
// `contents` do request ainda COMEÇAM byte-idêntico ao que está cacheado
// (senão o Gemini responderia com contexto duplicado/errado).
function hashPrefix(contents, len) {
  return createHash('sha256').update(JSON.stringify(contents.slice(0, len))).digest('hex');
}

// Garante um CachedContent vivo p/ o prefixo (model+system+tools+prefixo do
// histórico). Devolve { name, prefixLen } — prefixLen é quantas mensagens do
// início de `contents` estão DENTRO do cache (o caller envia só o sufixo) —
// ou undefined se não deu (cai p/ envio inline).
// As chamadas do tool-loop são sequenciais (await), então não há corrida dentro
// de um turno; entre turnos/usuários a chave difere (system carrega memória/dono).
async function ensureCache({ key, model, system, toolBlocks, search, hasTools, contents }) {
  const ck = cacheKey(model, system, toolBlocks);
  const now = Date.now();
  if (caches.size > 200) for (const [k, v] of caches) if ((v.expireAt || v.skipUntil || 0) < now) caches.delete(k);
  const hit = caches.get(ck);

  // Quanto do histórico dá pra cachear agora: tudo menos a cauda recente, e o
  // sufixo que sobra pro request tem que começar em role 'user'.
  let cutoff = (hit?.histSkipUntil && hit.histSkipUntil > now)
    ? 0
    : Math.max(0, contents.length - HIST_TAIL_KEEP);
  while (cutoff > 0 && contents[cutoff].role !== 'user') cutoff--;

  let validOld; // cache vivo e íntegro; fallback se a recriação (crescimento) falhar
  if (hit?.name && hit.expireAt > now + 5000) {
    const pl = hit.prefixLen || 0;
    const valid = pl === 0 || (pl < contents.length && hit.prefixHash === hashPrefix(contents, pl));
    if (valid) {
      hit.missCount = 0;
      // TTL deslizante: renova quando passou da metade da vida. Falha de PATCH não
      // derruba nada — o cache segue válido até o expireAt que já tínhamos.
      if (hit.expireAt - now < REFRESH_BELOW_MS && !hit.refreshing) {
        hit.refreshing = true;
        try {
          const r = await fetch(`${BASE}/${hit.name}?updateMask=ttl&key=${key}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ttl: `${TTL_SEC}s` }),
          });
          if (r.ok) hit.expireAt = Date.now() + TTL_SEC * 1000;
          else console.log(`[gemini cache] refresh ${r.status}: ${(await r.text()).slice(0, 120)}`);
        } catch (e) {
          console.log(`[gemini cache] refresh erro: ${e?.message ?? e}`);
        }
        hit.refreshing = false;
      }
      // O sufixo não-cacheado engordou? Recria o cache com o corte mais pra
      // frente (paga o prefixo 1x, economiza 90% dele nos passos seguintes).
      const sufEst = Math.ceil(JSON.stringify(contents.slice(pl)).length / 4);
      const grow = cutoff >= pl + 2 && sufEst >= HIST_REFRESH_TOKENS
        && !(hit.growSkipUntil && hit.growSkipUntil > now);
      if (!grow) return { name: hit.name, prefixLen: pl };
      validOld = { name: hit.name, prefixLen: pl };
    } else {
      // O início dos contents divergiu do prefixo cacheado (compactação de
      // histórico, imagens removidas no persist, ou outra conversa com o MESMO
      // system intercalando). Recria; com misses demais, desiste do histórico
      // por um tempo (senão viraria recriação a cada passo, preço cheio).
      hit.missCount = (hit.missCount || 0) + 1;
      console.log(`[gemini cache] prefixo divergiu (len=${pl}, misses=${hit.missCount}) — recriando`);
      if (hit.missCount >= HIST_MISS_LIMIT) {
        hit.histSkipUntil = now + HIST_SKIP_MS;
        cutoff = 0;
      }
    }
  } else if (hit?.skipUntil && hit.skipUntil > now) {
    return undefined; // cooldown após falha
  }

  const create = async (cut) => {
    const body = { model: `models/${model}`, ttl: `${TTL_SEC}s` };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (toolBlocks.length) body.tools = toolBlocks;
    if (search && hasTools) body.toolConfig = { includeServerSideToolInvocations: true };
    if (cut > 0) body.contents = contents.slice(0, cut);
    const r = await fetch(`${BASE}/cachedContents?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.log(`[gemini cache] create ${r.status} (hist=${cut}): ${(await r.text()).slice(0, 160)}`);
      return undefined;
    }
    return r.json();
  };

  try {
    let cut = cutoff;
    let data = await create(cut);
    if (!data && cut > 0) {
      // Falhou COM histórico (ex.: conteúdo que o cache não aceita): tenta o
      // piso (só system+tools, comportamento antigo) e desiste do histórico
      // por um tempo pra não repetir a falha a cada passo.
      if (hit) hit.histSkipUntil = now + HIST_SKIP_MS;
      cut = 0;
      data = await create(0);
    }
    if (!data) {
      if (validOld) { hit.growSkipUntil = now + 60000; return validOld; }
      caches.set(ck, { skipUntil: now + 60000, histSkipUntil: hit?.histSkipUntil });
      return undefined;
    }
    // Apaga o cache substituído (melhor esforço; expiraria sozinho em ≤5 min).
    if (hit?.name && hit.name !== data.name) {
      fetch(`${BASE}/${hit.name}?key=${key}`, { method: 'DELETE' }).catch(() => {});
    }
    caches.set(ck, {
      name: data.name, expireAt: now + TTL_SEC * 1000,
      prefixLen: cut, prefixHash: cut > 0 ? hashPrefix(contents, cut) : undefined,
      // missCount NÃO zera aqui: só um hit VÁLIDO zera (lá em cima). Senão o
      // ciclo miss->recria->miss (duas conversas intercalando) nunca acumularia
      // até o limite e recriaria o cache a preço cheio pra sempre.
      histSkipUntil: hit?.histSkipUntil, missCount: hit?.missCount || 0,
    });
    console.log(`[gemini cache] criado ${data.name} (~${data.usageMetadata?.totalTokenCount ?? '?'} tok, hist=${cut} msgs)`);
    return { name: data.name, prefixLen: cut };
  } catch (e) {
    console.log(`[gemini cache] erro: ${e?.message ?? e}`);
    if (validOld) { hit.growSkipUntil = now + 60000; return validOld; }
    caches.set(ck, { skipUntil: now + 60000, histSkipUntil: hit?.histSkipUntil });
    return undefined;
  }
}

// `search: true` liga o Google Search grounding nativo do Gemini — o modelo
// busca na web de verdade e responde com citações/links das fontes.
// `thinkingBudget`: limita (ou zera, com 0) os tokens de "pensamento" do modelo.
// Pensamento é cobrado como saída e domina o custo de turnos simples. Deixe
// undefined pra manter o padrão dinâmico do modelo (recomendado pro raciocínio
// pesado no Pro); use 0 em tarefas de housekeeping e um teto baixo no chat.
// `maxOutputTokens`: TETO RÍGIDO de saída por chamada. Sem isso, um loop de
// repetição do modelo corre até o máximo físico (64k tokens) e custa ~200
// créditos numa única resposta — foi o que torrou o crédito de um usuário em
// 30/06. 8192 (~6 mil palavras) é folgado pra qualquer resposta legítima e
// limita o estrago de uma geração degenerada a ~25 créditos.
// `apiKey`: chave vinda do modelos.yaml; sem ela, GEMINI_API_KEY de sempre.
export function makeGemini({ model = 'gemini-3.5-flash', search = false, thinkingBudget, maxOutputTokens = 8192, apiKey } = {}) {
  const key = apiKey ?? process.env.GEMINI_API_KEY;
  return wrapProvider({
    name: `gemini:${model}`,
    executionDelegate:()=>selectedDeepSeek(maxOutputTokens),
    async complete({ system, messages, tools = [] }) {
      const selected = selectedDeepSeek(maxOutputTokens);
      if (selected) return selected.complete({ system, messages, tools });
      // Msg[] -> formato Gemini (roles 'user' | 'model'; functionCall / functionResponse).
      const contents = [];
      for (const m of messages) {
        if (m.role === 'tool') {
          contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name, response: { result: m.content } } }] });
        } else if (m.role === 'assistant' && m.toolCalls?.length) {
          // Gemini 3 exige devolver o thoughtSignature que veio junto da turn.
          // Vem em UMA parte só (texto-pensamento ou a 1ª functionCall); as
          // demais não têm. Reemitimos exatamente como veio, na MESMA ordem e
          // no MESMO bloco de content (por isso o core agrupa a turn inteira).
          const parts = [];
          if (m.content) parts.push({ text: m.content });
          for (const c of m.toolCalls) {
            const part = { functionCall: { name: c.name, args: c.args } };
            if (c.meta?.thoughtSignature) part.thoughtSignature = c.meta.thoughtSignature;
            parts.push(part);
          }
          contents.push({ role: 'model', parts });
        } else {
          // Mensagem normal de texto. Se a mensagem do usuário trouxer imagens
          // (visão), anexa cada uma como inlineData no MESMO content, depois do texto.
          const role = m.role === 'assistant' ? 'model' : 'user';
          const parts = [];
          if (m.content) parts.push({ text: m.content });
          if (m.images?.length) for (const im of m.images) {
            if (im?.data) parts.push({ inlineData: { mimeType: im.mimeType || 'image/jpeg', data: im.data } });
          }
          if (!parts.length) parts.push({ text: '' });
          contents.push({ role, parts });
        }
      }

      const toolBlocks = [];
      if (tools.length) toolBlocks.push({ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeGeminiSchema(t.parameters) })) });
      if (search) toolBlocks.push({ google_search: {} });

      // Cache explícito: se o bloco estável (system+tools) é grande o bastante,
      // garantimos um CachedContent (que pode incluir um prefixo do histórico)
      // e referenciamos por `cachedContent` — aí o body NÃO repete system/tools/
      // toolConfig (vêm do cache) e envia só o SUFIXO dos `contents` que ficou
      // fora do prefixo cacheado (a API concatena cache + request).
      const estTokens = Math.ceil(((system?.length || 0) + JSON.stringify(toolBlocks).length) / 4);
      let cache;
      if (key && estTokens >= MIN_EST_TOKENS) {
        cache = await ensureCache({ key, model, system, toolBlocks, search, hasTools: tools.length > 0, contents });
      }

      // Teto de saída SEMPRE presente (trava anti-loop). thinkingConfig entra
      // só quando há budget definido.
      const generationConfig = { maxOutputTokens };
      if (thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget };
      const body = cache
        ? { contents: cache.prefixLen ? contents.slice(cache.prefixLen) : contents, cachedContent: cache.name, generationConfig }
        : {
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents,
            tools: toolBlocks.length ? toolBlocks : undefined,
            // Quando misturamos built-in (google_search) com functionDeclarations,
            // o Gemini exige essa flag pra permitir invocar a tool server-side.
            toolConfig: (search && tools.length)
              ? { includeServerSideToolInvocations: true }
              : undefined,
            generationConfig,
          };

      const res = await fetchRetry(`${BASE}/models/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, `gemini ${model}`, {
        provider:'gemini',model,body,ready:()=>!!key,
        quoteBody:{systemInstruction:system?{parts:[{text:system}]}:undefined,contents,tools:toolBlocks,generationConfig},
        readUsage:data=>geminiAttemptUsage(data,model),
        ...(contents.some(c=>c.parts?.some(p=>p.inlineData||p.fileData))?{
          countInput:async spec=>{
            const request={...spec.quoteBody,model:'models/'+model};
            const r=await fetch(BASE+'/models/'+model+':countTokens?key='+key,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({generateContentRequest:request}),signal:AbortSignal.timeout(20000)});
            if(!r.ok)throw Error('Multimodal input count unavailable');
            const data=await r.json();if(!Number.isSafeInteger(data.totalTokens)||data.totalTokens<0)throw Error('Invalid multimodal input count');
            return data.totalTokens+512; // framing margin; actual API usage is billed
          },
        }:{}),
      });
      if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
      const data = await res.json();

      // ── Instrumentação de custo/cache ──
      // O Gemini devolve usageMetadata em toda resposta. Logamos pra enxergar
      // quanto cada turno gasta e quanto veio do cache implícito (90% off).
      const u = data.usageMetadata ?? {};
      const inTok = u.promptTokenCount ?? 0;
      const cached = u.cachedContentTokenCount ?? 0;
      const outTok = u.candidatesTokenCount ?? 0;
      const think = u.thoughtsTokenCount ?? 0;
      const hit = inTok ? Math.round((cached / inTok) * 100) : 0;
      console.log(`[gemini cost] model=${model} in=${inTok} cache=${cached}(${hit}%) out=${outTok} think=${think} total=${u.totalTokenCount ?? 0}`);
      // usage: o caller persiste com as dimensões (usuário/conversa/tipo).
      const usage = { model, in: inTok, cached, out: outTok, think, total: u.totalTokenCount ?? 0 };

      const parts = data.candidates?.[0]?.content?.parts ?? [];
      // finishReason=MAX_TOKENS: a geração bateu no teto de saída e foi CORTADA.
      // Se o corte pegou o modelo no meio do "pensamento" (antes de emitir a
      // functionCall/texto), sobra parts só de thought -> text vazio. Sinalizamos
      // truncated pro core NÃO tratar isso como fim seco (e nunca devolver branco).
      const truncated = data.candidates?.[0]?.finishReason === 'MAX_TOKENS';
      // O thoughtSignature da turn pode vir numa parte de pensamento OU na 1ª
      // functionCall. Capturamos o da turn e usamos de fallback na 1ª call, pra
      // garantir que a turn sempre carregue a assinatura ao voltar pro Gemini.
      const turnSig = parts.find((p) => p.thoughtSignature)?.thoughtSignature;
      const toolCalls = parts.filter((p) => p.functionCall)
        .map((p, i) => ({
          id: nextId(),
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
          meta: { thoughtSignature: p.thoughtSignature || (i === 0 ? turnSig : undefined) },
        }));
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      // Fontes da busca NATIVA (google_search). Ela roda no servidor do Google e
      // NÃO aparece como tool call, então até 08/09 as URLs reais que embasaram a
      // resposta eram jogadas fora aqui e sobrava o modelo escrevendo endereço de
      // memória (receita de link 404: caso LinkedIn, 2 dos 9 links quebrados).
      // Devolvemos junto com o resultado; quem monta a resposta decide se mostra.
      const sources = extractSources(data.candidates?.[0]);
      return toolCalls.length
        ? { stop: STOP.TOOL, toolCalls, text: text || undefined, usage, truncated, sources }
        : { stop: STOP.END, text, usage, truncated, sources };
    },
  });
}

// groundingChunks -> [{title, uri}] sem repetir URL. As URIs vêm como redirect
// opaco do vertexaisearch; quem exibe resolve pro destino real antes de mostrar.
function extractSources(cand) {
  const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
  const sources = [];
  const seen = new Set();
  for (const c of chunks) {
    const w = c?.web;
    if (w?.uri && !seen.has(w.uri)) { seen.add(w.uri); sources.push({ title: w.title || w.uri, uri: w.uri }); }
  }
  return sources;
}

// ── Busca na web "avulsa" (Gemini como buscador) ──
// Faz UMA chamada grounded (google_search ligado, sem tools de função) e devolve
// o texto-resposta + as fontes (groundingChunks). Serve pra dar grounding a
// modelos que NÃO têm busca embutida (ex.: OpenAI): expomos uma tool `buscar_web`
// no tool-loop cujo backend é esta função, reaproveitando a cota grátis do Gemini
// (5k buscas/mês). thinkingBudget 0: a "cabeça" é do modelo principal, aqui só
// queremos recuperar fatos+links. Devolve usage no shape padrão pra entrar no
// pipeline de custo (kind='search').
export async function groundedSearch(query, { model = 'gemini-3.5-flash' } = {}) {
  if (isDeepSeekTurn()) throw new Error('Grounding Gemini desabilitado: este assistente usa DeepSeek com Tavily.');
  const key = process.env.GEMINI_API_KEY;
  const body = {
    contents: [{ role: 'user', parts: [{ text: String(query || '').slice(0, 2000) }] }],
    tools: [{ google_search: {} }],
    // systemInstruction genérica: o retriever deve devolver DADOS CONCRETOS extraídos
    // das fontes (nomes próprios, números, endereços), várias opções quando fizer
    // sentido, e nada inventado. Serve pra qualquer tipo de busca (preço, lugar,
    // produto, notícia). O modelo principal é quem "monta" a resposta; aqui a meta é
    // maximizar densidade de fato útil por busca.
    systemInstruction: {
      parts: [{
        text: 'Você é um motor de busca. Responda em pt-BR, denso e objetivo, SÓ com o que as fontes trazem (não invente nada). Extraia dados CONCRETOS: nomes próprios (lugares, produtos, marcas, empresas), números (preços, horários, datas), endereços/bairros. Quando a consulta pedir opções (lugares, restaurantes, produtos), liste VÁRIAS opções nomeadas com um dado distintivo de cada uma. Se algo não estiver nas fontes, não preencha; deixe de fora.',
      }],
    },
    generationConfig: { maxOutputTokens: 3072, thinkingConfig: { thinkingBudget: 0 } },
  };
  const res = await fetchRetry(`${BASE}/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, 'gemini search');
  if (!res.ok) throw new Error(`gemini search ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const u = data.usageMetadata ?? {};
  const usage = {
    model, in: u.promptTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0,
    out: u.candidatesTokenCount ?? 0, think: u.thoughtsTokenCount ?? 0, total: u.totalTokenCount ?? 0,
  };
  const cand = data.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  const sources = extractSources(cand);
  console.log(`[gemini search] model=${model} in=${usage.in} out=${usage.out} fontes=${sources.length}`);
  return { text, sources, usage };
}

// Roteador simples: 3.5 Flash por padrão, escala pro 3.1 Pro quando a tarefa
// parece exigir raciocínio mais pesado. Heurística trocável; a ideia é mostrar
// que dá pra misturar modelos no MESMO loop.
export function makeGeminiRouter({
  fast = 'gemini-3.5-flash',
  heavy = 'gemini-3.1-pro-preview',
  search = false,
  // Teto de pensamento: baixo no Flash (chat simples não precisa raciocinar
  // muito), dinâmico no Pro (undefined) pra preservar o raciocínio pesado.
  fastThinking = 512,
  heavyThinking = undefined,
  isHeavy = (text) => /(compare|analise|por que|explique|estratégia|trade-?off|melhor opção entre)/i.test(text),
} = {}) {
  return {
    name: `gemini:router(${fast}|${heavy})${search ? '+search' : ''}`,
    async complete(input) {
      const firstUser = input.messages.find((m) => m.role === 'user')?.content ?? '';
      const useHeavy = isHeavy(firstUser);
      const model = useHeavy ? heavy : fast;
      const thinkingBudget = useHeavy ? heavyThinking : fastThinking;
      return makeGemini({ model, search, thinkingBudget }).complete(input);
    },
  };
}

function geminiAttemptUsage(data,model){
 const u=data?.usageMetadata;
 if(!u||!Number.isSafeInteger(u.promptTokenCount))throw Error('Provider did not report usage');
 return {model,in:u.promptTokenCount,cached:u.cachedContentTokenCount??0,out:u.candidatesTokenCount??0,think:u.thoughtsTokenCount??0,total:u.totalTokenCount??0};
}
