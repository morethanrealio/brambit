// ── Catálogo de modelos que o usuário pode escolher ──
// O usuário nunca vê o nome técnico do modelo; vê um rótulo simples (Econômico,
// Equilibrado, Avançado, Máximo) + uma noção de quanto cada um consome de crédito.
// `model` = nome técnico passado pro provider; `think` = teto de "pensamento".
// PADRÃO = Gemini 3.5 Flash (Avançado); o usuário sobe pro Pro 3.1 se quiser
// mais cabeça, ou desce pro 3 Flash / Lite se quiser economizar crédito.
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
  // ── Modelos de TESTE (só admin enxerga; busca na web via tool buscar_web) ──
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

// Roteador "Automático" (opt-in por usuário): escolhe o modelo MAIS BARATO que
// dá conta da pergunta, pra economizar crédito sem perder qualidade onde importa.
// Só circula entre Lite/Flash (nunca Pro: subir pro Pro é decisão manual do
// usuário). Como TODOS os modelos Gemini têm busca, rotear pra baixo não tira o
// grounding; o que muda é só a "cabeça" do raciocínio. Heurística conservadora:
// na dúvida sobe. Decide no início do turno, sem chamada extra de classificação.
export function pickAutoModel({ text = '', hasImages = false } = {}) {
  const t = (text || '').toLowerCase().trim();
  const words = t ? t.split(/\s+/).filter(Boolean).length : 0;
  // Imagem → precisa de visão mais forte.
  if (hasImages) return 'flash';
  // Sinais de pergunta factual/tempo-real, pesquisa, código ou análise → topo.
  const heavy = /(pre[çc]o|valor|quanto custa|or[çc]ament|hor[áa]rio|passage|v[oô]os?|hotel|hospeda|reserva|transfer|di[áa]ria|cupom|desconto|frete|hoje|amanh[ãa]|agora|quando|ontem|esta semana|not[íi]cia|c[óo]digo|programa|\bbug\b|\berro\b|stack|de[bp]ug|fun[çc]|function|\bapi\b|sql|analis|compar|estrat[ée]g|planej|roteiro|viagem|itiner|investig|pesquis|resum[ai]r?|relat[óo]rio)/;
  if (heavy.test(t)) return 'flash';
  // Resto (saudação, pergunta curta, meio-termo) → econômico.
  return 'lite';
}
// ── Roteador de TIER do modelo PRINCIPAL do produto (barato x robusto) ──
// O tier barato = GLM-4.7 (DeepInfra, raciocínio OFF): rápido (~1-2s) e ~65% mais
// barato que o GLM-5.2, com qualidade EMPATADA em chat, perguntas diretas e
// tool-calling (reads/ações/web) — ver evals/eval-texto-glm47 e eval-modelos-kimi.
// O tier robusto = GLM-5.2 (Together, raciocínio ligado) só onde o "pensar" de
// verdade paga: código/dev, análise, estratégia, planejamento, redação longa,
// documento grande pra digerir. Default conservador: na dúvida, barato (o 4.7 dá
// conta do dia a dia); só sobe quando há sinal claro de raciocínio pesado.
// Decide no início do turno, sem chamada extra de classificação.
export function pickPrimaryTier({ text = '', permMode = 'padrao', hasProject = false } = {}) {
  // Turno de dev/coding: modo de permissão fora do padrão (aceitar_edicoes/plano)
  // ou projeto ativo → o trabalho é código, vai pro robusto.
  if (permMode && permMode !== 'padrao') return 'robusto';
  if (hasProject) return 'robusto';
  const t = (text || '').toLowerCase();
  // Bloco de código colado / trecho de programa → robusto.
  if (/```|\bfunction\b|=>|\bdef \b|\bclass \b|\bimport \b|select .+ from |console\.log|\{[^}]*:[^}]*\}/.test(t)) return 'robusto';
  // Mensagem longa (documento pra analisar/resumir/revisar) → robusto.
  const words = t.trim() ? t.trim().split(/\s+/).length : 0;
  if (words > 180) return 'robusto';
  // Raciocínio de verdade: código, análise, estratégia, planejamento, redação longa.
  const heavy = /(c[óo]digo|codar|programa[rç]|\bbug\b|\berro\b|stack ?trace|de[bp]uga|refator|otimiz|algoritmo|arquitet|\bsql\b|\bquery\b|banco de dados|analis[ae]|compara[rç]|avalia[rç]|estrat[ée]g|planej|roteiro|investig|diagn[óo]s|relat[óo]rio|disserta|redi[jg]|ensaio|\bartigo\b|passo a passo)/;
  if (heavy.test(t)) return 'robusto';
  // BUILD de app/site/página → robusto. Esses turnos escrevem ARQUIVO INTEIRO
  // (app.js/index.html) num tool-call: precisam do teto de saída maior (GLM-5.2
  // = 16384 vs 8192 do barato) e da estruturação melhor, senão o arquivo trunca
  // no meio e o assistente entra em loop (bug do planner, 15/08).
  const build = /\bapps?\b|aplicativo|\bsite\b|p[áa]gina|\bplanner\b|dashboard|formul[áa]rio|\blanding\b|\bhtml\b|\bcss\b|\btela\b|interface|sistema (pra|para|que|de )|\bcrud\b/;
  if (build.test(t)) return 'robusto';
  return 'barato';
}

export function modelById(id) {
  return MODELS.find((m) => m.id === id) || MODELS.find((m) => m.id === DEFAULT_MODEL);
}

// Custo "blended" de um modelo: o input costuma dominar no tool-loop (o contexto
// é reenviado a cada passo), então peso entrada 0,8 e saída 0,2. Serve só pra
// COMPARAR modelos entre si, não pra cobrar (cobrança real = pricing.costOf).
function blended(model) {
  const p = priceFor(model);
  return p.in * 0.8 + p.out * 0.2;
}

// Provider de TESTE = qualquer um que não seja o Gemini (OpenAI, DeepInfra...).
// Esses modelos só aparecem pro admin, e só quando a chave do provider está
// configurada (enabled). Grounding vem da tool buscar_web (não têm busca nativa).
export function isTestProvider(p) {
  return !!p && p !== 'gemini';
}

// Catálogo público: rótulo, descrição e custo RELATIVO (× o modelo mais barato).
// `admin` (default false): inclui os modelos de teste (OpenAI/DeepInfra).
// `enabled` = { openai: bool, deepinfra: bool }: só mostra o modelo de teste se a
// chave daquele provider estiver configurada. O custo relativo é sempre ancorado
// no Gemini mais barato (Lite), então a escala do usuário comum não muda.
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
      // arredonda em 0,5 pra ficar amigável (1×, 6×, 8×…)
      costRel: m.model ? Math.round((blended(m.model) / base) * 2) / 2 : null,
    }));
}
