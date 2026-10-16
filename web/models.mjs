// ── Catalog of models the user can choose from ──
// The user never sees the model's technical name; they see a simple label (Econômico,
// Equilibrado, Avançado, Máximo) + a sense of how much credit each one consumes.
// `model` = technical name passed to the provider; `think` = "thinking" ceiling.
// DEFAULT = Gemini 3.5 Flash (Avançado); the user moves up to Pro 3.1 if they want
// more reasoning, or down to 3 Flash / Lite if they want to save credit.
import { priceFor } from './pricing.mjs';

export const MODELS = [
  { id: 'lite',  label: 'Econômico', model: 'gemini-3.1-flash-lite',
    desc: 'O mais rápido e barato. Ótimo pro dia a dia, perguntas diretas e tarefas simples.',
    think: 512 },
  { id: 'flash', label: 'Avançado', model: 'gemini-3.5-flash',
    desc: 'Mais qualidade nas respostas e em tarefas mais elaboradas. É o padrão.',
    think: 512, recommended: true },
  { id: 'pro',   label: 'Máximo', model: 'gemini-3.1-pro-preview',
    desc: 'Raciocínio mais forte para tarefas complexas (análise, código, estratégia). Consome bem mais crédito.',
    think: null },
  // ── TEST models (only admin sees them; web search via the buscar_web tool) ──
  { id: 'gpt5mini', label: 'OpenAI rápido (GPT-5.4 mini)', model: 'gpt-5.4-mini', provider: 'openai',
    desc: 'Modelo mais novo da OpenAI (família 5.4), mais barato que o 3.5 Flash. EM TESTE (com busca na web).',
    think: null },
  { id: 'glm52', label: 'GLM-5.2 (Together)', model: 'zai-org/GLM-5.2', provider: 'together',
    desc: 'Modelo da Zhipu rodando na Together AI (bem mais rápido que na DeepInfra). EM TESTE (com busca na web).',
    think: null },
];

export const DEFAULT_MODEL = 'flash';

export function isValidModel(id) {
  return MODELS.some((m) => m.id === id);
}

