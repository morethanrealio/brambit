
// ── Price table per model (US$ per 1 million tokens) ──
// Used to freeze the cost of each call at recording time. Update
// here when Google changes prices (doesn't change what's already recorded in history).
// Fields: in (input), cachedIn (input that came from cache, ~90% off),
// out (output — includes "thinking" tokens, which are billed as output).
// Official prices verified on 2026-06-27 (ai.google.dev/gemini-api/docs/pricing).
const PRICES = {
  // Together public standard rates verified 2026-09-13; no DeepSeek-direct peak discount.
  'deepseek-ai/DeepSeek-V4.1-Flash': { in: 0.30, cachedIn: 0.006, out: 1.20 },
  // Official API, peak USD/1M on 2026-09-11. Provider tags off-peak calls.
  'deepseek-flash': { in: 0.30, cachedIn: 0.006, out: 1.20 },
  // 3.1 Flash-Lite: $0.25 in / $1.50 out / cache $0.025 (ai.google.dev/pricing, 2026-06-29).
  // Much cheaper than Flash — economy option offered to the user.
  'gemini-3.1-flash-lite':  { in: 0.25, cachedIn: 0.025, out: 1.50 },
  // 3 Flash Preview: $0.50 in / $3.00 out / cache $0.05 (ai.google.dev/pricing, 2026-06-29).
  // Generation 3, intermediate between Lite and 3.5 Flash. It is the product's DEFAULT.
  'gemini-3-flash-preview': { in: 0.50, cachedIn: 0.05, out: 3.00 },
  // 3.5 Flash: $1,50 in / $9,00 out / cache $0,15 (era 0,30/2,50 — subfaturado).
  'gemini-3.5-flash':       { in: 1.50, cachedIn: 0.15, out: 9.00 },
  // 3.7 Flash: INTRO price $0.75 in / $3.75 out / cache ~$0.075 (10% off), valid
  // until end/2026 (eval 2026-08-18). Candidate for PRIMARY text model (best tool-calling
  // in the test). Enabled via env PRIMARY_TEXT_MODEL=gemini-3.7-flash (test mode).
  'gemini-3.7-flash':       { in: 0.75, cachedIn: 0.075, out: 3.75 },
  // 3.1 Pro Preview (<=200k/req): $2,00 in / $12,00 out / cache $0,20.
  'gemini-3.1-pro-preview': { in: 2.00, cachedIn: 0.20, out: 12.0 },
  // IMAGE (Nano Banana): text in $0.30/M; output $30/M, 1290 tok/img = $0.039/img (~39 credits).
  'gemini-2.5-flash-image': { in: 0.30, cachedIn: 0.075, out: 30.0 },
  // VOICE (TTS): text in $0.30/M; audio out ~$10/M (~25 tok/s → ~15 credits/min). Check on the 1st invoice.
  'gemini-2.5-flash-preview-tts': { in: 0.30, cachedIn: 0.075, out: 10.0 },
  // STT (audio transcription) uses gemini-3.5-flash itself (audio comes in as multimodal
  // input, $1.50/M, ~32 tok/s → <1 credit/min). No line of its own: falls into the Flash above.
  // ── OpenAI (alternative test, check live prices: developers.openai.com/api/docs/pricing) ──
  // GPT-5 mini (old): $0.25 in / $2.00 out / cache ~$0.025 (10% off).
  'gpt-5-mini':   { in: 0.25, cachedIn: 0.025, out: 2.00 },
  // GPT-5.4 mini (newest of the 5.4 family): $0.75 in / $4.50 out / cache ~$0.075 (10% off).
  // This is what the product uses via id 'gpt5mini'. More expensive than the old 5-mini, gain = quality.
  'gpt-5.4-mini': { in: 0.75, cachedIn: 0.075, out: 4.50 },
  // GPT-4.1 mini: $0,40 in / $1,60 out / cache ~$0,10 (25% off).
  'gpt-4.1-mini': { in: 0.40, cachedIn: 0.10,  out: 1.60 },
  // GPT-4.1 nano: $0.10 in / $0.40 out / cache ~$0.025. The cheapest (Lite tier).
  'gpt-4.1-nano': { in: 0.10, cachedIn: 0.025, out: 0.40 },
  // ── Together AI (alternative test; GLM-5.2 much faster than on DeepInfra) ──
  // GLM-5.2 (zai-org/GLM-5.2) on Together: $1.40 in / $4.40 out / cache $0.26 (together.ai/pricing).
  'zai-org/GLM-5.2': { in: 1.40, cachedIn: 0.26, out: 4.40 },
  // ── DeepInfra (product's CHEAP tier) ──
  // GLM-4.7 (zai-org/GLM-4.7) on DeepInfra: $0.40 in / $1.75 out (deepinfra.com/pricing,
  // 2026-07-24). It's the cheap tier: ~65% cheaper than 5.2 and, with reasoning off, ~1-2s.
  'zai-org/GLM-4.7': { in: 0.40, cachedIn: 0.10, out: 1.75 },
  // ── Kimi K3 (Moonshot) — ADVANCED optional model, manually assigned per
  // agent (outside the routing). Runs on demand (serverless). Uniform market
  // price: $3 in / $15 out / cache $0.30 (Together, Moonshot, Fireworks, etc.,
  // verified 2026-08-07). DeepInfra does NOT serve K3 (only the K2.x line), so the
  // K3 provider is Together. The exact id comes via env (KIMI_MODEL).
  'moonshotai/kimi-k3': { in: 3.00, cachedIn: 0.30, out: 15.0 },
  'moonshotai/Kimi-K3': { in: 3.00, cachedIn: 0.30, out: 15.0 },
  // ── DeepSeek V4 Pro — legacy/selectable model for routes that still use
  // DEEPSEEK_MODEL. Coding and spreadsheets use V4.1 Flash in another entry above.
  // ⚠️ The price below is for the provider IN USE, not the model: the same id is served by
  // Together (1.32/0.13/3.96) and DeepInfra (1.30/0.10/2.60), and
  // DEEPSEEK_PROVIDER decides which. Currently = TOGETHER (2026-08-30), read from their
  // API the same day (GET /v1/models -> input 1.32 / cached_input 0.13 / output 3.96).
  // Went back to Together because DeepInfra has a latency tail that makes the
  // model unviable on the main turn: in the grounding eval of 2026-08-30 the SAME question took
  // 121s in one round and 7s in the next, while Together stayed at 3.9-10.2s.
  // Comes out ~52% more expensive on output; the gain is a response that doesn't stall.
  // If DEEPSEEK_PROVIDER goes back to deepinfra, this line goes back to 1.30/0.10/2.60.
  // This only affects the recorded COST (margin report); the user's BILLING doesn't
  // change, the model is in the 'normal' tier of BILL_TIER_BY_MODEL.
  // Both variants are included because the exact id comes via env and the snapshot is the default.
  'deepseek-ai/DeepSeek-V4-Pro-0813': { in: 1.32, cachedIn: 0.13, out: 3.96 },
  'deepseek-ai/DeepSeek-V4-Pro':      { in: 1.74, cachedIn: 0.20, out: 3.48 },

  // ── DeepSeek V4 Flash (DeepInfra) — 'cheap' tier model (reading
  // sub-agents: research/workspace/connectors) since 2026-08-29, via CHEAP_MODEL in
  // .env (before: GLM-4.7). $0.08 in / $0.18 out / cache $0.016
  // (deepinfra.com/pricing, quoted 2026-08-28).
  'deepseek-ai/DeepSeek-V4-Flash': { in: 0.08, cachedIn: 0.016, out: 0.18 },
  // ── Web search via Tavily (per call, not per token) ──
  // Tavily "basic" ~$0.008/search. We model it as 1 "output token" at US$8/M so
  // costOf returns ~$0.008 without inventing a new field (in=0 → only out counts).
  'tavily-search':   { in: 0.0, cachedIn: 0.0, out: 8000.0 },
  // ── Flight search (Google Flights via SerpApi), also per call ──
  // Same trick as Tavily: 1 "output token" = 1 search. US$0.015/search is the
  // price of the 5,000 searches/month plan (US$75), the first paid tier that makes
  // sense for this feature. While we're in the current plan's free allowance,
  // the server zeroes the cost (SEARCH_FREE_MONTHLY in server.mjs).
  'serpapi-flights': { in: 0.0, cachedIn: 0.0, out: 15000.0 },
  // Search telemetry events, not provider calls. They need to be
  // explicit here: they reach costOf with zero tokens and must not look like
  // a new model with no price in the operational alert.
  'tavily-erro':  { in: 0.0, cachedIn: 0.0, out: 0.0 },
  'tavily-quota': { in: 0.0, cachedIn: 0.0, out: 0.0 },
  'websearch-bug': { in: 0.0, cachedIn: 0.0, out: 0.0 },
};

