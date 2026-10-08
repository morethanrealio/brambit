import {wrapProvider} from '../provider-attempt.mjs';
import {providerAttempt,hasProviderAttempts,throwIfAttemptControl} from '../provider-attempt.mjs';
// ── Real adapter: Google Gemini (generateContent) ──
// Same contract as the other providers. The key comes from process.env.GEMINI_API_KEY
// (NEVER hardcode in the repo). Recommended: 3.5 Flash as the default orchestrator and
// 3.1 Pro Preview as the heavy-reasoning fallback.

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
const RETRY_DELAYS = [600, 1800]; // ms; jitter added at call time
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch + retry. Returns the final response (ok or not); the caller keeps treating
// !res.ok as before, so a persistent failure keeps escalating to the fallback.
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
      // Network failure (socket/DNS/timeout): same retry policy.
      if (i >= RETRY_DELAYS.length) throw e;
      console.warn(`[${tag}] falha de rede (${e?.message ?? e}), tentativa ${i + 1}/${RETRY_DELAYS.length}`);
    }
    await sleep(RETRY_DELAYS[i] + Math.floor(Math.random() * 400));
  }
}

// ── Tool schema sanitization for Gemini's OpenAPI subset ──
// Our tools' schemas are standard JSON Schema (accepted by GLM/OpenAI), but
// Gemini only accepts a SUBSET of OpenAPI: fields like `additionalProperties`,
// `$schema`, `$defs`, `patternProperties` etc. break the call with a 400
// ("Unknown name ... Cannot find field"). This only showed up now because Gemini
// was only called on paths that passed few/no tools (vision/search);
// routing TEXT through it brings the whole tool suite along, and one of them has
// additionalProperties. We recursively remove the incompatible keys, without
// touching the valid content (type/description/properties/items/required/enum...).
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

// ── Explicit cache (CachedContent) ──
// The tool-loop calls complete() N times in the SAME turn with the SAME system + tools
// (only `contents` grows at each step). This stable prefix is large (agent prompt
// + memory + dozens of tools) and was resent in full at every step — which
// made a 13-step turn cost ~230 credits. Here we store this
// prefix in a CachedContent and reference it via `cachedContent`: the repeated input
// drops ~90% (cachedContentTokenCount). Since Fix#3 the datetime and the volatile blocks
// moved out of the system (they go at the end of the user message), so the prefix is
// ALSO byte-identical between turns — the cache serves the whole turn AND the
// following turns of an active conversation, as long as it keeps getting renewed (see sliding TTL).
//
// HISTORY IN THE CACHE: besides system+tools, we cache a PREFIX of the
// conversation history (`contents`), which in a long coding session goes past 100k tokens
// and was resent at full price at every step (which is why the cached slice got stuck
// at ~44% while gpt-5.4-mini got 73% with implicit cache). Rules:
// - Only caches up to `len - HIST_TAIL_KEEP`: the last messages can still be
//   mutated by the core (pruneTurnBlobs collects blobs when they leave the
//   recent window of TURN_KEEP_RECENT=4); outside that tail the history is immutable
//   WITHIN the process. Between turns there are two exceptions (history compaction
//   and image removal on persist) — that's why the cached prefix is validated
//   by HASH on every use and recreated when it diverges.
// - The suffix sent in the request always starts on a message with role 'user'
//   (API ordering requirement; preserves functionCall/Response pairing).
// - Recreating charges the prefix ONCE at normal input price; after that each step
//   pays 10% of it. It pays off from ~1.1 uses onward — we recreate when the
//   non-cached suffix accumulates estimated HIST_REFRESH_TOKENS.
const TTL_SEC = 300; // Short TTL avoids paying for storage needlessly in a conversation that's over
// SLIDING TTL: when a hit finds the cache with less than half its lifetime left,
// we renew the TTL via PATCH (cheap) — an active conversation never lets the cache die;
// a stalled conversation expires in ≤5 min and stops paying for storage.
const REFRESH_BELOW_MS = (TTL_SEC * 1000) / 2;
// Minimum tokens to create a cache on 3.5 Flash = 4096. We estimate via chars/4
// (which overestimates ~15%), so we only try above 5000 est. to avoid landing
// below the real minimum and getting a 400. Smaller blocks don't pay off anyway.
const MIN_EST_TOKENS = 5000;
// History in the cache: never caches the last N messages (the core can still
// mutate them — TURN_KEEP_RECENT=4 + safety margin).
const HIST_TAIL_KEEP = 6;
// Recreates the cache (pushing the cutoff forward) when the non-cached suffix
// accumulates this many estimated tokens (chars/4). Below that, reusing the existing
// cache and paying for the whole suffix is cheaper than recreating.
const HIST_REFRESH_TOKENS = 5000;
// Consecutive hash-misses on the prefix (e.g.: two conversations interleaving with the
// SAME system) -> gives up on the history for a while and caches only system+tools,
// otherwise every step would recreate the cache paying the prefix at full price.
const HIST_MISS_LIMIT = 3;
const HIST_SKIP_MS = 10 * 60 * 1000;
const caches = new Map(); // hash(model+system+tools) -> {name,expireAt,prefixLen,prefixHash,...} | {skipUntil}

