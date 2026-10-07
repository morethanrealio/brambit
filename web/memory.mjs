import {selectedDeepSeek} from '../core-proto/deepseek/scope.mjs';
// ── Compactação de history (resumo rolante por token) ──
// Quando a conversa cresce, dobramos os turnos antigos num "resumo rolante" e
// mantemos só os turnos recentes verbatim. O resumo entra no system prompt.
// Métrica = token estimado (chars/4). Histerese: dispara no HIGH, corta até o LOW.
// Tudo tunável por env. Ver projetos/arquitetura-memoria.md (seção 6).

import { makeMemoriaModel } from './memoria-modelo.mjs';

export const COMPACT_HIGH = Number(process.env.COMPACT_HIGH || 24000); // gatilho
export const COMPACT_LOW = Number(process.env.COMPACT_LOW || 12000);   // alvo pós-corte
export const SUMMARY_CAP = Number(process.env.SUMMARY_CAP || 3000);    // teto da prosa do resumo
export const LEDGER_CAP = Number(process.env.LEDGER_CAP || 6000);      // teto do ledger de dados concretos (chars)

// ── Ledger de dados concretos (verbatim, à prova de compressão) ──
// A prosa do resumo (via Flash) tende a engolir dado duro que o usuário COLA
// (datas, horários, endereços, preços, links, escolhas). O ledger guarda essas
// linhas VERBATIM fora da compressão do modelo e acumula entre compactações.
const LEDGER_MARK = '━━ DADOS DO USUÁRIO (verbatim, não alterar) ━━';

// Sinais de "dado concreto" numa linha colada pelo usuário.
const FACT_PATTERNS = [
  /\b\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?\b/,                         // datas 22/07, 22-07-2026
  /\b\d{1,2}\s?[:hH]\s?\d{2}\b/,                                          // horários 21:26, 9h30
  /R\$\s?\d/,                                                             // preços R$ 180
  /\bhttps?:\/\/\S+/i,                                                    // links
  /\b(rua|av\.?|avenida|alameda|travessa|estrada|rodovia|pça|praça)\b/i,  // endereço
  /\b\d{5}-?\d{3}\b/,                                                     // CEP
  /\b(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)\b/i,        // dias da semana
  /\b\d{1,3}\s?(reais|real|brl|usd|d[óo]lares?)\b/i,                      // valores por extenso
  /\b(voo|check[- ]?in|check[- ]?out|reserva|localizador|confirma[çc][ãa]o|cpf|cnpj|oab)\b/i,
];

const normFact = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Extrai as linhas de dado concreto das mensagens do USUÁRIO (é o que ele "cola").
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

// Junta ledger antigo + novos fatos, dedupe (mantém 1ª ocorrência), cap por chars
// preservando os MAIS RECENTES (dropa os mais antigos se estourar).
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

// Compõe prosa + ledger numa única string de resumo.
function composeSummary(prose, ledger) {
  let p = (prose || '').trim();
  if (estTokens(p) > SUMMARY_CAP) p = p.slice(0, SUMMARY_CAP * 4);
  if (!ledger?.length) return p;
  return `${p}\n\n${LEDGER_MARK}\n${ledger.map((l) => `- ${l}`).join('\n')}`.trim();
}

// Estima tokens de um texto (heurística barata, sem tokenizer).
export const estTokens = (s) => Math.ceil((s || '').length / 4);

// Serializa uma mensagem do core pra texto (pra estimar e pra resumir).
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

// ── Corte de resultado CRU de tool de LEITURA (dentro da compactação) ──
// Tool de LEITURA = o resultado é CONSUMIDO no turno e não é estado: a resposta
// do assistente já carrega o que importava dele. Guardar o JSON/HTML cru no
// history só paga input token de novo em todo turno seguinte. Medido em replay
// offline sobre 20 threads reais (01/09/2026): -30% de history sem perda de
// qualidade detectável (o braço de CONTROLE, com input idêntico, marcou "perdeu
// info" nos mesmos 4 casos — é ruído de geração, não do corte).
//
// FICAM DE FORA de propósito:
// • sandbox_*/escrever_*/planilha/app files → é ESTADO de trabalho, não consumo;
// • listar_lembretes, calendar_list, gmail_* → agenda e caixa que a pessoa está
//   manuseando AGORA; o resultado costuma ser o assunto do próximo turno.
export const READ_TOOLS_CUT = new Set([
  'buscar_web', 'pesquisar', 'google', 'abrir_link', 'memoria_ler', 'ver_midia',
  'listar_midia', 'ler_arquivo_do_app', 'ler_conversa', 'reler_esta_conversa',
  'rodar_leitura', 'ler_arquivo', 'buscar_no_codigo', 'listar_arquivos',
  'ver_diff', 'ver_historico', 'ler_espaco', 'ler_skill', 'listar_rotinas',
  'status_conta', 'buscar_produtos', 'analisar_produto', 'nuvemshop_pedidos',
  'splitwise_groups', 'infinity_itens', 'infinity_item', 'infinity_board_estrutura', 'github', 'microsoft', 'checar_monitor', 'listar_sistemas',
  'abrir_ferramentas', 'buscar_conversas', 'listar_arquivos_do_app',
]);

