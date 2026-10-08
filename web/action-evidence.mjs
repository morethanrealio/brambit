import { randomUUID } from 'node:crypto';
import { marca } from './marca.mjs';
import { connectorActionReceipt } from './connector-action-evidence.mjs';
import { recurrenceLabel } from './calendar-recurrence.mjs';
// Action receipts are created by the code at the execution boundary, never by
// the model nor from a plain tool_call. No network, retries or storage.
const NATIVE = new Set(['criar_lembrete', 'enviar_mensagem', 'enviar_sugestao_time', 'agendar_execucao_rotina', 'executar_rotina_agora', 'memoria_anotar', 'memoria_atualizar', 'memoria_escrever']);
const MAIL = new Set(['gmail_send', 'gmail_create_draft']);
export function actionResult(evidence, text) {
  return JSON.stringify({ action_evidence: { version: 1, ...evidence }, text });
}
// These messages come from the native routine executor, never arbitrary tool text.
export function routineActionFailure(detail, routine = null, state = 'routine_blocked') {
  return actionResult({state, detail, id:routine?.id, target:routine?.channel || 'app', subject:routine?.title}, detail);
}
export function resultData(out) {
  if (out && typeof out === 'object' && !Array.isArray(out)) return out;
  try { const v = JSON.parse(out); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
const clean = (v, limit = 300) => String(v ?? '').replace(/[\r\n\t]/g, ' ')
  .replace(/\[\[acao:[^\]]*\]\]|\{\{acao:[^}]*\}\}/g, '')
  .replace(/\[\[|\]\]/g, '').slice(0, limit);
const validId = id => (typeof id === 'string' && id.trim().length > 0) || (typeof id === 'number' && Number.isFinite(id) && id > 0);
const family = name => name === 'criar_lembrete' ? 'reminder'
  : name === 'enviar_sugestao_time' ? 'support'
  : ['memoria_anotar','memoria_atualizar','memoria_escrever'].includes(name) ? 'memory'
  : name === 'agendar_execucao_rotina' ? 'routine_schedule'
  : name === 'executar_rotina_agora' ? 'routine_run'
  : 'message';
