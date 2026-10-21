// Reads a reply to a confirmation card with a model when the fixed rules in
// confirmation-flow.mjs did not take it as a decision. Replaying those rules on
// 164 real replies sent while a card was open (2026-10-21), they missed 23 of 50
// approvals ("👍", "Put it on my calendar", "Only the first one, please") and
// never read a change request, so the old card stayed open next to the new one.
//
// The model only interprets. The platform checks that every card it names was
// one of the candidates, a fixed lock can still refuse an approval, and any
// failure (no model, timeout, bad JSON) keeps what the rules decided. A yes to an
// action that can't be undone gets a second reading first (secondReading).
import { makeTogether, togetherEnabled, togetherFlashModel, FLASH_REASONING_ROOM } from '../core-proto/providers/together.mjs';
import { makeGemini } from '../core-proto/providers/gemini.mjs';
import { modelFor } from '../core-proto/models.mjs';
import { isReactionConfirmable } from './confirm.mjs';

const DECISIONS = new Set(['approve', 'refuse', 'change', 'other', 'unsure']);
const TIMEOUT_MS = 10_000;
// The answer is a few tokens; the room is for the reasoning a Flash route counts in the ceiling.
const MAX_TOKENS = 256 + FLASH_REASONING_ROOM;

export const consentReaderEnabled = (value = process.env.BRAMBIT_CONSENT_READER) => String(value || '').trim().toLowerCase() !== 'off';

function readerModel() {
  return modelFor('classification', { maxTokens: MAX_TOKENS })
    || (togetherEnabled() ? makeTogether({ model: togetherFlashModel(), maxTokens: MAX_TOKENS, temperature: 0, reasoningEffort: 'low' }) : null)
    || (process.env.GEMINI_API_KEY ? makeGemini({ model: 'gemini-3.5-flash', thinkingBudget: 0, maxOutputTokens: 256 }) : null);
}

const SYSTEM = `A person was asked to confirm one or more actions. Each action is shown as a numbered card and only runs after the person approves it. Read the person's reply and say what they decided about the cards. The recent conversation is there to understand the reply; decide only about the reply.

Decisions:
- approve: they clearly want the action done now, as the card shows it. Extra words don't matter ("👍", "yes, thanks", "put it on my calendar", "go ahead and send it", "only the first one").
- refuse: they don't want the action ("no need", "cancel all of them", "forget it").
- change: they want the action the card describes (the same event, message, routine, file or item) with different details (another time, text, recipient).
- other: anything else: another subject, a new separate request, a question, a comment, or a "yes" that answers a different question.
- unsure: you can't tell.

Rules:
- A question, a condition ("if...", "unless..."), hesitation ("wait", "not yet") or a request to change the action is never approve.
- If the reply approves and also changes the action, it is change.
- If the person asked earlier in the conversation for details the card doesn't show (another time, recipient or text) and the reply doesn't make clear they now accept the card as it is, it is change, not approve.
- A pasted or forwarded text (someone else's message, a list, a booking confirmation) is other, unless the person also says what to do with the card.
- If the assistant's last message asked something else and the reply only answers that, it is other.
- "cards" lists the numbers of the cards the decision is about, only from the cards given. Leave it empty when the reply doesn't say which and more than one card is given.

Answer with JSON only: {"decision":"approve|refuse|change|other|unsure","cards":[]}`;

const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const clipEnd = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; };

// The last messages before the reply, oldest first; the assistant's last one
// usually shows the cards. Without them, "Option 2" right after "make it 11:00
// to 11:30" read as approving a card that still said 11:00 to 12:00 (eval, 2026-10-21).
export function readerPrompt({ cards, said, assistantText = '', recent = [] }) {
  const asked = [...new Set(cards.map(r => String(r.source?.ownerText || '').trim()).filter(Boolean))];
  const turns = recent.length ? recent : assistantText ? [{ role: 'assistant', content: assistantText }] : [];
  const line = (m, i) => m.role === 'user' ? `Person: ${clip(m.content, 400)}`
    : `Assistant: ${clipEnd(m.content, i === turns.length - 1 ? 1500 : 500)}`;
  return [
    `Cards waiting for a decision:\n${cards.map(r => `#${r.number}: ${clip(r.confirmationText || r.label, 700)}`).join('\n\n')}`,
    asked.length ? `What the person had asked before the cards:\n${asked.map(a => clip(a, 500)).join('\n')}` : '',
    turns.length ? `Recent conversation, oldest first:\n${turns.map(line).join('\n\n')}` : '',
    `The person's reply:\n${clip(said, 1500)}`,
  ].filter(Boolean).join('\n\n');
}