function cacheKey(model, system, toolBlocks) {
  return createHash('sha256')
    .update(model).update('\0').update(system || '').update('\0')
    .update(JSON.stringify(toolBlocks)).digest('hex');
}

// Hash of the history prefix that went into the cache: validates on every use that the
// request's `contents` still START byte-identical to what is cached
// (otherwise Gemini would respond with duplicated/wrong context).
function hashPrefix(contents, len) {
  return createHash('sha256').update(JSON.stringify(contents.slice(0, len))).digest('hex');
}

// Ensures a live CachedContent for the prefix (model+system+tools+history
// prefix). Returns { name, prefixLen } — prefixLen is how many messages from the
// start of `contents` are INSIDE the cache (the caller sends only the suffix) —
// or undefined if it didn't work out (falls back to inline sending).
// The tool-loop calls are sequential (await), so there's no race within
// a turn; between turns/users the key differs (system carries memory/owner).
async function ensureCache({ key, model, system, toolBlocks, search, hasTools, contents }) {
  const ck = cacheKey(model, system, toolBlocks);
  const now = Date.now();
  if (caches.size > 200) for (const [k, v] of caches) if ((v.expireAt || v.skipUntil || 0) < now) caches.delete(k);
  const hit = caches.get(ck);

  // How much of the history can be cached now: everything except the recent tail, and the
  // suffix left for the request has to start at role 'user'.
  let cutoff = (hit?.histSkipUntil && hit.histSkipUntil > now)
    ? 0
    : Math.max(0, contents.length - HIST_TAIL_KEEP);
  while (cutoff > 0 && contents[cutoff].role !== 'user') cutoff--;

  let validOld; // cache alive and intact; fallback if recreation (growth) fails
  if (hit?.name && hit.expireAt > now + 5000) {
    const pl = hit.prefixLen || 0;
    const valid = pl === 0 || (pl < contents.length && hit.prefixHash === hashPrefix(contents, pl));
    if (valid) {
      hit.missCount = 0;
      // Sliding TTL: renews when past half its lifetime. A PATCH failure doesn't
      // bring anything down — the cache stays valid until the expireAt we already had.
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
      // Did the non-cached suffix grow? Recreate the cache with the cutoff moved
      // further forward (pays the prefix once, saves 90% of it on the following steps).
      const sufEst = Math.ceil(JSON.stringify(contents.slice(pl)).length / 4);
      const grow = cutoff >= pl + 2 && sufEst >= HIST_REFRESH_TOKENS
        && !(hit.growSkipUntil && hit.growSkipUntil > now);
      if (!grow) return { name: hit.name, prefixLen: pl };
      validOld = { name: hit.name, prefixLen: pl };
    } else {
      // The start of contents diverged from the cached prefix (history
      // compaction, images removed on persist, or another conversation with the SAME
      // system interleaving). Recreates; with too many misses, gives up on the history
      // for a while (otherwise it would become a recreation on every step, at full price).
      hit.missCount = (hit.missCount || 0) + 1;
      console.log(`[gemini cache] prefixo divergiu (len=${pl}, misses=${hit.missCount}) — recriando`);
      if (hit.missCount >= HIST_MISS_LIMIT) {
        hit.histSkipUntil = now + HIST_SKIP_MS;
        cutoff = 0;
      }
    }
  } else if (hit?.skipUntil && hit.skipUntil > now) {
    return undefined; // cooldown after failure
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
      // Failed WITH history (e.g.: content the cache doesn't accept): tries the
      // floor (only system+tools, old behavior) and gives up on the history
      // for a while so as not to repeat the failure on every step.
      if (hit) hit.histSkipUntil = now + HIST_SKIP_MS;
      cut = 0;
      data = await create(0);
    }
    if (!data) {
      if (validOld) { hit.growSkipUntil = now + 60000; return validOld; }
      caches.set(ck, { skipUntil: now + 60000, histSkipUntil: hit?.histSkipUntil });
      return undefined;
    }
    // Deletes the replaced cache (best effort; it would expire on its own in ≤5 min).
    if (hit?.name && hit.name !== data.name) {
      fetch(`${BASE}/${hit.name}?key=${key}`, { method: 'DELETE' }).catch(() => {});
    }
    caches.set(ck, {
      name: data.name, expireAt: now + TTL_SEC * 1000,
      prefixLen: cut, prefixHash: cut > 0 ? hashPrefix(contents, cut) : undefined,
      // missCount does NOT reset here: only a VALID hit resets it (up above). Otherwise the
      // miss->recreate->miss cycle (two conversations interleaving) would never accumulate
      // up to the limit and would recreate the cache at full price forever.
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

// `search: true` turns on Gemini's native Google Search grounding — the model
// actually searches the web and responds with citations/links to the sources.
// `thinkingBudget`: limits (or zeroes, with 0) the model's "thinking" tokens.
// Thinking is charged as output and dominates the cost of simple turns. Leave it
// undefined to keep the model's dynamic default (recommended for heavy
// reasoning on Pro); use 0 for housekeeping tasks and a low ceiling in chat.
// `maxOutputTokens`: HARD output ceiling per call. Without this, a model
// repetition loop runs up to the physical max (64k tokens) and costs ~200
// credits in a single response — that's what burned through a user's credit on
// 2026-06-30. 8192 (~6 thousand words) is generous for any legitimate response and
// limits the damage of a degenerate generation to ~25 credits.
// `apiKey`: key coming from modelos.yaml; without it, the usual GEMINI_API_KEY.
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
          // Gemini 3 requires returning the thoughtSignature that came along with the turn.
          // It comes in only ONE part (thinking-text or the 1st functionCall); the
          // rest don't have it. We re-emit it exactly as it came, in the SAME order and
          // in the SAME content block (that's why the core groups the whole turn).
          const parts = [];
          if (m.content) parts.push({ text: m.content });
          for (const c of m.toolCalls) {
            const part = { functionCall: { name: c.name, args: c.args } };
            if (c.meta?.thoughtSignature) part.thoughtSignature = c.meta.thoughtSignature;
            parts.push(part);
          }
          contents.push({ role: 'model', parts });
        } else {
          // Normal text message. If the user's message brings images
          // (vision), attach each one as inlineData in the SAME content, after the text.
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

      // Explicit cache: if the stable block (system+tools) is large enough,
      // we ensure a CachedContent (which may include a history prefix)
      // and reference it via `cachedContent` — then the body does NOT repeat system/tools/
      // toolConfig (they come from the cache) and sends only the SUFFIX of `contents` that was
      // left out of the cached prefix (the API concatenates cache + request).
      const estTokens = Math.ceil(((system?.length || 0) + JSON.stringify(toolBlocks).length) / 4);
      let cache;
      if (key && estTokens >= MIN_EST_TOKENS) {
        cache = await ensureCache({ key, model, system, toolBlocks, search, hasTools: tools.length > 0, contents });
      }

      // Output ceiling ALWAYS present (anti-loop guard). thinkingConfig only comes
      // in when a budget is defined.
      const generationConfig = { maxOutputTokens };
      if (thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget };
      const body = cache
        ? { contents: cache.prefixLen ? contents.slice(cache.prefixLen) : contents, cachedContent: cache.name, generationConfig }
        : {
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents,
            tools: toolBlocks.length ? toolBlocks : undefined,
            // When we mix a built-in (google_search) with functionDeclarations,
            // Gemini requires this flag to allow invoking the tool server-side.
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

      // ── Cost/cache instrumentation ──
      // Gemini returns usageMetadata on every response. We log it to see
      // how much each turn spends and how much came from the implicit cache (90% off).
      const u = data.usageMetadata ?? {};
      const inTok = u.promptTokenCount ?? 0;
      const cached = u.cachedContentTokenCount ?? 0;
      const outTok = u.candidatesTokenCount ?? 0;
      const think = u.thoughtsTokenCount ?? 0;
      const hit = inTok ? Math.round((cached / inTok) * 100) : 0;
      console.log(`[gemini cost] model=${model} in=${inTok} cache=${cached}(${hit}%) out=${outTok} think=${think} total=${u.totalTokenCount ?? 0}`);
      // usage: the caller persists it with the dimensions (user/conversation/type).
      const usage = { model, in: inTok, cached, out: outTok, think, total: u.totalTokenCount ?? 0 };

      const parts = data.candidates?.[0]?.content?.parts ?? [];
      // finishReason=MAX_TOKENS: the generation hit the output ceiling and was CUT OFF.
      // If the cut caught the model in the middle of "thinking" (before emitting the
      // functionCall/text), only thought parts are left -> empty text. We flag it as
      // truncated so the core does NOT treat this as a clean end (and never returns blank).
      const truncated = data.candidates?.[0]?.finishReason === 'MAX_TOKENS';
      // The turn's thoughtSignature can come in a thinking part OR in the 1st
      // functionCall. We capture the turn's and use it as a fallback on the 1st call, to
      // guarantee that the turn always carries the signature when it goes back to Gemini.
      const turnSig = parts.find((p) => p.thoughtSignature)?.thoughtSignature;
      const toolCalls = parts.filter((p) => p.functionCall)
        .map((p, i) => ({
          id: nextId(),
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
          meta: { thoughtSignature: p.thoughtSignature || (i === 0 ? turnSig : undefined) },
        }));
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      // Sources from the NATIVE search (google_search). It runs on Google's server and
      // does NOT appear as a tool call, so until 2026-09-08 the real URLs that grounded the
      // response were being thrown away here, leaving the model to write an address
      // from memory (recipe for a 404 link: LinkedIn case, 2 of 9 broken links).
      // We return it together with the result; whoever assembles the response decides whether to show it.
      const sources = extractSources(data.candidates?.[0]);
      return toolCalls.length
        ? { stop: STOP.TOOL, toolCalls, text: text || undefined, usage, truncated, sources }
        : { stop: STOP.END, text, usage, truncated, sources };
    },
  });
}