const words = {
  'pt': { unknown:'Não consegui confirmar isso agora, então prefiro não dizer que está feito. Se ainda precisar, é só me pedir.', pending:'Ação ainda não executada; aguarda sua confirmação.', scheduled:'Lembrete agendado, não enviado', get registered() { return `Sugestão enviada ao time do ${marca().nome}`; }, saved:'Informação salva na memória permanente', already_saved:'Essa informação já estava salva na memória permanente', draft:'Rascunho criado, não enviado', accepted:'Envio aceito pelo serviço; entrega e leitura não confirmadas', failed:'A ação não foi concluída', check:'conclusão a confirmar; não verificada nesta resposta', reported:'informado por você; não verificado no serviço', target:'Destino', at:'Horário', ref:'Referência', subject:'Ação' },
  'en': { unknown:'I could not confirm this now, so I would rather not say it is done. If you still need it, just ask me.', pending:'Action not executed; awaiting your confirmation.', scheduled:'Reminder scheduled, not sent', get registered() { return `Suggestion sent to the ${marca().nome} team`; }, saved:'Information saved to permanent memory', already_saved:'That information was already in permanent memory', draft:'Draft created, not sent', accepted:'Send accepted by the service; delivery and reading not confirmed', failed:'The action was not completed', check:'completion needs confirmation; not verified in this reply', reported:'reported by you; not verified with the service', target:'Destination', at:'Time', ref:'Reference', subject:'Action' },
  'es': { unknown:'No pude confirmar esto ahora, así que prefiero no decir que está hecho. Si aún lo necesitas, pídemelo.', pending:'Acción no ejecutada; espera tu confirmación.', scheduled:'Recordatorio programado, no enviado', get registered() { return `Sugerencia enviada al equipo de ${marca().nome}`; }, saved:'Información guardada en la memoria permanente', already_saved:'Esa información ya estaba guardada en la memoria permanente', draft:'Borrador creado, no enviado', accepted:'Envío aceptado por el servicio; entrega y lectura no confirmadas', failed:'La acción no se completó', check:'finalización por confirmar; no verificada en esta respuesta', reported:'informado por ti; no verificado en el servicio', target:'Destino', at:'Horario', ref:'Referencia', subject:'Acción' },
};
// Labels printed by the receipt itself. The model sometimes echoes the whole
// receipt in its own text; when the initial claim is swapped for the real
// receipt (which already carries these fields), the later echoes become
// orphaned and the destination/time shows up duplicated (msg 18000, 2026-09-16).
const RECEIPT_FIELD = /^\s*(?:destino|destination|hor[áa]rios?|times?|refer[êe]ncia|reference|a[çc][ãa]o|acci[óo]n|action)\s*:\s*[^\n]{0,120}$/i;
const languageKey = language => /^en\b/i.test(language) ? 'en' : /^es\b/i.test(language) ? 'es' : 'pt';
const routineWords={
 pt:{routine_scheduled:'Execução extra da rotina agendada; a cadência normal não foi alterada',routine_complete:'Rotina executada; conteúdo completo',routine_partial:'Rotina executada; conteúdo parcial',routine_content_failed:'Rotina executada; a geração do conteúdo falhou e somente o aviso de falha seguiu para o canal',routine_failed:'A execução da rotina não foi concluída'},
 en:{routine_scheduled:'Extra routine execution scheduled; the normal cadence was not changed',routine_complete:'Routine executed; content complete',routine_partial:'Routine executed; content partial',routine_content_failed:'Routine executed; content generation failed and only the failure notice went to the channel',routine_failed:'The routine execution was not completed'},
 es:{routine_scheduled:'Ejecución extra de la rutina programada; la cadencia normal no cambió',routine_complete:'Rutina ejecutada; contenido completo',routine_partial:'Rutina ejecutada; contenido parcial',routine_content_failed:'Rutina ejecutada; falló la generación del contenido y solo se envió el aviso de fallo al canal',routine_failed:'La ejecución de la rutina no se completó'},
};
const reminderGroupWords={
 pt:{scheduled:n=>`${n} lembretes agendados, não enviados`,ats:'Horários'},
 en:{scheduled:n=>`${n} reminders scheduled, not sent`,ats:'Times'},
 es:{scheduled:n=>`${n} recordatorios programados, no enviados`,ats:'Horarios'},
};
const connectorWords = {
  pt: {created:'Registro criado no serviço',updated:'Alteração confirmada pelo serviço',deleted:'Exclusão confirmada pelo serviço',saved_file:'Arquivo salvo no serviço',commented:'Comentário publicado no serviço',partial:'Ação parcialmente concluída; confira o conteúdo salvo antes de continuar'},
  en: {created:'Record created in the service',updated:'Change confirmed by the service',deleted:'Deletion confirmed by the service',saved_file:'File saved in the service',commented:'Comment published in the service',partial:'Action partially completed; check the saved content before continuing'},
  es: {created:'Registro creado en el servicio',updated:'Cambio confirmado por el servicio',deleted:'Eliminación confirmada por el servicio',saved_file:'Archivo guardado en el servicio',commented:'Comentario publicado en el servicio',partial:'Acción parcialmente completada; revisa el contenido guardado antes de continuar'},
};
export function renderAction(e, language = 'pt-BR') {
  const lang=languageKey(language),w = words[lang];
  if (e.family === 'tracker') return renderTracker(e, lang);
  if (e.family === 'list' && e.state === 'saved') return lang==='en' ? `List "${clean(e.subject)}" saved.` : lang==='es' ? `Lista "${clean(e.subject)}" guardada.` : `Lista "${clean(e.subject)}" salva.`;
  if (e.family === 'reminder' && e.state === 'deleted') return (lang==='en' ? 'Reminder canceled.' : lang==='es' ? 'Recordatorio cancelado.' : 'Lembrete cancelado.') + (e.inFlight ? (lang==='en'?' A delivery already started and may still arrive.':lang==='es'?' Un envío ya empezó y todavía puede llegar.':' Um envio já havia começado e ainda pode chegar.') : '');
  if (e.family === 'reminder' && e.state === 'updated') return (lang==='en'?'Next reminder rescheduled; the remaining cadence is unchanged.':lang==='es'?'Próximo aviso reprogramado; la cadencia restante no cambia.':'Próximo aviso remarcado; a cadência dos demais foi preservada.') + ` ${w.at}: ${clean(e.at)}. ${w.target}: ${clean(e.target)}.`;
  if (e.family === 'routine_run' && e.detail && ['routine_blocked','unknown'].includes(e.state)) return e.detail;
  let text = connectorWords[lang][e.state] || routineWords[lang][e.state] || w[e.state] || w.unknown;
  // The text of a reminder can be the entire future message. It and the
  // storage ID stay in the typed receipt/log for proof and support, but do
  // not belong in the conversation. The visible confirmation needs to be
  // short and human.
  if (e.subject && e.family !== 'reminder') text += `. ${w.subject}: ${clean(e.subject)}`;
  if (e.target) text += `. ${w.target}: ${clean(e.target)}`;
  const at = e.recurrence ? recurrenceLabel(e.recurrence.rule,e.recurrence.start,e.recurrence.timezone,language) : e.at;
  if (at) text += `. ${w.at}: ${clean(at)}`;
  if (e.delivery === 'accepted') text += lang==='en' ? '. Delivery accepted by the platform; final delivery and reading are not confirmed' : lang==='es' ? '. Entrega aceptada por la plataforma; la entrega final y la lectura no están confirmadas' : '. Entrega aceita pela plataforma; entrega final e leitura não são confirmadas';
  else if (e.delivery === 'saved') text += lang==='en' ? '. Result saved in the app' : lang==='es' ? '. Resultado guardado en la app' : '. Resultado salvo no app';
  if (e.state === 'unknown' && connectorActionReceipt(e.tool, {}, null)) text += lang==='en'
    ? ' Check the service before requesting another attempt; I have not repeated this action.'
    : lang==='es' ? ' Revisa el servicio antes de pedir otro intento; no repetí esta acción.'
    : ' Confira o serviço antes de pedir outra tentativa; não repeti essa ação.';
  return (text.endsWith('.') ? text : text + '.') + (e.link ? `\n${clean(e.link)}` : '');
}
function renderActions(es, language = 'pt-BR') {
  const reminders=es.filter(e=>e.family==='reminder'&&e.state==='scheduled');
  if(es.length<2||reminders.length!==es.length)return es.map(e=>renderAction(e,language)).join('\n');
  const lang=languageKey(language),w=words[lang],g=reminderGroupWords[lang];
  const ats=[...new Set(reminders.map(e=>clean(e.at)).filter(Boolean))];
  const targets=[...new Set(reminders.map(e=>clean(e.target)).filter(Boolean))];
  let text=g.scheduled(reminders.length);
  if(ats.length)text+=`. ${g.ats}: ${ats.join('; ')}`;
  if(targets.length)text+=`. ${w.target}: ${targets.join(', ')}`;
  return text.endsWith('.')?text:text+'.';
}
// Keep completed actions visible next to a new proposal, without echoing a
// generic pending receipt or repeating saves to the same list.
export function renderCompletedActions(entries, language = 'pt-BR') {
  const lists = new Set();
  return renderActions(entries.filter(e => {
    if (e.state === 'pending') return false;
    if (e.family !== 'list' || e.state !== 'saved') return true;
    if (lists.has(e.id)) return false;
    lists.add(e.id);
    return true;
  }), language);
}
// Countable records (web/trackers.mjs): only the tool's success phrase proves
// the write. A question, ambiguity or error never becomes a receipt, and the
// model's "anotei" in those cases stays unproven. Without this, the "anotei"
// of a registrar_evento that actually wrote would drop from the response and,
// when it was the entire response, it turned into "Não consegui confirmar
// isso agora" (case 2026-10-05).
const TRACKER = {
  registrar_evento: [/^Registrado em "(.+)": (\d{4}-\d{2}-\d{2})(?: valor (-?\d+(?:\.\d+)?))?/, m => ({ state:'recorded', subject:m[1], at:m[2], value:m[3] })],
  remover_evento: [/^Removi (\d+) lançamentos? de "(.+)" em (\d{4}-\d{2}-\d{2})\.$/, m => ({ state:'removed', subject:m[2], at:m[3], value:m[1] })],
  remover_tracker: [/^Parei de acompanhar "(.+)" \(/, m => ({ state:'stopped', subject:m[1] })],
};
// The query also proves, but only the state it read: "já está anotado" after
// consultar_evento was being cut as "done without proof" and the fact read
// from the database disappeared from the response (msg 8494, 2026-10-05).
// Error and "não achei" still have no receipt.
function trackerReadReceipt(out) {
  const d = resultData(out);
  if (typeof d?.registro !== 'string' || !Number.isInteger(d.eventos)) return null;
  const p = d.periodo && typeof d.periodo === 'object' ? d.periodo : {};
  return { family:'tracker', tool:'consultar_evento', state:'found', subject:d.registro, value:String(d.eventos),
    total:Number(d.soma) ? String(d.soma) : '', unit:clean(d.unidade || '', 30), from:clean(p.de || ''), to:clean(p.ate || ''),
    id:`tracker:${d.registro}:${p.de || ''}:${p.ate || ''}` };
}
function trackerReceipt(name, out) {
  const [re, read] = TRACKER[name];
  const m = typeof out === 'string' ? out.match(re) : null;
  if (!m) return null;
  const r = read(m);
  return { family:'tracker', tool:name, ...r, id:`tracker:${r.subject}:${r.at || ''}` };
}
function renderTracker(e, lang) {
  const t = clean(e.subject), iso = clean(e.at);
  const dia = lang === 'en' ? iso : iso.split('-').reverse().join('/');
  const valor = e.value ? (lang === 'en' ? `, value ${clean(e.value)}` : `, valor ${clean(e.value).replace('.', ',')}`) : '';
  const n = Number(e.value);
  if (e.state === 'found') return renderTrackerRead(e, lang, t, n);
  if (e.state === 'recorded') return lang==='en' ? `Recorded in "${t}" (${dia}${valor}).`
    : lang==='es' ? `Anotado en "${t}" (${dia}${valor}).` : `Anotado em "${t}" (${dia}${valor}).`;
  if (e.state === 'removed') return lang==='en' ? `Removed from "${t}": ${n} ${n === 1 ? 'entry' : 'entries'} on ${dia}.`
    : lang==='es' ? `Eliminado de "${t}": ${n} ${n === 1 ? 'registro' : 'registros'} del ${dia}.`
    : `Removido de "${t}": ${n} ${n === 1 ? 'lançamento' : 'lançamentos'} de ${dia}.`;
  return lang==='en' ? `Stopped tracking "${t}"; the history is kept.`
    : lang==='es' ? `Dejé de seguir "${t}"; el historial se conserva.` : `Parei de acompanhar "${t}"; o histórico fica guardado.`;
}
function renderTrackerRead(e, lang, t, n) {
  const d = iso => lang === 'en' ? clean(iso) : clean(iso).split('-').reverse().join('/');
  const de = e.from, ate = e.to;
  const quando = de && de === ate ? { pt:` em ${d(de)}`, en:` on ${d(de)}`, es:` el ${d(de)}` }
    : de && ate ? { pt:` de ${d(de)} a ${d(ate)}`, en:` from ${d(de)} to ${d(ate)}`, es:` del ${d(de)} al ${d(ate)}` }
    : de ? { pt:` desde ${d(de)}`, en:` since ${d(de)}`, es:` desde ${d(de)}` }
    : ate ? { pt:` até ${d(ate)}`, en:` until ${d(ate)}`, es:` hasta ${d(ate)}` } : { pt:'', en:'', es:'' };
  const unit = e.unit ? ` ${clean(e.unit)}` : '';
  const total = e.total ? (lang === 'en' ? `, total ${clean(e.total)}${unit}` : `, total ${clean(e.total).replace('.', ',')}${unit}`) : '';
  if (!n) return lang==='en' ? `Nothing recorded in "${t}"${quando.en}.` : lang==='es' ? `No hay nada anotado en "${t}"${quando.es}.` : `Não há nada anotado em "${t}"${quando.pt}.`;
  return lang==='en' ? `Recorded in "${t}"${quando.en}: ${n} ${n === 1 ? 'entry' : 'entries'}${total}.`
    : lang==='es' ? `Anotado en "${t}"${quando.es}: ${n} ${n === 1 ? 'registro' : 'registros'}${total}.`
    : `Consta em "${t}"${quando.pt}: ${n} ${n === 1 ? 'lançamento' : 'lançamentos'}${total}.`;
}
function receipt(name, args, out) {
  if (name === 'consultar_evento') return trackerReadReceipt(out);
  if (TRACKER[name]) return trackerReceipt(name, out);
  const d = resultData(out);
  if (['editar_lembrete','cancelar_lembrete'].includes(name)) return {family:'reminder',tool:name,
    state:d?.ok===true && validId(d.id) && typeof d.canal==='string' ? (name==='editar_lembrete'?'updated':'deleted') : d?.ok===false ? 'failed' : 'unknown',
    id:d?.id,target:d?.canal,at:d?.quando_legivel || d?.quando,inFlight:d?.inFlight===true};
  if (['criar_lista','editar_lista'].includes(name)) return {family:'list',tool:name,subject:d?.lista?.nome || args?.lista || args?.nome || '',
    state:d?.ok===true && validId(d.lista?.id) && Number.isInteger(d.lista?.versao) ? 'saved' : d?.ok===false ? 'failed' : 'unknown',id:d?.lista?.id};
  const connector = connectorActionReceipt(name, args, d);
  if (connector) return typeof out === 'string' && out.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO')
    ? { ...connector, state: 'pending' } : connector;
  if (!NATIVE.has(name) && !MAIL.has(name)) return null;
  const base = { family: family(name), tool: name, state: 'unknown' };
  if (typeof out === 'string' && out.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO')) {
    return { ...base, state:'pending', target: clean(args?.to) };
  }
  // A reminder refused before being written carries the text as an object:
  // the finish() substitution rule only hides this failure when the SAME
  // reminder succeeded later in the turn. The text does not appear in the
  // conversation (reminder family).
  if (d?.ok === false || d?.skipped === true) return { ...base, state:'failed',
    ...(name === 'criar_lembrete' ? { subject: clean(String(args?.mensagem || '').trim()) } : {}) };
  if (NATIVE.has(name)) {
    // Native memory already persisted before returning these responses. An
    // idempotent duplicate is a stable success, not a reason to ask again.
    // Any other text still has no receipt and does not validate "salvei".
    if (name === 'memoria_anotar' || name === 'memoria_atualizar' || name === 'memoria_escrever') {
      const raw = typeof out === 'string' ? out : '';
      const page = clean(args?.pagina || args?.slug || 'perfil');
      if ((name === 'memoria_anotar' || name === 'memoria_atualizar') && /^Memória atualizada:/.test(raw)) {
        return { ...base, state:'saved', id:`memory:${page}` };
      }
      if (name === 'memoria_anotar' && /^Nada gravado \((?:add:duplicado(?:, )?)+\)\./.test(raw)) {
        return { ...base, state:'already_saved', id:`memory:${page}` };
      }
      if (name === 'memoria_atualizar' && /^Nada gravado \(definir:igual\)\.$/.test(raw)) {
        return { ...base, state:'already_saved', id:`memory:${page}` };
      }
      if (name === 'memoria_escrever' && /^Página "[^"]+" salva\.$/.test(raw)) {
        return { ...base, state:'saved', id:`memory:${page}` };
      }
      return base;
    }
    const e = d?.action_evidence;
    if (name === 'executar_rotina_agora' && e?.version === 1 && ['routine_blocked','unknown'].includes(e.state)
        && typeof e.detail === 'string' && e.detail.trim()) {
      return {...base,state:e.state,id:validId(e.id)?clean(e.id):null,detail:clean(e.detail, 1200)};
    }
    // Only known native adapters can emit this contract. A result coming
    // from a read, sub-agent or arbitrary connector does not count as a receipt.
    const states = name === 'criar_lembrete' ? ['scheduled']
      : name === 'enviar_sugestao_time' ? ['registered']
      : name === 'agendar_execucao_rotina' ? ['routine_scheduled']
      : name === 'executar_rotina_agora' ? ['routine_complete','routine_partial','routine_content_failed','routine_failed']
      : ['accepted'];
    if (e?.version === 1 && states.includes(e.state) && validId(e.id) && typeof e.target === 'string' && e.target.trim()) {
      return { ...base, state:e.state, id:clean(e.id), target:clean(e.target), at:clean(e.at), subject:clean(e.subject), delivery:clean(e.delivery) };
    }
    return base;
  }
  const id = name === 'gmail_create_draft' ? d?.draftId : d?.id;
  if (d?.ok === true && validId(id) && typeof args?.to === 'string' && args.to.trim()) return { ...base, state: name === 'gmail_create_draft' ? 'draft' : 'accepted', id:clean(id), target:clean(args?.to), subject:clean(args?.subject) };
  return base;
}

