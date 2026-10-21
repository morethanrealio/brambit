// While an action waits on its confirmation card, the platform says what state
// it is in, not the assistant. In production the assistant's own text around a
// waiting card said it was done in 20 of 408 replies (2026-10-21): "Deixei o
// evento preparado na sua agenda", 'Rotina "X" criada:', "Anotado no Space".
// The owner read it as done, never confirmed, and the action never happened.
//
// This drops each sentence that claims an action of the same kind as an open
// card is done; the card itself says it is not done yet (confirmation-flow.mjs).
// What the assistant really did in the same turn stays: when a tool of that
// kind also ran without a card, only a sentence naming the card's own title is
// dropped, and a claim that names no object is dropped only when nothing but
// the cards and reads ran.
import { proposalCard, proposalPresentation } from './confirmation-flow.mjs';

const FAMILIES = {
  calendar: [/^(?:outlook_)?calendar_/, 'agendas?|calendarios?|eventos?|reuni(?:ao|oes)|compromissos?|consultas?|events?|calendars?|meetings?|appointments?|reunion(?:es)?|citas?'],
  routine: [/^(?:criar|editar|cancelar)_rotina$|^agendar_execucao_rotina$|^executar_rotina_agora$/, 'rotinas?|avisos?|routines?|rutinas?'],
  note: [/^(?:editar_nota|anotar_no_espaco|apagar_nota|criar_lista|editar_lista)$|^(?:infinity|notion)_/, 'notas?|spaces?|espacos?|listas?|secao|secoes|kanban|planner|quadros?|notes?|lists?|boards?|sections?|espacios?|seccion(?:es)?'],
  file: [/^(?:drive_upload(?:_arquivo)?|drive_export_pdf|docs_create|enviar_para_drive|onedrive_upload(?:_arquivo)?|editar_planilha)$/, 'arquivos?|pastas?|drive|documentos?|docs?|planilhas?|pdf|files?|folders?|documents?|spreadsheets?|sheets?|archivos?|carpetas?|hojas?'],
  expense: [/^splitwise_/, 'despesas?|gastos?|splitwise|expenses?'],
  message: [/^(?:gmail_send|gmail_create_draft|hotmail_send|slack_post_message|linkedin_post|responder_pergunta_externa|falar_com_agente|asaas_enviar_comprovante_email|enviar_mensagem)$/, 'e-?mails?|mensage(?:m|ns)|slack|posts?|messages?|correos?|mensajes?'],
  payment: [/^asaas_(?:pagar_conta|transferir_pix|receber_pix|cancelar_pagamento_conta)$/, 'pix|boletos?|pagamentos?|transferencias?|payments?|transfers?|pagos?'],
  // Never behind a card: a sentence naming them is about something else.
  reminder: [/_lembrete$/, 'lembretes?|reminders?|recordatorios?'],
  memory: [/^memoria_/, 'memoria|memory'],
};
const familyOf = tool => Object.keys(FAMILIES).find(f => FAMILIES[f][0].test(tool || '')) || null;
const nounsOf = Object.fromEntries(Object.entries(FAMILIES).map(([f, [, n]]) => [f, new RegExp(String.raw`(?<![\p{L}\d-])(?:${n})(?![\p{L}\d])`, 'u')]));
const READ_TOOL = /^(?:consultar|listar|buscar|ler|reler|ver|pesquisar|obter|status|analisar|checar)_|_(?:list|search|read|get|labels|filters_list|listar|buscar|consultar|ler|expenses|groups|saldo)$|^(?:pesquisar|google|abrir_ferramentas|pasta_listar)$/;

