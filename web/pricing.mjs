
// ── Tabela de preços por modelo (US$ por 1 milhão de tokens) ──
// Usada pra congelar o custo de cada chamada no momento da gravação. Atualize
// aqui quando o Google mudar os preços (não muda o histórico já gravado).
// Campos: in (entrada), cachedIn (entrada que veio do cache, ~90% off),
// out (saída — inclui tokens de "pensamento", que são cobrados como saída).
// Preços oficiais verificados em 27/06/2026 (ai.google.dev/gemini-api/docs/pricing).
const PRICES = {
  // Together public standard rates verified 2026-09-13; no DeepSeek-direct peak discount.
  'deepseek-ai/DeepSeek-V4.1-Flash': { in: 0.30, cachedIn: 0.006, out: 1.20 },
  // Official API, peak USD/1M on 2026-09-11. Provider tags off-peak calls.
  'deepseek-flash': { in: 0.30, cachedIn: 0.006, out: 1.20 },
  // 3.1 Flash-Lite: $0,25 in / $1,50 out / cache $0,025 (ai.google.dev/pricing, 29/06).
  // Bem mais barato que o Flash — opção econômica oferecida ao usuário.
  'gemini-3.1-flash-lite':  { in: 0.25, cachedIn: 0.025, out: 1.50 },
  // 3 Flash Preview: $0,50 in / $3,00 out / cache $0,05 (ai.google.dev/pricing, 29/06).
  // Geração 3, intermediário entre o Lite e o 3.5 Flash. É o PADRÃO do produto.
  'gemini-3-flash-preview': { in: 0.50, cachedIn: 0.05, out: 3.00 },
  // 3.5 Flash: $1,50 in / $9,00 out / cache $0,15 (era 0,30/2,50 — subfaturado).
  'gemini-3.5-flash':       { in: 1.50, cachedIn: 0.15, out: 9.00 },
  // 3.7 Flash: preço INTRO $0,75 in / $3,75 out / cache ~$0,075 (10% off), válido
  // até fim/2026 (eval 18/08). Candidato a PRIMÁRIO de texto (melhor tool-calling
  // do teste). Ativado por env PRIMARY_TEXT_MODEL=gemini-3.7-flash (modo teste).
  'gemini-3.7-flash':       { in: 0.75, cachedIn: 0.075, out: 3.75 },
  // 3.1 Pro Preview (<=200k/req): $2,00 in / $12,00 out / cache $0,20.
  'gemini-3.1-pro-preview': { in: 2.00, cachedIn: 0.20, out: 12.0 },
  // IMAGEM (Nano Banana): texto in $0,30/M; saída $30/M, 1290 tok/img = $0,039/img (~39 créd).
  'gemini-2.5-flash-image': { in: 0.30, cachedIn: 0.075, out: 30.0 },
  // VOZ (TTS): texto in $0,30/M; áudio out ~$10/M (~25 tok/s → ~15 créd/min). Conferir na 1ª fatura.
  'gemini-2.5-flash-preview-tts': { in: 0.30, cachedIn: 0.075, out: 10.0 },
  // STT (transcrição de áudio) usa o próprio gemini-3.5-flash (áudio entra como input
  // multimodal, $1,50/M, ~32 tok/s → <1 créd/min). Sem linha própria: cai no Flash acima.
  // ── OpenAI (teste de alternativa, conferir preços ao vivo: developers.openai.com/api/docs/pricing) ──
  // GPT-5 mini (antigo): $0,25 in / $2,00 out / cache ~$0,025 (10% off).
  'gpt-5-mini':   { in: 0.25, cachedIn: 0.025, out: 2.00 },
  // GPT-5.4 mini (mais novo da família 5.4): $0,75 in / $4,50 out / cache ~$0,075 (10% off).
  // É o que o produto usa via id 'gpt5mini'. Mais caro que o 5-mini antigo, ganho = qualidade.
  'gpt-5.4-mini': { in: 0.75, cachedIn: 0.075, out: 4.50 },
  // GPT-4.1 mini: $0,40 in / $1,60 out / cache ~$0,10 (25% off).
  'gpt-4.1-mini': { in: 0.40, cachedIn: 0.10,  out: 1.60 },
  // GPT-4.1 nano: $0,10 in / $0,40 out / cache ~$0,025. O mais barato (tier do Lite).
  'gpt-4.1-nano': { in: 0.10, cachedIn: 0.025, out: 0.40 },
  // ── Together AI (teste de alternativa; GLM-5.2 muito mais rápido que na DeepInfra) ──
  // GLM-5.2 (zai-org/GLM-5.2) na Together: $1,40 in / $4,40 out / cache $0,26 (together.ai/pricing).
  'zai-org/GLM-5.2': { in: 1.40, cachedIn: 0.26, out: 4.40 },
  // ── DeepInfra (tier BARATO do produto) ──
  // GLM-4.7 (zai-org/GLM-4.7) no DeepInfra: $0,40 in / $1,75 out (deepinfra.com/pricing,
  // 24/07). É o tier barato: ~65% mais barato que o 5.2 e, com raciocínio off, ~1-2s.
  'zai-org/GLM-4.7': { in: 0.40, cachedIn: 0.10, out: 1.75 },
  // ── Kimi K3 (Moonshot) — modelo AVANÇADO opcional, atribuído manualmente por
  // agente (fora do roteamento). Roda sob demanda (serverless). Preço uniforme no
  // mercado: $3 in / $15 out / cache $0,30 (Together, Moonshot, Fireworks, etc.,
  // verificado 07/08/2026). A DeepInfra NÃO serve o K3 (só a linha K2.x), então o
  // provider do K3 é a Together. O id exato vem por env (KIMI_MODEL).
  'moonshotai/kimi-k3': { in: 3.00, cachedIn: 0.30, out: 15.0 },
  'moonshotai/Kimi-K3': { in: 3.00, cachedIn: 0.30, out: 15.0 },
  // ── DeepSeek V4 Pro — modelo legado/selecionável pelas rotas que ainda usam
  // DEEPSEEK_MODEL. Coding e planilhas usam V4.1 Flash em outra entrada acima.
  // ⚠️ O preço abaixo é do provider EM USO, não do modelo: o mesmo id é servido pela
  // Together (1,32/0,13/3,96) e pela DeepInfra (1,30/0,10/2,60), e quem manda é
  // DEEPSEEK_PROVIDER. Hoje = TOGETHER (30/08/2026), lido da API deles no mesmo dia
  // (GET /v1/models -> input 1.32 / cached_input 0.13 / output 3.96).
  // Voltou pra Together porque a DeepInfra tem cauda de latência que inviabiliza o
  // modelo no turno principal: no eval de grounding de 30/08 a MESMA pergunta levou
  // 121s numa rodada e 7s na seguinte, enquanto a Together ficou em 3,9-10,2s.
  // Sai ~52% mais caro no output; o ganho é resposta que não trava.
  // Se DEEPSEEK_PROVIDER voltar pra deepinfra, esta linha volta pra 1,30/0,10/2,60.
  // Isso mexe só no CUSTO gravado (relatório de margem); a COBRANÇA do usuário não
  // muda, o modelo está no tier 'normal' de BILL_TIER_BY_MODEL.
  // As duas variantes entram porque o id exato vem por env e o snapshot é o default.
  'deepseek-ai/DeepSeek-V4-Pro-0813': { in: 1.32, cachedIn: 0.13, out: 3.96 },
  'deepseek-ai/DeepSeek-V4-Pro':      { in: 1.74, cachedIn: 0.20, out: 3.48 },

  // ── DeepSeek V4 Flash (DeepInfra) — modelo do tier 'barato' (sub-agentes de
  // leitura: pesquisa/workspace/conectores) desde 29/08/2026, via CHEAP_MODEL no
  // .env (antes: GLM-4.7). $0,08 in / $0,18 out / cache $0,016
  // (deepinfra.com/pricing, cotado 28/08/2026).
  'deepseek-ai/DeepSeek-V4-Flash': { in: 0.08, cachedIn: 0.016, out: 0.18 },
  // ── Busca na web via Tavily (por chamada, não por token) ──
  // Tavily "basic" ~$0,008/busca. Modelamos como 1 "token de saída" a US$8/M pra o
  // costOf devolver ~$0,008 sem inventar campo novo (in=0 → só o out conta).
  'tavily-search':   { in: 0.0, cachedIn: 0.0, out: 8000.0 },
  // ── Busca de voos (Google Flights via SerpApi), também por chamada ──
  // Mesmo truque do Tavily: 1 "token de saída" = 1 busca. US$0,015/busca é o
  // preço do plano de 5.000 buscas/mês (US$75), o primeiro degrau pago que faz
  // sentido pra essa feature. Enquanto estivermos na franquia grátis do plano
  // atual, o server zera o custo (SEARCH_FREE_MONTHLY em server.mjs).
  'serpapi-flights': { in: 0.0, cachedIn: 0.0, out: 15000.0 },
  // Eventos de telemetria da busca, não chamadas de provider. Precisam estar
  // explícitos aqui: eles chegam a costOf com zero tokens e não podem parecer
  // um modelo novo sem preço no alerta operacional.
  'tavily-erro':  { in: 0.0, cachedIn: 0.0, out: 0.0 },
  'tavily-quota': { in: 0.0, cachedIn: 0.0, out: 0.0 },
  'websearch-bug': { in: 0.0, cachedIn: 0.0, out: 0.0 },
};