export function confirmedAction(name, args, out, language) {
  const e = receipt(name, args, out);
  return e ? renderAction(e, language) : null;
}
export const actionEvidenceFor = (name, args, out) => receipt(name, args, out);

export const ACTION_EVIDENCE_POLICY = `
ACTION CONFIRMATIONS: never infer success from the intent, the tool call, a confirmation request or the absence of an error. Use the actual result, including destination and state: scheduled != sent; draft != sent; accepted by the service != delivered/read. Tools with confirmation_ref provide a reference [[acao:N]]: put that reference alone on its own line, without rewriting or expanding the confirmation. The system renders the receipt. The reference, action_evidence and confirmation_ref are internal metadata: never show, explain or turn them into another syntax. Do not invent references. For other tools, only state what the result proves. Never repeat a mutation to produce proof. For past actions with no receipt available, say you cannot confirm right now; do not deny that they happened. In checklists, separate proven actions, user reports and items still to confirm; do not tick [x] based on the request of a routine, plan or example. Keep quotes, examples and drafts as such. The same applies to configuration changes (routine, alert, preference, integration): without a tool executed successfully in this reply, do not say "done", "removed", "turned off" or "adjusted" (in any language); say what can be done and how. The partial-search notices at the end of replies are appended by the platform and no tool removes them: if asked to remove one, explain this and offer a narrower search (sender/period) that finishes complete.
TIME EVIDENCE: a tool output in the history only proves the state at the turn in which it was obtained. Never say "I just checked", "I checked now" or equivalent (in any language) based on the history. A claim about the current state requires a call to the appropriate tool IN THIS turn. Earlier claims by the assistant itself are not evidence, and a current authoritative system rule prevails over them.
`;