// groundingChunks -> [{title, uri}] without repeating URL. The URIs come as an opaque
// redirect from vertexaisearch; whoever displays it resolves to the real destination before showing it.
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

// ── Standalone web search (Gemini as a search engine) ──
// Makes ONE grounded call (google_search on, no function tools) and returns
// the response text + the sources (groundingChunks). Used to give grounding to
// models that do NOT have built-in search (e.g.: OpenAI): we expose a `buscar_web` tool
// in the tool-loop whose backend is this function, reusing Gemini's free quota
// (5k searches/month). thinkingBudget 0: the "thinking" is the main model's job, here we
// just want to retrieve facts+links. Returns usage in the standard shape so it enters the
// cost pipeline (kind='search').
export async function groundedSearch(query, { model = 'gemini-3.5-flash' } = {}) {
  if (isDeepSeekTurn()) throw new Error('Grounding Gemini desabilitado: este assistente usa DeepSeek com Tavily.');
  const key = process.env.GEMINI_API_KEY;
  const body = {
    contents: [{ role: 'user', parts: [{ text: String(query || '').slice(0, 2000) }] }],
    tools: [{ google_search: {} }],
    // Generic systemInstruction: the retriever must return CONCRETE DATA extracted
    // from the sources (proper names, numbers, addresses), multiple options when it makes
    // sense, and nothing made up. Used for any kind of search (price, place,
    // product, news). The main model is the one that "assembles" the response; here the goal is
    // to maximize useful-fact density per search.
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

// Simple router: 3.5 Flash by default, scales up to 3.1 Pro when the task
// seems to require heavier reasoning. Swappable heuristic; the idea is to show
// that it's possible to mix models in the SAME loop.
export function makeGeminiRouter({
  fast = 'gemini-3.5-flash',
  heavy = 'gemini-3.1-pro-preview',
  search = false,
  // Thinking ceiling: low on Flash (simple chat doesn't need to reason
  // much), dynamic on Pro (undefined) to preserve heavy reasoning.
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
