import {selectedDeepSeek} from '../core-proto/deepseek/scope.mjs';
// ── History compaction (rolling token-based summary) ──
// When the conversation grows, we fold the old turns into a "rolling summary" and
// keep only the recent turns verbatim. The summary goes into the system prompt.
// Metric = estimated token count (chars/4). Hysteresis: triggers at HIGH, trims down to LOW.
// Everything tunable via env. See projetos/arquitetura-memoria.md (section 6).

import { makeMemoriaModel } from './memoria-modelo.mjs';

export const COMPACT_HIGH = Number(process.env.COMPACT_HIGH || 24000); // gatilho
export const COMPACT_LOW = Number(process.env.COMPACT_LOW || 12000);   // post-trim target
export const SUMMARY_CAP = Number(process.env.SUMMARY_CAP || 3000);    // teto da prosa do resumo
export const LEDGER_CAP = Number(process.env.LEDGER_CAP || 6000);      // teto do ledger de dados concretos (chars)

// ── Concrete-data ledger (verbatim, compression-proof) ──
// The summary's prose (via Flash) tends to swallow hard data the user PASTES
// (dates, times, addresses, prices, links, choices). The ledger keeps these
// lines VERBATIM outside the model's compression and accumulates across compactions.
const LEDGER_MARK = '━━ DADOS DO USUÁRIO (verbatim, não alterar) ━━';

// Signals of "concrete data" in a line pasted by the user.
const FACT_PATTERNS = [
  /\b\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?\b/,                         // datas 22/07, 22-07-2026
  /\b\d{1,2}\s?[:hH]\s?\d{2}\b/,                                          // times 21:26, 9h30
  /R\$\s?\d/,                                                             // prices R$ 180
  /\bhttps?:\/\/\S+/i,                                                    // links
  /\b(rua|av\.?|avenida|alameda|travessa|estrada|rodovia|pça|praça)\b/i,  // address
  /\b\d{5}-?\d{3}\b/,                                                     // CEP
  /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)\b/i,        // dias da semana
  /\b\d{1,3}\s?(reais|real|brl|usd|d[óo]lares?)\b/i,                      // valores por extenso
  /\b(voo|check[- ]?in|check[- ]?out|reserva|localizador|confirma[çc][ãa]o|cpf|cnpj|oab)\b/i,
];

const normFact = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Extracts the concrete-data lines from the USER's messages (what they "paste").
function extractFacts(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role !== 'user' || !m.content) continue;
    for (let line of String(m.content).split('\n')) {
      line = line.trim();
      if (line.length < 4 || line.length > 300) continue;
      if (FACT_PATTERNS.some((re) => re.test(line))) out.push(line);
    }
  }
  return out;
}

// Separa uma string de resumo em { prose, ledger:[linhas] }.
function splitSummary(s) {
  const text = s || '';
  const i = text.indexOf(LEDGER_MARK);
  if (i < 0) return { prose: text.trim(), ledger: [] };
  const prose = text.slice(0, i).trim();
  const ledger = text
    .slice(i + LEDGER_MARK.length)
    .split('\n')
    .map((l) => l.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean);
  return { prose, ledger };
}

// Joins old ledger + new facts, dedupes (keeps 1st occurrence), caps by chars
// preserving the MOST RECENT ones (drops the oldest if it overflows).
function mergeLedger(oldLedger, newFacts) {
  const seen = new Set();
  const merged = [];
  for (const f of [...(oldLedger || []), ...(newFacts || [])]) {
    const k = normFact(f);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    merged.push(f.trim());
  }
  let acc = 0;
  const kept = [];
  for (let i = merged.length - 1; i >= 0; i--) {
    acc += merged[i].length + 3; // "- " + \n
    if (acc > LEDGER_CAP && kept.length) break;
    kept.unshift(merged[i]);
  }
  return kept;
}

// Composes prose + ledger into a single summary string.
function composeSummary(prose, ledger) {
  let p = (prose || '').trim();
  if (estTokens(p) > SUMMARY_CAP) p = p.slice(0, SUMMARY_CAP * 4);
  if (!ledger?.length) return p;
  return `${p}\n\n${LEDGER_MARK}\n${ledger.map((l) => `- ${l}`).join('\n')}`.trim();
}

// Estimates tokens for a text (cheap heuristic, no tokenizer).
export const estTokens = (s) => Math.ceil((s || '').length / 4);