// The brand name as it appears in the already-folded text (lowercase, no accents), ready for regex.
const marcaNoTexto = () => marca().nome.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Safety net restricted to the incident families, NOT a universal semantic
// classifier. The main confirmation is the typed reference above.
const ACTION_URL = /https?:\/\/[^\s<>()[\]"'`]+/g;
function ownActionClaim(t) {
  return new RegExp(String.raw`\b(?:cancelei|remarquei|registrei|registramos|enviei|enviamos|mandei|encaminhei|agendei|criei|anotei|guardei|salvei|memorizei)\b|\bpor\s+(?:mim|nos)\b|\b(?:pelo|pela|por)\s+(?:(?:meu|minha|nosso|nossa)\s+)?(?:assistente|${marcaNoTexto()})\b|\b(?:i|we)\s+(?:(?:have|just|already)\s+)*(?:sent|registered|scheduled|saved|stored|noted)\b`).test(t);
}
function reportedDocumentStatus(t) {
  // Reporting what a document says about a purchase is not confirming an
  // action of ours. Mentioning an email/link is not enough: there needs to
  // be explicit attribution to the source and an external object.
  // First-person claims still require a receipt, even inside a sentence with
  // that attribution.
  const prose = t.replace(/https?:\/\/\S+/g, ' ');
  if (ownActionClaim(prose)) return false;
  // The account or the subject can introduce the report: "Na conta de
  // trabalho, as mensagens dizem que...". The prefix does not accept another
  // sentence/claim.
  const report = prose.replace(/^(?:\W)*(?:(?:na|nas|no|nos)\s+(?:contas?|caixas?|consultas?|buscas?|conversas?|historico)\b[^,;.!?]{0,120}|(?:sobre|quanto a|em relacao a)\s+[^,;.!?]{1,120}),\s*/, '');
  const attributed = /^(?:\W)*(?:o|a|os|as)\s+(?:(?:ultim[oa]s?|primeir[oa]s?|nov[oa]s?|recentes?)\s+)?(?:e-?mails?|mensage(?:m|ns)|avisos?|comunicados?)\b[^.!?]*\b(?:diz(?:em)?|informa(?:m)?|registra(?:m)?|indica(?:m)?|mostra(?:m)?|confirma(?:m)?|relata(?:m)?|acrescenta(?:m)?)\s+que\b/.test(report)
    || /^(?:\W)*(?:segundo|conforme|de acordo com)\s+(?:o|a|os|as)\s+(?:e-?mails?|mensage(?:m|ns)|avisos?|comunicados?)\b/.test(report)
    || /^(?:\W)*(?:(?:na|nas|no|nos)\s+(?:duas|ambas|dois|ambos)(?:\s+(?:contas|caixas))?\s*,?\s+)?ha\s+(?:um(?:a)?\s+)?(?:e-?mails?|mensage(?:m|ns)|avisos?|comunicados?)\s+de\s+que\b/.test(report);
  return attributed && /\b(?:pedido|pacote|encomenda|mercadoria|compra|fatura|boleto|nota fiscal|reserva|voo|transportadora)\b/.test(prose);
}
function claimFamily(line, authenticatedEmailSources) {
  const fold = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'|`[^`\n]*`/g, ' ');
  const visible = fold(line.replace(ACTION_URL, ' '));
  const own = ownActionClaim(visible);
  // Source labels are not part of the reported action. But "Enviei [o
  // e-mail]" is still a claim of ours and keeps its object for the check.
  const t = own ? visible : fold(line.replace(/\[[^\]\n]*\]\(https?:\/\/[^\s)]+\)/g, ' ').replace(ACTION_URL, ' '));
  if (/^(?:\W)*(?:se\b|if\b|si\b|nao\b|not\b|no\b|voce\b|you\b|ela\b|ele\b)/.test(t)) return null;
  const citedObserved = (line.match(ACTION_URL) || []).some(url => authenticatedEmailSources.has(url.replace(/[.,;:!?]+$/, '')));
  // A findings line that cites an observed message reports the source's
  // state, even in a table/bullet without "o e-mail diz". This does not
  // validate our own actions, memory/reminder/list receipts, nor forwarding
  // to our support.
  const receiptContext = /\b(?:lista|list|checklist|memoria|memory|lembretes?|reminders?|recordatorios?|rascunho|draft|borrador)\b/.test(t)
    || new RegExp(String.raw`\b(?:ao|aos|para|pro|pros|to)\s+(?:(?:o|os|a|as|the)\s+)?(?:time|equipe|suporte|desenvolvimento|support|team|${marcaNoTexto()})\b`).test(t)
    || /^(?:\W)*(?:(?:o|a|the)\s+)?(?:e-?mail|mensagem|message|correo)\s+(?:(?:foi|was)\s+)?(?:enviad[oa]|sent)\b/.test(t);
  if (citedObserved && !own && !receiptContext) return null;
  if (!receiptContext && reportedDocumentStatus(t)) return null;
  const done = /\b(?:ja\s+)?(?:cancelei|cancelad[oa]s?|remarquei|remarcad[oa]s?|registrei|regist[r]?amos|enviei|enviamos|mandei|encaminhei|agendei|criei|anotei|guardei|salvei|memorizei|sent|registered|scheduled|saved|stored|noted|enviad[oa]s?|agendad[oa]s?|registrad[oa]s?|programad[oa]s?|salv[oa]s?|guardad[oa]s?|anotad[oa]s?)\b/.test(t);
  if (!done) return null;
  if (/\b(?:lista|list|checklist)\b/.test(t)) return 'list';
  if (/\b(?:bug|sugestao|pedido|demanda|time|equipe|desenvolvimento|support|team)\b/.test(t)) return 'support';
  if (/\b(?:anotei|guardei|salvei|memorizei|saved|stored|noted|memoria|memory|guardad[oa]s?|anotad[oa]s?)\b/.test(t)) return 'memory';
  if (/\b(?:lembretes?|avisos?|reminders?|recordatorios?)\b/.test(t)) return 'reminder';
  if (/\b(?:mensagem|whatsapp|telegram|email|e-mail|rascunho|message|draft|correo|borrador)\b/.test(t)) return 'message';
  return null;
}
// "Anotei" is this turn's action; "já está anotado" is state. Reading the
// record only proves the state: an "anotei" without registrar_evento still gets cut.
function actionNow(line) {
  const t = line.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return /\b(?:anotei|registrei|registramos|salvei|guardei|memorizei|criei|anote|guarde|registre)\b/.test(t)
    || /\bi(?:'ve| have)?\s+(?:just\s+)?(?:saved|noted|stored|recorded)\b/.test(t);
}
function reportedByUser(task, ownerText) {
  const norm = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const key = norm(task);
  if (key.length < 8) return false;
  // Only explicit reporting, never interpret "marque como feito" as a fact.
  return String(ownerText || '').split(/[\n.!?]/).some(s => /^(?:eu\s+)?(?:ja\s+)?(?:conclui|finalizei|fiz|enviei)\s+/.test(norm(s)) && norm(s).includes(key));
}
export function createActionJournal({ language = 'pt-BR', ownerText = '' } = {}) {
  const entries = [];
  let checkedItems = new Set();
  const itemKey = s => String(s || '').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[*_`]/g,'').replace(/\s+/g,' ').trim();
  const turnKey = randomUUID();
  let onDroppedClaim = null; // TEMPORARY: diagnosticoDosFiltros port
  const w = words[languageKey(language)];
  return {
    // Core calls AFTER execution, once, also on the salvage/interjection paths.
    toolResult(call, out) {
      if (['consultar_listas','criar_lista','editar_lista'].includes(call.name)) {
        const d=resultData(out);
        checkedItems=new Set(d?.ok===true && Array.isArray(d.lista?.itens) ? d.lista.itens.filter(i=>i.concluido===true).flatMap(i=>[itemKey(i.nome),itemKey(`${i.quantidade} ${i.unidade} ${i.nome}`)]) : []);
      }
      const e = receipt(call.name, call.args, out);
      if (!e) return out;
      e.ref = `${turnKey}:${entries.length + 1}`;
      entries.push(e);
      return JSON.stringify({ result:out, confirmation_ref:`[[acao:${e.ref}]]`, action_evidence:e, confirmation:renderAction(e, language) });
    },
    finish(text, { termination = null, authenticatedEmailSources = [], suppressRoutineMemoryReceipts = false, proposalShown = false } = {}) {
      // With the proposal card right below, the pending action is already
      // described in it: the model's text continues (it's the answer to the
      // rest of the message) and the "aguarda confirmação" receipt does not
      // repeat. A failure that the same turn redid successfully (same family
      // and object) also does not show up as "não foi concluída" next to the
      // success (msg 20508, 2026-09-28).
      const subjectKey = e => itemKey(e.subject);
      const shown = entries.filter((e, i) => !(proposalShown && e.state === 'pending')
        && !(e.state === 'failed' && subjectKey(e) && entries.slice(i + 1).some(l => l.family === e.family
          && subjectKey(l) === subjectKey(e) && !['unknown','failed','pending'].includes(l.state))));
      // Only the server enables this after validating the routine's exact
      // protocol. A coverage/error notice appended after validation prevents
      // silence. The evidence stays in entries for persistence and metrics.
      if (suppressRoutineMemoryReceipts === true && !proposalShown && (!termination || termination === 'completed') && !String(text || '').trim()) {
        const onlySavedMemory = entries.every(e => e.state === 'found' || e.family === 'memory'
          && ['memoria_anotar','memoria_atualizar','memoria_escrever'].includes(e.tool)
          && ['saved','already_saved'].includes(e.state));
        // Another receipt, including failure/uncertainty, needs to stay visible.
        return onlySavedMemory ? '' : renderActions(shown, language);
      }
      const observedEmailSources = new Set(authenticatedEmailSources);
      // If a mutation has a real receipt, that receipt is the useful answer.
      // Do not prepend an internal credit/reconciliation stop after the action
      // already succeeded (the reminder incident of 2026-09-14).
      // credit_reservation_unavailable likewise (case of 2026-09-24: "Não iniciei a chamada"
      // on top of an edited spreadsheet and memory saved in the same turn).
      const receiptDominates = ['credit_reconciliation_required','provider_failure','account_credit_reserved','credit_reservation_unavailable'].includes(termination)
        && shown.some(e => !['unknown','failed'].includes(e.state));
      // For routine execution/scheduling, the operational receipt is the
      // entire response. This way the model cannot reinterpret "conteúdo
      // falhou, entrega aceita" as "a entrega falhou", nor call a routine's
      // future execution a reminder.
      const routineReceipt = [...shown].reverse().find(e => ['routine_run','routine_schedule'].includes(e.family));
      if (routineReceipt) return renderActions(shown, language);
      // Pending connector does not count: the card covers the proposal and
      // the model's text is still the answer to whatever else was asked.
      if (shown.some(e => e.state !== 'pending' && connectorActionReceipt(e.tool, {}, null))) return renderActions(shown, language);
      const used = new Set();
      const shownLists = new Set();
      const renderOnce = es => renderActions(es.filter(e=>{
        if (e.family !== 'list' || e.state !== 'saved') return true;
        if (shownLists.has(e.id)) return false;
        shownLists.add(e.id); return true;
      }),language);
      let droppedClaim = false;
      const emit = es => {
        if(!es.length)return w.unknown;
        for(const e of es)used.add(e.ref);
        return renderOnce(es);
      };
      // A "já fiz" claim caught by the safety net WITHOUT ANY receipt from
      // the family: the platform REMOVES the claim. Swapping it for a loose
      // system sentence, with no referent, alarms the owner and leaks
      // plumbing (msg 18002, 2026-09-16). The invariant is just not
      // confirming what did not happen; speaking on the platform's behalf in
      // the middle of the response is not part of that. If the ENTIRE
      // response was the claim, the fallback below ensures the owner still
      // finds out, instead of getting silence.
      const emitOrDrop = es => {
        if(!es.length){ droppedClaim = true; return ''; }
        for(const e of es)used.add(e.ref);
        return renderOnce(es);
      };
      // A receipt already delivered in this response does not repeat: the
      // model tends to confirm at the beginning AND the end, and each claim
      // used to turn into a new receipt.
      const allUsed = es => es.length > 0 && es.every(e => used.has(e.ref));
      let afterReceipt = false;
      let fenced = false, draft = false;
      const verified = shown.some(e => !['unknown','failed'].includes(e.state));
      const legacyUnknown = /(?:Não tenho confirmação verificável (?:dessa|desta) ação(?: nesta resposta)?\.?)(?:\s*Não (?:vou repeti-la|a repeti) automaticamente\.?)?|(?:I have no verifiable confirmation of that action(?: in this reply)?\.?)(?:\s*I will not automatically repeat it\.?)?|(?:No tengo confirmación verificable de esa acción(?: en esta respuesta)?\.?)(?:\s*No la repetiré automáticamente\.?)?|(?:Não consegui confirmar essa ação agora,?\s*então não vou repeti-la automaticamente\.?)|(?:I could not confirm that action now,?\s*so I will not repeat it automatically\.?)|(?:No pude confirmar esa acción ahora,?\s*así que no la repetiré automáticamente\.?)/gi;
      const sourceText = String(receiptDominates ? '' : (text || '')).replace(verified ? w.unknown : /$^/, '').trim();
      const hadLegacyUnknown = legacyUnknown.test(sourceText);
      legacyUnknown.lastIndex = 0;
      const result = sourceText.split('\n').map(line => {
        if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; afterReceipt = false; return line; }
        if (fenced || /^\s*>/.test(line)) { afterReceipt = false; return line; }
        if (/^\s*(?:#{1,6}\s*)?(?:rascunho|modelo de mensagem|exemplo|draft|example|borrador)\s*:/i.test(line)) draft = true;
        if (draft && !line.trim()) { draft = false; return line; }
        if (draft) return line;
        // Slots always become receipt text; extra text on the same line
        // cannot use a receipt to validate a different action/recipient.
        const markerRe = /\[\[acao:([^\]\r\n]*)\]\]|\{\{acao:([^}\r\n]*)\}\}/g;
        const markerMatches = [...line.matchAll(markerRe)];
        if (markerMatches.length || /"?(?:confirmation_ref|action_evidence)"?\s*:/.test(line)) {
          const refs = markerMatches.map(m => m[1] || m[2]).filter(Boolean);
          const es = shown.filter(e => refs.includes(e.ref));
          if (allUsed(es) || (!es.length && refs.some(r => entries.some(e => e.ref === r)))) { afterReceipt = true; return ''; }
          // A slot that is not from this turn (the model copies it from an
          // old receipt in the history) comes out as an unproven claim: in
          // the middle of the response, the system sentence used to appear
          // on top of the confirmation card (2026-10-05).
          const out = emitOrDrop(es);
          afterReceipt = es.length > 0;
          return out;
        }
        // Legacy messages/markers are internal metadata. Outside of quotes,
        // examples and code blocks, they never reach the user.
        line = line.replace(legacyUnknown, '').trim();
        if (!line) return '';
        const checked = line.match(/^(\s*[-*+]\s*)\[[xX]\]\s*(.+)$/);
        if (checked) {
          afterReceipt = false;
          if (checkedItems.has(itemKey(checked[2]))) return line;
          const reported = reportedByUser(checked[2], ownerText);
          return `${checked[1]}[${reported ? 'x' : ' '}] ${checked[2]} — ${reported ? w.reported : w.check}.`;
        }
        return line.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÀÂÊÔÃÕ])/u).map(part => {
          // A piece of the receipt echoed by the model right after the real
          // receipt: it's a duplicate, not content. Gone.
          if (afterReceipt && RECEIPT_FIELD.test(part)) return '';
          const f = claimFamily(part, observedEmailSources);
          if (!f) { afterReceipt = false; return part; }
          // Never keeps the destination/object invented by the model:
          // replaces the ENTIRE claim with this family's receipts, or removes it.
          const es = shown.filter(e => (e.state !== 'found' || !actionNow(part))
            && (e.family === f || (f === 'memory' && ['list','tracker'].includes(e.family)) || (f === 'reminder' && e.tool === 'enviar_mensagem')));
          if (allUsed(es)) { afterReceipt = true; return ''; }
          if (!es.length) onDroppedClaim?.(part, f); // TEMPORARY: diagnosticoDosFiltros port
          const out = emitOrDrop(es);
          afterReceipt = es.length > 0;
          return out;
        }).filter(part => part.trim()).join(' ').trim();
      }).join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      // The model may omit the slot: the real action/pending request still shows up.
      // A successful first action must not hide a failed or uncertain later
      // step just because the model omits that receipt from its final answer.
      const hasCompletedStep = shown.some(e => !['unknown','failed','pending'].includes(e.state));
      // The registration receipt only confirms the "anotei"; the tool
      // already returns the saved phrase to the model, and appending it
      // after the response used to repeat the confirmation.
      const missing = shown.filter(e => !used.has(e.ref)
        && (hasCompletedStep || !['unknown','failed'].includes(e.state))
        && (e.family !== 'tracker' || (!result && e.state !== 'found')));
      const final = [result, missing.length ? emit(missing) : ''].filter(Boolean).join('\n\n');
      // Removing the claim can never turn into silence.
      // With a card below, the response is no longer silent.
      return final || (!proposalShown && (hadLegacyUnknown || droppedClaim) ? w.unknown : '');
    },
    get entries() { return entries.map(e => ({...e})); },
    observeDroppedClaims(fn) { onDroppedClaim = fn; }, // TEMPORARY: diagnosticoDosFiltros port
  };
}