export function parseReading(text, numbers) {
  const found = String(text || '').match(/\{[^{}]*\}/g);
  if (!found) return null;
  let json;
  try { json = JSON.parse(found.at(-1)); } catch { return null; }
  if (!DECISIONS.has(json?.decision)) return null;
  const cards = Array.isArray(json.cards) ? [...new Set(json.cards.map(Number))] : [];
  if (cards.some(n => !numbers.includes(n))) return { decision: 'unsure', cards: [] };
  return { decision: json.decision, cards };
}

// The model's text, or null on no model, error or timeout.
async function ask(model, system, content, timeoutMs) {
  if (!model) return null;
  let timer;
  const call = model.complete({ system, messages: [{ role: 'user', content }], tools: [] });
  call.catch(() => {});
  try {
    const r = await Promise.race([call, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, null); })]);
    return r ? String(r.text || '') : null;
  } catch {
    return null;
  } finally { clearTimeout(timer); }
}

export async function readConsent({ cards, said, assistantText = '', recent = [], model = readerModel(), timeoutMs = TIMEOUT_MS }) {
  const text = await ask(model, SYSTEM, readerPrompt({ cards, said, assistantText, recent }), timeoutMs);
  return text === null ? null : parseReading(text, cards.map(c => c.number));
}

const CHECK_SYSTEM = `An action that can't be undone (deleting for good, sending something to other people) is shown to a person as a numbered card and only runs after a clear yes. Read the person's reply with the conversation and say whether it is a clear yes to doing exactly what the card(s) being checked show, now.

Decisions:
- approve: a clear yes to the checked card(s) as they are shown. Extra words don't matter.
- change: they want something different from what the card shows, including details they asked for earlier in the conversation that the card doesn't show (another time, recipient, guests, text), or a yes with a change or a condition.
- refuse: they don't want it.
- other: a question, hesitation, a new separate request, a pasted text, an answer to a different question, or a yes to a different card.

Answer with JSON only: {"decision":"approve|refuse|change|other"}`;

// Second reading of a yes to an action that can't be undone: one decision about
// the checked cards, with the same view of the conversation the reader gets.
export async function checkConsent({ cards, checked, said, assistantText = '', recent = [], model = readerModel(), timeoutMs = TIMEOUT_MS }) {
  const content = `${readerPrompt({ cards, said, assistantText, recent })}\n\nCard(s) being checked: ${checked.map(r => `#${r.number}`).join(', ')}`;
  const text = await ask(model, CHECK_SYSTEM, content, timeoutMs);
  const found = String(text || '').match(/\{[^{}]*\}/g);
  try {
    const decision = found && JSON.parse(found.at(-1)).decision;
    return ['approve', 'refuse', 'change', 'other'].includes(decision) ? decision : null;
  } catch { return null; }
}