// Serializes a core message to text (for estimating and for summarizing).
function renderMsg(m) {
  if (m.role === 'tool') return `[tool:${m.name}] ${m.content || ''}`;
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const calls = m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.args || {})})`).join(', ');
    return `Assistant (called tools): ${calls}${m.content ? `\n${m.content}` : ''}`;
  }
  const who = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : m.role;
  return `${who}: ${m.content || ''}`;
}

export const msgTokens = (m) => estTokens(renderMsg(m));
export const historyTokens = (messages) => (messages || []).reduce((n, m) => n + msgTokens(m), 0);

// ── Trimming RAW results of READ tools (inside compaction) ──
// READ tool = the result is CONSUMED within the turn and is not state: the assistant's
// reply already carries what mattered from it. Keeping the raw JSON/HTML in the
// history just pays the input token again on every following turn. Measured via
// offline replay over 20 real threads (2026-09-01): -30% history with no detectable
// loss of quality (the CONTROL arm, with identical input, flagged "lost
// info" in the same 4 cases — that's generation noise, not the trim's).
//
// DELIBERATELY LEFT OUT:
// • sandbox_*/escrever_*/planilha/app files → this is working STATE, not consumption;
// • listar_lembretes, calendar_list, gmail_* → the agenda and inbox the person is
//   handling RIGHT NOW; the result is usually the subject of the next turn.
export const READ_TOOLS_CUT = new Set([
  'buscar_web', 'pesquisar', 'google', 'abrir_link', 'memoria_ler', 'ver_midia',
  'listar_midia', 'ler_arquivo_do_app', 'ler_conversa', 'reler_esta_conversa',
  'rodar_leitura', 'ler_arquivo', 'buscar_no_codigo', 'listar_arquivos',
  'ver_diff', 'ver_historico', 'ler_espaco', 'ler_skill', 'listar_rotinas',
  'status_conta', 'buscar_produtos', 'analisar_produto', 'nuvemshop_pedidos',
  'splitwise_groups', 'infinity_itens', 'infinity_item', 'infinity_board_estrutura', 'github', 'microsoft', 'checar_monitor', 'listar_sistemas',
  'abrir_ferramentas', 'buscar_conversas', 'listar_arquivos_do_app',
]);

// Below this, the stub comes out equal to or bigger than the content: not worth swapping.
const CUT_MIN_TOKENS = 60;
const stubFor = (name) => `[resultado de ${name} não guardado no histórico; refaça a chamada se precisar de novo]`;

// Replaces raw read results with a stub at indices < `upto`.
// Preserves role/name/tool_call_id and the array's SIZE (the
// toolCall↔result pairing the provider requires still holds).
export function stubRawReads(messages, upto) {
  let cutTok = 0;
  const out = (messages || []).map((m, i) => {
    if (i >= upto || m.role !== 'tool' || !READ_TOOLS_CUT.has(m.name)) return m;
    if (msgTokens(m) < CUT_MIN_TOKENS) return m;
    const lean = { ...m, content: stubFor(m.name) };
    cutTok += msgTokens(m) - msgTokens(lean);
    return lean;
  });
  return { messages: out, cutTok };
}

// Index where the LAST turn begins ('user' boundary). The most recent turn
// is never trimmed: it's the "and the second one?" right after a search.
function lastTurnStart(messages) {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
  return messages?.length || 0;
}

// Finds the cut index: keeps the LARGEST suffix of turns (starting at a 'user')
// whose total tokens <= LOW. Returns the index where the "recent" part begins.
function splitIndex(messages, lowTokens) {
  // turn-boundary indices = where role === 'user'
  const bounds = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') bounds.push(i);
  if (bounds.length <= 1) return 0; // 0 or 1 turn: can't safely compact

  // from the last turn to the oldest, accumulates until it overflows LOW
  let acc = 0;
  let chosen = bounds[bounds.length - 1]; // at least the last turn stays
  for (let b = bounds.length - 1; b >= 0; b--) {
    const start = bounds[b];
    const end = b + 1 < bounds.length ? bounds[b + 1] : messages.length;
    let turnTok = 0;
    for (let i = start; i < end; i++) turnTok += msgTokens(messages[i]);
    if (acc + turnTok > lowTokens && acc > 0) break; // we already have something and it would overflow
    acc += turnTok;
    chosen = start;
  }
  return chosen;
}

// Summarizes the old turns, incorporating the previous summary.
// The prose is compressed by Flash (cap SUMMARY_CAP); the concrete-data ledger
// is preserved VERBATIM outside the compression and accumulated across compactions.
async function summarize(prevSummary, oldMessages, onUsage) {
  const { prose: prevProse, ledger: prevLedger } = splitSummary(prevSummary);
  const sys = [
    'You maintain the ROLLING SUMMARY of a conversation between a user and their personal assistant.',
    'Goal: preserve continuity so the conversation can go on without the raw turns.',
    'Keep: decisions made, open tasks/threads, what was being done, pending requests and mentioned facts that still matter.',
    'CRITICAL: preserve VERBATIM every concrete piece of data the user provided — dates, times, addresses, prices, proper names (places/people/products), links and CHOICES/selections they made (e.g. "quero o restaurante X na quarta"). NEVER generalize this data into vague sentences or drop it. If they built a schedule/itinerary/list, keep each item with its day/time.',
    'Do NOT repeat what is already in the long-term profile; focus on the "glue" of the conversation.',
    `Be concise, in the language the conversation is written in, at most ~${SUMMARY_CAP / 4 | 0} words. Return only the updated summary.`,
  ].join('\n');
  const body = oldMessages.map(renderMsg).join('\n');
  const prompt = `Previous summary:\n${prevProse || '(empty)'}\n\nNew turns to incorporate:\n${body}`;
  const selected=selectedDeepSeek();
  const summarizer=selected?.forBillingPhase?.({kind:'compact',noBill:true}) || selected || makeMemoriaModel();
  const r = await (summarizer.forBillingPhase?.({kind:'compact',noBill:true})||summarizer).complete({
    system: sys, messages: [{ role: 'user', content: prompt }], tools: [],
  });
  // This call is paid and was invisible: the usage came back from the provider and was
  // discarded here, so no usage_events line represented the
  // compaction. Every per-thread cost analysis came out underestimated, and without a number
  // there's no way to decide if the summary pays for itself (it trades raw turns resent at
  // every step for a single call, but that's a hypothesis until it's measured).
  if (r?.usage && onUsage) { try { onUsage(r.usage); } catch {} }
  const prose = (r.text || '').trim() || prevProse || '';
  const ledger = mergeLedger(prevLedger, extractFacts(oldMessages));
  return composeSummary(prose, ledger) || prevSummary || '';
}

// Compacts if it passes HIGH. Returns { history, summary, compacted }.
// `messages` = full history already with the new turn; `prevSummary` = the agent's current summary.
//
// The trimming of raw read results happens ONLY HERE, in the same compaction
// event, on purpose: it's the only moment the prompt prefix is
// already going to be rewritten anyway, so the cache doesn't pay any extra cost. Doing
// this every turn would drop the cache every time (compaction frequency and
// cache tuning remain untouched).
export async function compactIfNeeded({ messages, prevSummary = '', onUsage }) {
  const total = historyTokens(messages);
  if (total <= COMPACT_HIGH) return { history: messages, summary: prevSummary, compacted: false };

  // 1) Trims the read raw (except the last turn). splitIndex runs over the
  // trimmed version, so the SAME LOW budget now fits MORE conversation
  // verbatim — what leaves is already-consumed tool result, not a turn.
  const { messages: leaned, cutTok } = stubRawReads(messages, lastTurnStart(messages));
  const leanedTotal = historyTokens(leaned);

  const cut = splitIndex(leaned, COMPACT_LOW);
  // If trimming alone already solved it (or there's no safe turn boundary to
  // cut at), returns the trimmed history without summarizing: no turn is lost and the
  // consumed raw doesn't get charged again on the following turns.
  if (cut <= 0) {
    if (cutTok > 0) console.log(`[compact] leaned-only ${total}->${leanedTotal} tok (-${cutTok})`);
    return { history: cutTok > 0 ? leaned : messages, summary: prevSummary, compacted: false, leanedTok: cutTok };
  }

  const old = messages.slice(0, cut);   // RAW: the summary has to see the original data
  const recent = leaned.slice(cut);     // TRIMMED: this is what goes on in the prompt
  let summary = prevSummary;
  try {
    summary = await summarize(prevSummary, old, onUsage);
  } catch {
    // if the summary fails, do NOT discard turns: keep everything so as not to lose context
    return { history: messages, summary: prevSummary, compacted: false };
  }
  return { history: recent, summary, compacted: true, droppedTurns: old.length, leanedTok: cutTok };
}
