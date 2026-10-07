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
  'You are a content moderator for a tool that generates short videos of the person themselves.',
  'Your task: decide whether a video request (prompt text, and possibly an audio transcript) contains or asks for ANY of the FORBIDDEN categories below.',
  'Forbidden categories:',
  '- sexual: sexual content, sexual acts, explicit sexual innuendo.',
  '- violencia: physical violence, aggression, weapons used to harm, torture, death.',
  '- violencia_verbal: insults, threats, harassment, hate speech, humiliation.',
  '- criancas: any involvement of minors under 18 (the tool is 18+ only).',
  '- sangue: blood, bloody wounds, mutilation, gore.',
  '- nudez: full or partial nudity, scant clothing with sexual intent.',
  'Be strict but not paranoid: common, harmless requests (dancing, talking, walking, scenery, normal clothing) are ALLOWED.',
  'Reply ONLY with a JSON, no markdown, in the exact format:',
  '{"allowed": true|false, "categories": ["key", ...], "reason": "short, in Brazilian Portuguese (pt-BR)"}',
  'categories: list of the forbidden keys that fired (empty if allowed=true). reason: one short sentence.',
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