// "Automatic" router (opt-in per user): picks the CHEAPEST model that
// handles the question, to save credit without losing quality where it matters.
// Only moves between Lite/Flash (never Pro: moving up to Pro is the user's
// manual decision). Since ALL Gemini models have search, routing down doesn't remove
// grounding; what changes is only the "head" doing the reasoning. Conservative heuristic:
// when in doubt, go up. Decides at the start of the turn, with no extra classification call.
export function pickAutoModel({ text = '', hasImages = false } = {}) {
  const t = (text || '').toLowerCase().trim();
  const words = t ? t.split(/\s+/).filter(Boolean).length : 0;
  // Image → needs stronger vision.
  if (hasImages) return 'flash';
  // Signals of a factual/real-time question, research, code or analysis → top tier.
  const heavy = /(pre[çc]o|valor|quanto custa|or[çc]ament|hor[áa]rio|passage|v[oô]os?|hotel|hospeda|reserva|transfer|di[áa]ria|cupom|desconto|frete|hoje|amanh[ãa]|agora|quando|ontem|esta semana|not[íi]cia|c[óo]digo|programa|\bbug\b|\berro\b|stack|de[bp]ug|fun[çc]|function|\bapi\b|sql|analis|compar|estrat[ée]g|planej|roteiro|viagem|itiner|investig|pesquis|resum[ai]r?|relat[óo]rio)/;
  if (heavy.test(t)) return 'flash';
  // Rest (greeting, short question, middle ground) → economical.
  return 'lite';
}
// ── Tier router for the product's MAIN model (cheap vs. robust) ──
// The cheap tier = GLM-4.7 (DeepInfra, reasoning OFF): fast (~1-2s) and ~65% cheaper
// than GLM-5.2, with TIED quality in chat, direct questions and
// tool-calling (reads/actions/web) — see evals/eval-texto-glm47 and eval-modelos-kimi.
// The robust tier = GLM-5.2 (Together, reasoning on) only where real "thinking"
// pays off: code/dev, analysis, strategy, planning, long-form writing,
// a big document to digest. Conservative default: when in doubt, cheap (the 4.7 handles
// day-to-day); it only goes up when there's a clear signal of heavy reasoning.
// Decides at the start of the turn, with no extra classification call.
export function pickPrimaryTier({ text = '', permMode = 'padrao', hasProject = false } = {}) {
  // Dev/coding turn: non-default permission mode (aceitar_edicoes/plano)
  // or active project → the work is code, goes to robust.
  if (permMode && permMode !== 'padrao') return 'robusto';
  if (hasProject) return 'robusto';
  const t = (text || '').toLowerCase();
  // Pasted code block / program snippet → robust.
  if (/```|\bfunction\b|=>|\bdef \b|\bclass \b|\bimport \b|select .+ from |console\.log|\{[^}]*:[^}]*\}/.test(t)) return 'robusto';
  // Long message (document to analyze/summarize/review) → robust.
  const words = t.trim() ? t.trim().split(/\s+/).length : 0;
  if (words > 180) return 'robusto';
  // Real reasoning: code, analysis, strategy, planning, long-form writing.
  const heavy = /(c[óo]digo|codar|programa[rç]|\bbug\b|\berro\b|stack ?trace|de[bp]uga|refator|otimiz|algoritmo|arquitet|\bsql\b|\bquery\b|banco de dados|analis[ae]|compara[rç]|avalia[rç]|estrat[ée]g|planej|roteiro|investig|diagn[óo]s|relat[óo]rio|disserta|redi[jg]|ensaio|\bartigo\b|passo a passo)/;
  if (heavy.test(t)) return 'robusto';
  // BUILD of an app/site/page → robust. These turns write a WHOLE FILE
  // (app.js/index.html) in one tool-call: they need the bigger output ceiling (GLM-5.2
  // = 16384 vs 8192 for the cheap one) and better structuring, otherwise the file truncates
  // midway and the assistant loops (planner bug, 2026-08-15).
  const build = /\bapps?\b|aplicativo|\bsite\b|p[áa]gina|\bplanner\b|dashboard|formul[áa]rio|\blanding\b|\bhtml\b|\bcss\b|\btela\b|interface|sistema (pra|para|que|de )|\bcrud\b/;
  if (build.test(t)) return 'robusto';
  return 'barato';
}

export function modelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL);
}

// "Blended" cost of a model: input usually dominates in the tool-loop (the context
// gets resent on every step), so we weight input 0,8 and output 0,2. It's only for
// COMPARING models against each other, not for billing (real billing = pricing.costOf).
function blended(model) {
  const p = priceFor(model);
  return p.in * 0.8 + p.out * 0.2;
}

// TEST provider = anyone that isn't Gemini (OpenAI, DeepInfra...).
// These models only show up for the admin, and only when the provider's key is
// configured (enabled). Grounding comes from the buscar_web tool (they have no native search).
export function isTestProvider(p) {
  return !!p && p !== 'gemini';
}

// Public catalog: label, description and RELATIVE cost (× the cheapest model).
// `admin` (default false): includes the test models (OpenAI/DeepInfra).
// `enabled` = { openai: bool, deepinfra: bool }: only shows the test model if that
// provider's key is configured. The relative cost is always anchored
// to the cheapest Gemini (Lite), so the regular user's scale doesn't change.
export function modelCatalog({ admin = false, enabled = {} } = {}) {
  const gemini = MODELS.filter((m) => m.model && !isTestProvider(m.provider));
  const base = Math.min(...gemini.map((m) => blended(m.model)));
  return MODELS
    .filter((m) => {
      if (!isTestProvider(m.provider)) return true;
      return admin && !!enabled[m.provider];
    })
    .map((m) => ({
      id: m.id,
      label: m.label,
      desc: m.desc,
      recommended: !!m.recommended,
      provider: m.provider || 'gemini',
      // rounds to 0,5 to stay friendly (1×, 6×, 8×…)
      costRel: m.model ? Math.round((blended(m.model) / base) * 2) / 2 : null,
    }));
}