// Conservative fallback for unknown model (uses the Flash tier).
const DEFAULT_PRICE = { in: 1.50, cachedIn: 0.15, out: 9.00 };
const missingPriceByModel = new Map();

function safeModelId(model) {
  const id = String(model ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160);
  return id || '(vazio)';
}

function observeMissingPrice(model) {
  const id = safeModelId(model);
  const now = new Date().toISOString();
  const previous = missingPriceByModel.get(id);
  if (previous) {
    previous.hits++;
    previous.lastSeen = now;
    return;
  }
  missingPriceByModel.set(id, { model: id, hits: 1, firstSeen: now, lastSeen: now });
  // One line per id and per process: draws attention without flooding the journal on
  // every costOf/billCreditsOf of the same call.
  console.warn(`[pricing] preço ausente para ${id}, usando fallback`);
}

// Read-only telemetry of the current process. The dashboard updates every
// 15s; swapping a model via env without registering the price becomes visible the same day.
export function pricingFallbackMetrics() {
  const models = [...missingPriceByModel.values()]
    .map((entry) => ({ ...entry }))
    .sort((a, b) => b.hits - a.hits || a.model.localeCompare(b.model));
  return {
    total: models.reduce((sum, entry) => sum + entry.hits, 0),
    unique: models.length,
    models,
  };
}

// Prices declared in the precos section of modelos.yaml (whoever installs provides their
// provider's prices). They win over the table above for the same model id.
export function registerPrices(prices = {}) {
  for (const [model, p] of Object.entries(prices)) PRICES[model] = p;
}

export function priceFor(model) {
  if (Object.prototype.hasOwnProperty.call(PRICES, model)) return PRICES[model];
  observeMissingPrice(model);
  return DEFAULT_PRICE;
}

// Calculates the US$ cost of a call from the provider's usage.
// `u` = { model, in, cached, out, think, total }.
// - input tokens billed in full, minus the ones that came from cache (90% off);
// - think goes together with out (output) — Gemini already sums think inside
//   candidatesTokenCount in some models, but when it comes separate we add it.
export function costOf(u) {
  if (!u) return 0;
  const base = priceFor(u.model);
  const p = u.model === 'deepseek-flash' && u.deepseekPeak === false
    ? { in: base.in / 2, cachedIn: base.cachedIn / 2, out: base.out / 2 } : base;
  const cached = u.cached || 0;
  const inFull = Math.max(0, (u.in || 0) - cached);
  const out = (u.out || 0) + (u.think || 0);
  const cost =
    (inFull * p.in + cached * p.cachedIn + out * p.out) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6; // 6 casas (numeric(12,6))
}