const fold = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’`]/g, "'");
const mask = s => s.replace(/"[^"\n]*"|“[^”\n]*”/g, q => q[0] + 'x'.repeat(q.length - 2) + q[q.length - 1]);

// Done-claims, in folded text. "Ready" words only claim a result when they
// place it somewhere ("preparado na sua agenda"); "deixei o evento pronto:"
// before the card describes the proposal. Words that also describe an event's
// current state ("está marcado pras 9h") need a past or headline form.
const ALL_NOUNS = Object.values(FAMILIES).map(([, n]) => n).join('|');
const DONE = String.raw`(?:criad|adicionad|incluid|atualizad|ajustad|alterad|mudad|cancelad|pausad|desativad|apagad|removid|excluid|lancad|anotad|registrad|enviad|transferid|publicad|configurad|colocad|movid|cread|anadid|actualizad|cambiad|borrad|eliminad|guardad|pagad)[oa]s?|salv[oa]s?|pag[oa]s?|created|added|updated|changed|canceled|cancelled|paused|deleted|removed|saved|sent|paid|posted|uploaded|adjusted|moved`;
const READY = String.raw`(?:pront|preparad|feit)[oa]s?|listos?|hechos?|done|ready`;
const STATE = String.raw`(?:marcad|remarcad|agendad|programad)[oa]s?|scheduled|booked|rescheduled|set up`;
const PLACE = String.raw`(?:\b(?:n[ao]s?|em|in|on|en)\s+(?:(?:sua|seu|suas|seus|your|the|tu|tus|la|el)\s+)?(?:${ALL_NOUNS})\b|\b(?:la|ali|alli|ahi)\s+dentro\b)`;
const ADVERB = String.raw`(?:tudo|todos?|todas?|devidamente|certinho|bem|ja|agora|tambem|also|already|just|all|successfully|ya|todo)\s+`;
const ANY = `${DONE}|${STATE}|${READY}`;
const CLAIMS = [
  /(?<![\p{L}])(?:criei|marquei|remarquei|coloquei|botei|adicionei|atualizei|ajustei|alterei|mudei|troquei|editei|cancelei|pausei|desativei|apaguei|removi|deletei|lancei|anotei|agendei|registrei|salvei|guardei|enviei|mandei|paguei|transferi|publiquei|postei|configurei|programei|movi|subi|cree|agende|anadi|actualice|cambie|cancele|borre|elimine|envie|pague|puse)(?![\p{L}])/u,
  /\bi(?:'ve| have)?\s+(?:just\s+|already\s+|also\s+)?(?:created|added|updated|scheduled|set up|moved|changed|edited|canceled|cancelled|paused|deleted|removed|saved|sent|paid|posted|booked|uploaded|included|put|logged|noted|adjusted|rescheduled|transferred)\b/,
  new RegExp(String.raw`\b(?:deixei|deixamos|deje|dejamos|i(?:'ve| have)?\s+(?:left|got))\b[^.!?]{0,80}?(?:\b(?:${DONE}|${STATE})\b|${PLACE})`),
  new RegExp(String.raw`\b(?:foi|foram|ficou|ficaram|was|were|has been|have been|fue|fueron|quedo|quedaron)\s+(?:${ADVERB}){0,2}(?:${ANY})\b`),
  new RegExp(String.raw`\b(?:esta|estao|ta|tao|is|are|estan)\s+(?:${ADVERB}){0,2}(?:(?:${DONE})\b|(?:${READY})\b[^.!?]{0,40}?${PLACE})`),
  // A headline: the clause opens with the participle ("Cancelado — a rotina",
  // "Anotado no Space") or names the object and ends in it ('Rotina "X" criada:').
  new RegExp(String.raw`^(?:${ADVERB})?(?:${ANY})\b(?!\s+(?:por|pela|pelo|by)\b)`),
  new RegExp(String.raw`^(?:(?:o|a|os|as|seu|sua|the|your|el|la|tu)\s+)?(?:${ALL_NOUNS})\b(?:\s+[\p{L}\dx"“”&'-]+){0,4}?\s+(?:${ADVERB})?(?:(?:${DONE}|${STATE})\b|(?:${READY})\b[^.!?]{0,40}?${PLACE})`, 'u'),
  /^(?:pronto|prontinho|feito|done|all set|listo|hecho|tudo certo|tudo pronto)\s*[!.]?\s*(?:,\s*[\p{L}]+\s*[!.]?)?$/u,
];
// Sentences that say the action still waits, ask, deny, talk about later, or
// mention an earlier action in a relative clause ("as calorias que registrei").
const NOT_A_CLAIM = /\?|\b(?:confirm|aprov|autoriz|approv|authoriz)|\b(?:nao|nunca|nada|nenhum|nenhuma|ainda|not|never|nothing|none|yet|haven't|didn't|todavia|aun|ni|ningun|ninguna)\b|\bno\s+(?:lo|la|los|las|he|hemos|se|fue|esta)\b|^\s*(?:se|caso|quando|assim que|depois que|if|once|when|after|si|cuando)\b|\b(?:vou|vamos|irei|posso|podemos|pode|quer|quiser|will|i'll|can|could|would|shall|voy|puedo|puedes|a ser|to be|which (?:was|were|is))\b|\bque\s+(?:eu\s+)?(?:ja\s+)?(?:foi|foram|esta|estao|ficou|ficaram|[a-z]{2,}ei)\b|\b(?:pront|preparad)[oa]s?\s+(?:pra|para|to|for)\b/;

const claimOf = sentence => {
  // "Incluí" folds into the present tense "inclui"; read it before folding.
  const past = String(sentence).toLowerCase().replace(/(?<![\p{L}])incluí(?![\p{L}])/gu, 'adicionei').replace(/(?<![\p{L}])excluí(?![\p{L}])/gu, 'removi');
  const s = mask(fold(past)).replace(/[*_~#>•]/g, ' ').replace(/^[^\p{L}\d"“]+/u, '').replace(/\s+/g, ' ').trim();
  if (!s || NOT_A_CLAIM.test(s)) return null;
  const head = s.split(/\s+[—–]\s+|:\s|[,;]\s/)[0];
  return CLAIMS.some((re, i) => re.test(i >= 5 ? head : s)) ? s : null;
};
const titlesOf = row => [...String(row.confirmationText || '').matchAll(/"([^"\n]{3,})"|“([^”\n]{3,})”/g)].map(m => fold(m[1] || m[2]));
// Splits on sentence ends like action-evidence.mjs does, never inside a quote.
function sentences(line) {
  const masked = mask(line), out = [];
  let from = 0;
  for (const m of masked.matchAll(/(?<=[.!?])\s+(?=[\p{Lu}])/gu)) { out.push(line.slice(from, m.index)); from = m.index + m[0].length; }
  out.push(line.slice(from));
  return out;
}

export function presentPendingCards(text, session, { journal = [], toolCounts = {} } = {}) {
  const open = session.pending();
  const created = open.filter(r => session.createdIds.has(r.id));
  const madeHere = (session.rows || []).filter(r => session.createdIds.has(r.id));
  // A tool of the family that ran more times than it left cards did something.
  const acted = new Set(journal.filter(e => !['pending', 'failed', 'unknown'].includes(e.state)).map(e => familyOf(e.tool) || e.family));
  let otherWork = acted.size > 0;
  for (const [tool, n] of Object.entries(toolCounts || {})) {
    if (n <= madeHere.filter(r => r.name === tool).length) continue;
    if (familyOf(tool)) acted.add(familyOf(tool));
    else if (!READ_TOOL.test(tool)) otherWork = true;
  }
  if (acted.size) otherWork = true;
  const cardFamilies = new Set(open.map(r => familyOf(r.name)).filter(Boolean));
  const dropped = new Set();
  let fenced = false;
  const kept = String(text || '').split('\n').map(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
    if (fenced || /^\s*>/.test(line) || /\[\[acao:|\{\{acao:/.test(line)) return line;
    const parts = sentences(line).filter(sentence => {
      const claim = claimOf(sentence);
      if (!claim) return true;
      const raw = fold(sentence);
      const byTitle = open.filter(r => titlesOf(r).some(t => raw.includes(t)));
      const named = Object.keys(FAMILIES).filter(f => nounsOf[f].test(claim));
      const about = byTitle.length ? byTitle
        : !named.length ? (created.length && !otherWork ? created : [])
        : named.every(f => cardFamilies.has(f)) ? open.filter(r => named.includes(familyOf(r.name)) && !acted.has(familyOf(r.name))) : [];
      about.forEach(r => dropped.add(r));
      return !about.length;
    });
    return parts.length || !line.trim() ? parts.join(' ') : null;
  }).filter(line => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Earlier cards whose action the text called done are shown again, so the
  // last thing the owner reads about them is that they still wait.
  const card = created.length ? proposalPresentation(created)
    : [...dropped].map(proposalCard).join('\n\n');
  return { text: dropped.size ? kept : String(text || ''), card };
}