const folded = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’‘`]/g, "'").trim();
// Fixed lock on an approval the model read. A question, a negation or a
// condition anywhere keeps the card waiting. Portuguese "no" (em + o) is not a
// negation, so the bare word only counts at the start.
export function approvalVeto(said) {
  const t = folded(said);
  if (!t || t.endsWith('?')) return true;
  if (/\bnao\b|^(?:no|nope|nah)\b|\b(?:not|don't|dont|do not|never|nunca|jamais|wait|hold on|espera|espere|calma|pera|todavia no|aun no)\b|\bno (?:lo|la|los|las|me|hagas|haga|envies|mandes|quiero|gracias)\b/.test(t)) return true;
  return /\b(?:se|if|caso|unless|menos|exceto|except|talvez|maybe|perhaps|tal vez|quizas|quiza)\b/.test(t);
}

const face = r => `${r.name}\n${folded(r.confirmationText || r.label)}`;
const decided = (kind, rows) => ({ kind, row: rows[0], ...(rows.length > 1 ? { rows } : {}), reader: true });

// What the reader changes in the rules' choice. Only "continue" and "ambiguous"
// are reconsidered: every other kind is already a decision, a replay or an error
// the rules own.
export async function reconsider(selected, { rows = [], said = '', target, viaReaction = false, shownIds = [],
  assistantText = '', recent = [], read = readConsent, env = process.env } = {}) {
  if (viaReaction || !consentReaderEnabled(env.BRAMBIT_CONSENT_READER) || !['continue', 'ambiguous'].includes(selected?.kind)) return selected;
  // A quote of a message that isn't a card answers that message.
  if (selected.kind === 'continue' && target !== undefined) return selected;
  const open = r => r?.state === 'pending' && r.presented;
  const candidates = (selected.kind === 'ambiguous' ? selected.rows || [] : shownIds.map(id => rows.find(r => r.id === id))).filter(open);
  if (!candidates.length || !String(said).trim()) return selected;
  const reading = await read({ cards: candidates, said, assistantText, recent });
  if (!reading) return selected;
  const chosen = reading.cards.length ? candidates.filter(r => reading.cards.includes(r.number)) : candidates.length === 1 ? candidates : [];
  if (reading.decision === 'approve') {
    if (!chosen.length || approvalVeto(said)) return selected;
    // Cards that look the same to the person: a "yes" can't pick one of them.
    if (chosen.some(r => candidates.some(o => !chosen.includes(o) && face(o) === face(r)))) return selected;
    if (chosen.length > 1 && !chosen.every(r => shownIds.includes(r.id))) return selected;
    return decided('confirm', chosen);
  }
  if (reading.decision === 'refuse') return chosen.length ? decided('cancel', chosen) : selected;
  if (reading.decision === 'change') return chosen.length === 1 ? decided('edit', chosen) : selected;
  if (reading.decision === 'other' && selected.kind === 'ambiguous') return { kind: 'continue', reader: true };
  return selected;
}

// Cards already asked about once. In memory on purpose: after a restart the
// worst case is one more question, never an action run without a yes.
const askedOnce = new Set();
const ASKED_MAX = 5000;
function rememberAsked(ids) {
  for (const id of ids) { askedOnce.delete(id); askedOnce.add(id); }
  while (askedOnce.size > ASKED_MAX) askedOnce.delete(askedOnce.values().next().value);
}

// A "yes" to an action that can't be undone (deleting for good, sending to a
// third party) gets a second reading before it runs (checkConsent). The second
// reading never authorizes on its own:
// - the rules said yes: it runs unless the second reading finds something else;
//   with no model answer the rules decide, as before;
// - the consent reader said yes: it runs only if the second reading also finds
//   a yes.
// Otherwise the platform asks once more ('doubleCheck'). The next "yes" the rules
// take is not read again, so the question never loops; a reader yes that is
// still in doubt goes back to the conversation. Jev was measured for this and
// missed the reader's mistake the model caught ("Option 2" after asking for
// another time).
export async function secondReading(selected, { rows = [], said = '', viaReaction = false, shownIds = [], assistantText = '',
  recent = [], consent = checkConsent, undoable = isReactionConfirmable, env = process.env } = {}) {
  if (selected?.kind !== 'confirm' || viaReaction || !consentReaderEnabled(env.BRAMBIT_CONSENT_READER)) return selected;
  const chosen = selected.rows || [selected.row];
  const final = chosen.filter(r => !undoable(r.name));
  if (!final.length) return selected;
  const asked = final.every(r => askedOnce.has(r.id));
  if (asked && !selected.reader) return selected;
  const onScreen = [...new Map([...shownIds.map(id => rows.find(r => r.id === id)), ...chosen]
    .filter(r => r?.state === 'pending').map(r => [r.id, r])).values()];
  const verdict = await consent({ cards: onScreen, checked: chosen, said, assistantText, recent });
  if (verdict === 'approve' || (verdict === null && !selected.reader)) return selected;
  if (asked) return { kind: 'continue', reader: true };
  rememberAsked(final.map(r => r.id));
  return { kind: 'doubleCheck', row: chosen[0], rows: chosen };
}