// Abaixo disso o stub sai igual ou maior que o conteúdo: não vale trocar.
const CUT_MIN_TOKENS = 60;
const stubFor = (name) => `[resultado de ${name} não guardado no histórico; refaça a chamada se precisar de novo]`;

// Substitui por stub os resultados crus de leitura nos índices < `upto`.
// Preserva role/name/tool_call_id e o TAMANHO do array (o pareamento
// toolCall↔resultado que o provider exige continua de pé).
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

// Índice onde começa o ÚLTIMO turno (fronteira 'user'). O turno mais recente
// nunca é enxugado: é o "e o segundo?" logo depois de uma busca.
function lastTurnStart(messages) {
  for (let i = (messages?.length || 0) - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
  return messages?.length || 0;
}

// Acha o índice de corte: mantém o MAIOR sufixo de turnos (começando num 'user')
// cujo total de tokens <= LOW. Devolve o índice onde começa a parte "recente".
function splitIndex(messages, lowTokens) {
  // índices de fronteira de turno = onde role === 'user'
  const bounds = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') bounds.push(i);
  if (bounds.length <= 1) return 0; // 0 ou 1 turno: não dá pra compactar com segurança

  // do último turno pro mais antigo, acumula até estourar o LOW
  let acc = 0;
  let chosen = bounds[bounds.length - 1]; // pelo menos o último turno fica
  for (let b = bounds.length - 1; b >= 0; b--) {
    const start = bounds[b];
    const end = b + 1 < bounds.length ? bounds[b + 1] : messages.length;
    let turnTok = 0;
    for (let i = start; i < end; i++) turnTok += msgTokens(messages[i]);
    if (acc + turnTok > lowTokens && acc > 0) break; // já temos algo e estouraria
    acc += turnTok;
    chosen = start;
  }
  return chosen;
}

// Resume os turnos antigos, incorporando o resumo anterior.
// A prosa é comprimida pelo Flash (cap SUMMARY_CAP); o ledger de dados concretos
// é preservado VERBATIM fora da compressão e acumulado entre compactações.
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
  // Esta chamada é paga e era invisível: o usage voltava do provider e era
  // descartado aqui, então nenhuma linha de usage_events representava a
  // compactação. Toda análise de custo por thread saía subestimada, e sem número
  // não há como decidir se o resumo se paga (ele troca turnos crus reenviados a
  // cada passo por uma chamada só, mas isso é hipótese até ser medido).
  if (r?.usage && onUsage) { try { onUsage(r.usage); } catch {} }
  const prose = (r.text || '').trim() || prevProse || '';
  const ledger = mergeLedger(prevLedger, extractFacts(oldMessages));
  return composeSummary(prose, ledger) || prevSummary || '';
}

// Compacta se passar do HIGH. Devolve { history, summary, compacted }.
// `messages` = history completo já com o turno novo; `prevSummary` = resumo atual do agente.
//
// O enxugamento dos resultados crus de leitura acontece SÓ AQUI, no mesmo evento
// da compactação, de propósito: é o único momento em que o prefixo do prompt já
// vai ser reescrito de qualquer forma, então o cache não paga nada a mais. Fazer
// isso a cada turno derrubaria o cache toda vez (frequência de compactação e
// tuning de cache seguem intocados).
export async function compactIfNeeded({ messages, prevSummary = '', onUsage }) {
  const total = historyTokens(messages);
  if (total <= COMPACT_HIGH) return { history: messages, summary: prevSummary, compacted: false };

  // 1) Enxuga o cru de leitura (menos o último turno). O splitIndex roda sobre a
  // versão enxuta, então o MESMO orçamento de LOW passa a caber MAIS conversa
  // verbatim — o que sai é resultado de tool já consumido, não turno.
  const { messages: leaned, cutTok } = stubRawReads(messages, lastTurnStart(messages));
  const leanedTotal = historyTokens(leaned);

  const cut = splitIndex(leaned, COMPACT_LOW);
  // Se só o enxugamento já resolveu (ou não há fronteira segura de turno pra
  // cortar), devolve o history enxuto sem resumir: nenhum turno é perdido e o
  // cru consumido não volta a ser cobrado nos turnos seguintes.
  if (cut <= 0) {
    if (cutTok > 0) console.log(`[compact] leaned-only ${total}->${leanedTotal} tok (-${cutTok})`);
    return { history: cutTok > 0 ? leaned : messages, summary: prevSummary, compacted: false, leanedTok: cutTok };
  }

  const old = messages.slice(0, cut);   // CRU: o resumo tem que ver o dado original
  const recent = leaned.slice(cut);     // ENXUTO: é o que segue no prompt
  let summary = prevSummary;
  try {
    summary = await summarize(prevSummary, old, onUsage);
  } catch {
    // se o resumo falhar, NÃO descarta turnos: mantém tudo pra não perder contexto
    return { history: messages, summary: prevSummary, compacted: false };
  }
  return { history: recent, summary, compacted: true, droppedTurns: old.length, leanedTok: cutTok };
}
