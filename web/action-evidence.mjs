import { randomUUID } from 'node:crypto';
import { marca } from './marca.mjs';
import { connectorActionReceipt } from './connector-action-evidence.mjs';
import { recurrenceLabel } from './calendar-recurrence.mjs';
// Recibos de ações são criados pelo código no limite de execução, nunca pelo
// modelo nem a partir de um simples tool_call. Sem rede, retries ou armazenamento.
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
// Rótulos impressos pelo próprio recibo. O modelo às vezes ecoa o recibo
// inteiro no texto dele; quando a afirmação inicial é trocada pelo recibo de
// verdade (que já traz esses campos), os ecos seguintes ficam órfãos e o
// destino/horário aparece duplicado (msg 18000, 16/09/2026).
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
  // O texto de um lembrete pode ser a mensagem futura inteira. Ele e o ID de
  // armazenamento continuam no recibo tipado/log para prova e suporte, mas não
  // pertencem à conversa. A confirmação visível precisa ser curta e humana.
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
// Registros contáveis (web/trackers.mjs): só a frase de sucesso da tool prova a
// gravação. Pergunta, ambiguidade e erro não viram recibo, e o "anotei" do
// modelo nesses casos continua sem prova. Sem isto, o "anotei" de um
// registrar_evento que gravou de verdade saía da resposta e, quando era a
// resposta inteira, virava "Não consegui confirmar isso agora" (caso 05/10/2026).
const TRACKER = {
  registrar_evento: [/^Registrado em "(.+)": (\d{4}-\d{2}-\d{2})(?: valor (-?\d+(?:\.\d+)?))?/, m => ({ state:'recorded', subject:m[1], at:m[2], value:m[3] })],
  remover_evento: [/^Removi (\d+) lançamentos? de "(.+)" em (\d{4}-\d{2}-\d{2})\.$/, m => ({ state:'removed', subject:m[2], at:m[3], value:m[1] })],
  remover_tracker: [/^Parei de acompanhar "(.+)" \(/, m => ({ state:'stopped', subject:m[1] })],
};
// A consulta também prova, mas só o estado que leu: "já está anotado" depois
// do consultar_evento era cortado como "fiz sem prova" e o fato lido no banco
// sumia da resposta (msg 8494, 05/10/2026). Erro e "não achei" seguem sem recibo.
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
  // Lembrete recusado antes de gravar leva o texto como objeto: a regra de
  // substituição do finish() só esconde esta falha quando o MESMO lembrete deu
  // certo depois no turno. O texto não aparece na conversa (família reminder).
  if (d?.ok === false || d?.skipped === true) return { ...base, state:'failed',
    ...(name === 'criar_lembrete' ? { subject: clean(String(args?.mensagem || '').trim()) } : {}) };
  if (NATIVE.has(name)) {
    // A memória nativa já persistiu antes de devolver estas respostas. Um
    // duplicado idempotente é sucesso estável, não motivo para perguntar de
    // novo. Qualquer outro texto continua sem recibo e não valida "salvei".
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
    // Só adaptadores nativos conhecidos podem emitir este contrato. Resultado
    // vindo de leitura, subagente ou conector arbitrário não serve como recibo.
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
CONFIRMAÇÕES DE AÇÃO: nunca derive sucesso da intenção, chamada de tool, pedido de confirmação ou ausência de erro. Use o resultado real, incluindo destino e estado: agendado != enviado; rascunho != envio; aceito pelo serviço != entregue/lido. Tools com confirmation_ref fornecem uma referência [[acao:N]]: use essa referência sozinha em uma linha, sem reescrever ou ampliar a confirmação. O sistema renderiza o recibo. A referência, action_evidence e confirmation_ref são metadados internos: nunca os mostre, explique ou transforme em outra sintaxe. Não invente referências. Para outras tools, só afirme o que o resultado comprova. Nunca repita uma mutação para produzir prova. Para ações antigas sem recibo disponível, diga que não consegue confirmar agora; não negue que tenham acontecido. Em checklists, distinga ações comprovadas, relatos do usuário e itens a confirmar; não marque [x] com base no pedido de uma rotina, plano ou exemplo. Preserve citações, exemplos e rascunhos como tais. O mesmo vale para mudanças de configuração (rotina, aviso, preferência, integração): sem uma tool executada com sucesso nesta resposta, não diga "feito", "removi", "desativei" ou "ajustei"; diga o que dá pra fazer e como. Os avisos de busca parcial no fim das respostas são anexados pela plataforma e nenhuma tool os remove: se pedirem pra tirar, explique e ofereça uma busca mais fechada (remetente/período) que termine completa.
EVIDÊNCIA TEMPORAL: uma saída de tool presente no histórico comprova apenas o estado no turno em que foi obtida. Nunca diga "verifiquei agora", "consultei agora" ou equivalente com base no histórico. Uma afirmação de estado atual exige uma chamada da tool apropriada NESTE turno. Afirmações antigas do próprio assistente não são evidência e uma regra autoritativa atual do sistema prevalece sobre elas.
`;

// O nome da marca como fica no texto já dobrado (minúsculo, sem acento), pronto pra regex.
const marcaNoTexto = () => marca().nome.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Rede de segurança restrita às famílias do incidente, NÃO um classificador
// semântico universal. A confirmação principal é a referência tipada acima.
const ACTION_URL = /https?:\/\/[^\s<>()[\]"'`]+/g;
function ownActionClaim(t) {
  return new RegExp(String.raw`\b(?:cancelei|remarquei|registrei|registramos|enviei|enviamos|mandei|encaminhei|agendei|criei|anotei|guardei|salvei|memorizei)\b|\bpor\s+(?:mim|nos)\b|\b(?:pelo|pela|por)\s+(?:(?:meu|minha|nosso|nossa)\s+)?(?:assistente|${marcaNoTexto()})\b|\b(?:i|we)\s+(?:(?:have|just|already)\s+)*(?:sent|registered|scheduled|saved|stored|noted)\b`).test(t);
}
function reportedDocumentStatus(t) {
  // Relatar o que um documento diz sobre uma compra não é confirmar uma ação
  // nossa. Não basta mencionar e-mail/link: precisa haver atribuição explícita
  // à fonte e um objeto externo. Afirmações em primeira pessoa continuam a
  // exigir recibo, mesmo dentro de uma frase com essa atribuição.
  const prose = t.replace(/https?:\/\/\S+/g, ' ');
  if (ownActionClaim(prose)) return false;
  // A conta ou o assunto podem introduzir o relato: "Na conta de trabalho,
  // as mensagens dizem que...". O prefixo não aceita outra frase/afirmação.
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
  // Rótulos de fontes não são parte da ação relatada. Mas "Enviei [o e-mail]"
  // continua sendo uma afirmação nossa e conserva seu objeto para a checagem.
  const t = own ? visible : fold(line.replace(/\[[^\]\n]*\]\(https?:\/\/[^\s)]+\)/g, ' ').replace(ACTION_URL, ' '));
  if (/^(?:\W)*(?:se\b|if\b|si\b|nao\b|not\b|no\b|voce\b|you\b|ela\b|ele\b)/.test(t)) return null;
  const citedObserved = (line.match(ACTION_URL) || []).some(url => authenticatedEmailSources.has(url.replace(/[.,;:!?]+$/, '')));
  // Uma linha de achados que cita mensagem observada relata estado da fonte,
  // mesmo em tabela/bullet sem "o e-mail diz". Isso não valida ações próprias,
  // recibos de memória/lembrete/lista nem encaminhamento ao nosso suporte.
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
// "Anotei" é ação deste turno; "já está anotado" é estado. A leitura do
// registro só prova o estado: um "anotei" sem registrar_evento continua cortado.
function actionNow(line) {
  const t = line.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return /\b(?:anotei|registrei|registramos|salvei|guardei|memorizei|criei|anote|guarde|registre)\b/.test(t)
    || /\bi(?:'ve| have)?\s+(?:just\s+)?(?:saved|noted|stored|recorded)\b/.test(t);
}
function reportedByUser(task, ownerText) {
  const norm = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const key = norm(task);
  if (key.length < 8) return false;
  // Somente relato explícito, nunca interpretar "marque como feito" como fato.
  return String(ownerText || '').split(/[\n.!?]/).some(s => /^(?:eu\s+)?(?:ja\s+)?(?:conclui|finalizei|fiz|enviei)\s+/.test(norm(s)) && norm(s).includes(key));
}
export function createActionJournal({ language = 'pt-BR', ownerText = '' } = {}) {
  const entries = [];
  let checkedItems = new Set();
  const itemKey = s => String(s || '').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[*_`]/g,'').replace(/\s+/g,' ').trim();
  const turnKey = randomUUID();
  let onDroppedClaim = null; // TEMPORÁRIO: porta diagnosticoDosFiltros
  const w = words[languageKey(language)];
  return {
    // Core chama APÓS execução, uma vez, também nos caminhos salvage/interjeição.
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
      // Com o cartão da proposta logo abaixo, a ação pendente já está descrita
      // nele: o texto do modelo segue (é a resposta ao resto da mensagem) e o
      // recibo "aguarda confirmação" não se repete. Uma falha que o próprio
      // turno refez com sucesso (mesma família e objeto) também não aparece
      // como "não foi concluída" ao lado do sucesso (msg 20508, 28/09/2026).
      const subjectKey = e => itemKey(e.subject);
      const shown = entries.filter((e, i) => !(proposalShown && e.state === 'pending')
        && !(e.state === 'failed' && subjectKey(e) && entries.slice(i + 1).some(l => l.family === e.family
          && subjectKey(l) === subjectKey(e) && !['unknown','failed','pending'].includes(l.state))));
      // Só o servidor habilita isto após validar o protocolo exato da rotina.
      // Um aviso de cobertura/erro anexado depois da validação impede silêncio.
      // As evidências permanecem em entries para persistência e métricas.
      if (suppressRoutineMemoryReceipts === true && !proposalShown && (!termination || termination === 'completed') && !String(text || '').trim()) {
        const onlySavedMemory = entries.every(e => e.state === 'found' || e.family === 'memory'
          && ['memoria_anotar','memoria_atualizar','memoria_escrever'].includes(e.tool)
          && ['saved','already_saved'].includes(e.state));
        // Outro recibo, inclusive falha/incerteza, precisa continuar visível.
        return onlySavedMemory ? '' : renderActions(shown, language);
      }
      const observedEmailSources = new Set(authenticatedEmailSources);
      // If a mutation has a real receipt, that receipt is the useful answer.
      // Do not prepend an internal credit/reconciliation stop after the action
      // already succeeded (the reminder incident of 14/09/2026).
      // credit_reservation_unavailable idem (caso de 24/09: "Não iniciei a chamada"
      // em cima de uma planilha editada e memória salva no mesmo turno).
      const receiptDominates = ['credit_reconciliation_required','provider_failure','account_credit_reserved','credit_reservation_unavailable'].includes(termination)
        && shown.some(e => !['unknown','failed'].includes(e.state));
      // Para execução/agendamento de rotina, o recibo operacional é a resposta
      // inteira. Assim o modelo não consegue reinterpretar "conteúdo falhou,
      // entrega aceita" como "a entrega falhou", nem chamar um lembrete de
      // execução futura da rotina.
      const routineReceipt = [...shown].reverse().find(e => ['routine_run','routine_schedule'].includes(e.family));
      if (routineReceipt) return renderActions(shown, language);
      // Conector pendente não conta: o cartão cobre a proposta e o texto do
      // modelo continua sendo a resposta ao que mais foi pedido.
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
      // Afirmação de "já fiz" pega pela rede de segurança SEM NENHUM recibo da
      // família: a plataforma REMOVE a afirmação. Trocá-la por uma frase de
      // sistema solta, sem referente, alarma o dono e vaza encanamento
      // (msg 18002, 16/09/2026). O invariante é só não confirmar o que não
      // aconteceu; falar em nome da plataforma no meio da resposta não é parte
      // disso. Se a resposta INTEIRA era a afirmação, o fallback abaixo garante
      // que o dono ainda fique sabendo, em vez de receber silêncio.
      const emitOrDrop = es => {
        if(!es.length){ droppedClaim = true; return ''; }
        for(const e of es)used.add(e.ref);
        return renderOnce(es);
      };
      // Recibo já entregue nesta resposta não se repete: o modelo costuma
      // confirmar no começo E no fim, e cada afirmação virava um recibo novo.
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
        // Slots sempre viram texto do recibo; texto adicional na mesma linha não
        // pode usar um recibo para validar outra ação/destinatário.
        const markerRe = /\[\[acao:([^\]\r\n]*)\]\]|\{\{acao:([^}\r\n]*)\}\}/g;
        const markerMatches = [...line.matchAll(markerRe)];
        if (markerMatches.length || /"?(?:confirmation_ref|action_evidence)"?\s*:/.test(line)) {
          const refs = markerMatches.map(m => m[1] || m[2]).filter(Boolean);
          const es = shown.filter(e => refs.includes(e.ref));
          if (allUsed(es) || (!es.length && refs.some(r => entries.some(e => e.ref === r)))) { afterReceipt = true; return ''; }
          // Slot que não é deste turno (o modelo copia o de um recibo antigo do
          // histórico) sai como afirmação sem prova: no meio da resposta, a frase
          // de sistema aparecia em cima do cartão de confirmação (05/10/2026).
          const out = emitOrDrop(es);
          afterReceipt = es.length > 0;
          return out;
        }
        // Mensagens/markers legados são metadado interno. Fora de citações,
        // exemplos e blocos de código, nunca chegam ao usuário.
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
          // Pedaço do recibo ecoado pelo modelo logo após o recibo real:
          // é duplicata, não conteúdo. Some.
          if (afterReceipt && RECEIPT_FIELD.test(part)) return '';
          const f = claimFamily(part, observedEmailSources);
          if (!f) { afterReceipt = false; return part; }
          // Nunca conserva o destino/objeto inventado pelo modelo: substitui a
          // afirmação INTEIRA pelos recibos desta família, ou a remove.
          const es = shown.filter(e => (e.state !== 'found' || !actionNow(part))
            && (e.family === f || (f === 'memory' && ['list','tracker'].includes(e.family)) || (f === 'reminder' && e.tool === 'enviar_mensagem')));
          if (allUsed(es)) { afterReceipt = true; return ''; }
          if (!es.length) onDroppedClaim?.(part, f); // TEMPORÁRIO: porta diagnosticoDosFiltros
          const out = emitOrDrop(es);
          afterReceipt = es.length > 0;
          return out;
        }).filter(part => part.trim()).join(' ').trim();
      }).join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      // O modelo pode omitir o slot: a ação real/pedido pendente ainda aparece.
      // A successful first action must not hide a failed or uncertain later
      // step just because the model omits that receipt from its final answer.
      const hasCompletedStep = shown.some(e => !['unknown','failed','pending'].includes(e.state));
      // O recibo de registro só confirma o "anotei"; a tool já devolve ao modelo a
      // frase do que gravou, e anexá-lo depois da resposta repetia a confirmação.
      const missing = shown.filter(e => !used.has(e.ref)
        && (hasCompletedStep || !['unknown','failed'].includes(e.state))
        && (e.family !== 'tracker' || (!result && e.state !== 'found')));
      const final = [result, missing.length ? emit(missing) : ''].filter(Boolean).join('\n\n');
      // Remover a afirmação nunca pode virar silêncio.
      // Com cartão abaixo, a resposta já não fica em silêncio.
      return final || (!proposalShown && (hadLegacyUnknown || droppedClaim) ? w.unknown : '');
    },
    get entries() { return entries.map(e => ({...e})); },
    observeDroppedClaims(fn) { onDroppedClaim = fn; }, // TEMPORÁRIO: porta diagnosticoDosFiltros
  };
}
