// ── Video generation prompt moderation ──
// Guardrail for the people video generation feature. Runs BEFORE generating:
// classifies the request text (prompt + audio transcript, if any) against the
// FORBIDDEN categories. If any fires, the video is NOT generated.
//
// Forbidden categories (05/08): sexual content, violence, verbal violence,
// children, blood, nudity.
//
// Model: the cheapest that copes (Gemini Flash Lite), thinkingBudget 0.
//
// FAIL-CLOSED: if moderation can't run or the response is unreadable, the
// answer is BLOCK. A guardrail that fails open is no guardrail.

import { makeGemini } from '../core-proto/providers/gemini.mjs';
import { modeloPara } from '../core-proto/modelos.mjs';

const MODEL = 'gemini-3.1-flash-lite';

// Categorias canônicas (chave interna → rótulo pt-BR pro usuário).
export const BANNED_CATEGORIES = {
  sexual: 'conteúdo sexual',
  violencia: 'violência',
  violencia_verbal: 'violência verbal',
  criancas: 'crianças',
  sangue: 'sangue',
  nudez: 'nudez',
};

const SYSTEM = [
  'Você é um moderador de conteúdo para uma ferramenta que gera vídeos curtos da própria pessoa.',
  'Sua tarefa: decidir se um pedido de vídeo (texto do prompt, e talvez a transcrição de um áudio) contém ou pede QUALQUER uma das categorias PROIBIDAS abaixo.',
  'Categorias proibidas:',
  '- sexual: conteúdo sexual, ato sexual, insinuação sexual explícita.',
  '- violencia: violência física, agressão, armas usadas para ferir, tortura, morte.',
  '- violencia_verbal: xingamento, ameaça, assédio, discurso de ódio, humilhação.',
  '- criancas: qualquer envolvimento de menores de 18 anos (a ferramenta é só 18+).',
  '- sangue: sangue, ferimentos sangrentos, mutilação, gore.',
  '- nudez: nudez total ou parcial, pouca roupa de teor sexual.',
  'Seja rigoroso mas não paranoico: pedidos comuns e inofensivos (dançar, falar, andar, cenário, roupa normal) são PERMITIDOS.',
  'Responda SÓ com um JSON, sem markdown, no formato exato:',
  '{"allowed": true|false, "categories": ["chave", ...], "reason": "curto, em pt-BR"}',
  'categories: lista das chaves proibidas que dispararam (vazia se allowed=true). reason: uma frase curta.',
].join('\n');

function parseJson(t) {
  if (!t) return null;
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}

// Modera o pedido. Retorna { allowed, categories:[chaves], labels:[rótulos],
// reason, usage, model, failClosed }. NUNCA lança: em erro, bloqueia.
export async function moderateVideoPrompt({ prompt = '', audioText = '' } = {}) {
  const text = [String(prompt || '').trim(), String(audioText || '').trim()].filter(Boolean).join('\n\n');
  if (!text) {
    return { allowed: false, categories: [], labels: [], reason: 'Pedido vazio.', usage: null, model: MODEL, failClosed: true };
  }
  let r;
  try {
    r = await (modeloPara('classificacao', { maxTokens: 512 }) || makeGemini({ model: MODEL, thinkingBudget: 0, maxOutputTokens: 512 }))
      .complete({ system: SYSTEM, messages: [{ role: 'user', content: text.slice(0, 8000) }], tools: [] });
  } catch (e) {
    return { allowed: false, categories: [], labels: [], reason: 'Moderação indisponível no momento. Tente de novo.', usage: null, model: MODEL, failClosed: true, error: String(e?.message ?? e) };
  }
  const parsed = parseJson(r?.text);
  if (!parsed || typeof parsed.allowed !== 'boolean') {
    return { allowed: false, categories: [], labels: [], reason: 'Não consegui avaliar o pedido com segurança.', usage: r?.usage || null, model: MODEL, failClosed: true };
  }
  const cats = Array.isArray(parsed.categories)
    ? parsed.categories.map((c) => String(c || '').trim()).filter((c) => BANNED_CATEGORIES[c])
    : [];
  // Consistência: se marcou categorias, não pode estar allowed.
  const allowed = parsed.allowed === true && cats.length === 0;
  return {
    allowed,
    categories: cats,
    labels: cats.map((c) => BANNED_CATEGORIES[c]),
    reason: String(parsed.reason || (allowed ? 'ok' : 'conteúdo não permitido')).slice(0, 300),
    usage: r?.usage || null,
    model: MODEL,
    failClosed: false,
  };
}