// Fallback conservador pra modelo desconhecido (usa o tier Flash).
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
  // Uma linha por id e por processo: chama atenção sem inundar o journal a
  // cada costOf/billCreditsOf da mesma chamada.
  console.warn(`[pricing] preço ausente para ${id}, usando fallback`);
}

// Telemetria somente leitura do processo atual. O dashboard atualiza a cada
// 15s; trocar um modelo por env sem cadastrar o preço fica visível no mesmo dia.
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

// Preços declarados na seção precos do modelos.yaml (quem instala informa os do
// seu provedor). Vencem a tabela acima pro mesmo id de modelo.
export function registerPrices(prices = {}) {
  for (const [model, p] of Object.entries(prices)) PRICES[model] = p;
}

export function priceFor(model) {
  if (Object.prototype.hasOwnProperty.call(PRICES, model)) return PRICES[model];
  observeMissingPrice(model);
  return DEFAULT_PRICE;
}

// Calcula o custo em US$ de uma chamada a partir do usage do provider.
// `u` = { model, in, cached, out, think, total }.
// - tokens de entrada cobrados cheios, menos os que vieram do cache (90% off);
// - think entra junto com out (saída) — o Gemini já soma think dentro de
//   candidatesTokenCount em alguns modelos, mas quando vem separado somamos.
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
