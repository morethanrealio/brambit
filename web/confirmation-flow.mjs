import { gateTool, isConfirmation, confirmsPending, isReactionConfirmable, userSaid,
  confirmacaoComRessalva, setOwnerText, setThreadLanguage, renderConfirmed } from './confirm.mjs';
import { confirmationFingerprint, validConfirmationReference } from './confirmation-store.mjs';
import { standaloneRefusal } from './turn-claim-guard.mjs';
import { actionEvidenceFor } from './action-evidence.mjs';
import { tagIdioma } from './locale.mjs';

// Texts the OWNER reads in this flow. They come out in the language recorded in
// the request itself (row.language, the same one that already picks the card's
// "May I proceed?"), otherwise an English "cancel" got back "Cancelei a ação
// de..." in Portuguese.
const TEXTOS = {
  'pt-BR': {
    none: 'Não há nenhuma ação aguardando confirmação.',
    onePending: 'Esta é a ação que está pendente:',
    whichOne: 'Qual dessas ações você quer confirmar, alterar ou cancelar? Pode indicar pelo nome ou horário.',
    unknown: 'Não consegui identificar a ação. Qual destas você quis dizer?',
    unseen: 'Confira primeiro os detalhes e me diga se posso seguir.',
    recovered: 'Recuperei este pedido. Confira os detalhes e confirme pelo número.',
    textOnlyOne: 'Essa ação exige confirmação por texto. Responda ao pedido indicando que confirma.',
    textOnlyMany: 'Para essas ações, preciso da sua confirmação por texto.',
    canceledOne: l => `Cancelei a ação de ${l}.`,
    canceledMany: n => `Cancelei essas ${n} ações.`,
    groupNotStarted: l => `Não iniciei essas ações: não consegui revalidar os detalhes de ${l}. Vou precisar conferir esse item antes de continuar.`,
    groupUncertain: l => `Não consegui confirmar o resultado de ${l}. Não vou repetir essa ação automaticamente.`,
    notExecuted: l => `Não executei a ação de ${l}: não consegui revalidar os mesmos detalhes e permissões. Precisamos conferir os detalhes novamente.`,
    uncertain: l => `O resultado de ${l} não pôde ser confirmado. Não vou executar novamente automaticamente; confira o serviço antes de pedir outra tentativa.`,
    terminal: (l, st) => `A ação de ${l} está ${st}.`,
    status: { canceled: 'cancelada', superseded: 'substituída por uma nova proposta', expired: 'expirada',
      invalidated: 'invalidada porque seus dados ou permissões mudaram', executing: 'em execução; aguarde o resultado',
      uncertain: 'com resultado incerto; confira o que aconteceu antes de pedir nova execução', other: 'encerrada' },
  },
  en: {
    none: 'There is no action waiting for confirmation.',
    onePending: 'This is the pending action:',
    whichOne: 'Which of these actions do you want to confirm, change or cancel? You can point to it by name or time.',
    unknown: 'I could not tell which action you meant. Which of these is it?',
    unseen: 'Please check the details first and tell me if I may proceed.',
    recovered: 'I recovered this request. Check the details and confirm it by its number.',
    textOnlyOne: 'This action needs a written confirmation. Reply to the request saying you confirm.',
    textOnlyMany: 'For these actions I need your confirmation in writing.',
    canceledOne: l => `I canceled the action: ${l}.`,
    canceledMany: n => `I canceled these ${n} actions.`,
    groupNotStarted: l => `I did not start these actions: I could not revalidate the details of ${l}. I need to check that item before going on.`,
    groupUncertain: l => `I could not confirm the result of ${l}. I will not repeat this action automatically.`,
    notExecuted: l => `I did not run the action ${l}: I could not revalidate the same details and permissions. We need to check the details again.`,
    uncertain: l => `The result of ${l} could not be confirmed. I will not run it again automatically; please check the service before asking for another try.`,
    terminal: (l, st) => `The action ${l} is ${st}.`,
    status: { canceled: 'canceled', superseded: 'replaced by a new proposal', expired: 'expired',
      invalidated: 'invalidated because its data or permissions changed', executing: 'running; please wait for the result',
      uncertain: 'with an uncertain result; check what happened before asking to run it again', other: 'closed' },
  },
  es: {
    none: 'No hay ninguna acción esperando confirmación.',
    onePending: 'Esta es la acción pendiente:',
    whichOne: '¿Cuál de estas acciones quieres confirmar, cambiar o cancelar? Puedes indicarla por el nombre o la hora.',
    unknown: 'No pude identificar la acción. ¿Cuál de estas quisiste decir?',
    unseen: 'Revisa primero los detalles y dime si puedo seguir.',
    recovered: 'Recuperé esta solicitud. Revisa los detalles y confírmala por su número.',
    textOnlyOne: 'Esta acción necesita confirmación por escrito. Responde a la solicitud diciendo que confirmas.',
    textOnlyMany: 'Para estas acciones necesito tu confirmación por escrito.',
    canceledOne: l => `Cancelé la acción: ${l}.`,
    canceledMany: n => `Cancelé estas ${n} acciones.`,
    groupNotStarted: l => `No inicié estas acciones: no pude volver a validar los detalles de ${l}. Tengo que revisar ese punto antes de seguir.`,
    groupUncertain: l => `No pude confirmar el resultado de ${l}. No voy a repetir esta acción automáticamente.`,
    notExecuted: l => `No ejecuté la acción ${l}: no pude volver a validar los mismos detalles y permisos. Tenemos que revisar los detalles de nuevo.`,
    uncertain: l => `No se pudo confirmar el resultado de ${l}. No lo voy a ejecutar de nuevo automáticamente; revisa el servicio antes de pedir otro intento.`,
    terminal: (l, st) => `La acción ${l} está ${st}.`,
    status: { canceled: 'cancelada', superseded: 'sustituida por una nueva propuesta', expired: 'vencida',
      invalidated: 'invalidada porque sus datos o permisos cambiaron', executing: 'en ejecución; espera el resultado',
      uncertain: 'con resultado incierto; revisa qué pasó antes de pedir que se ejecute de nuevo', other: 'cerrada' },
  },
};
export const textosConfirmacao = lang => TEXTOS[tagIdioma(lang)] || TEXTOS['pt-BR'];
const txRows = rows => textosConfirmacao(rows?.find(r => r?.language)?.language);

const numberPattern = /\b(?:pedido|request|solicitud)\s*#?\s*(\d+)\b/giu;
const folded = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const amendment = text => !text.trim().endsWith('?') && (confirmacaoComRessalva(text) || /^(?:(?:nao|no)[, ]+)?(?:por favor[, ]+)?(?:altera|altere|alterar|muda|mude|mudar|troca|troque|trocar|ajusta|ajuste|ajustar|corrige|corrij[ae]|corrigir|change|edit|modify|cambia|cambie|modifica)\b/.test(folded(text)));
const refusalEnEs = text => /^(?:no[, ]+)?(?:never ?mind|forget it|don'?t|do not|don'?t do (?:it|that)|do not do (?:it|that)|no thanks|no thank you|not now|hold off|no lo hagas|no hace falta|mejor no|olvidalo|cancelalo|dejalo|no gracias|ahora no|todavia no)(?:[, ]+(?:thanks|gracias))?[.! ]*$/.test(folded(String(text).trim()).replace(/[’]/g, "'"));
const cancellation = text => standaloneRefusal(text) || refusalEnEs(text) || /^(?:por favor[, ]+)?(?:cancele?|cancelar|cancela|cancel|stop|cancela|cancele)(?:\s+(?:esse|este|o|this|the|esta|la|el))?[.! ]*$/i.test(folded(text));

export function proposalCard(row) {
  const lang = row.language;
  const question = lang === 'en' ? 'May I proceed?' : lang === 'es' ? '¿Puedo seguir?' : 'Posso seguir?';
  const reaction = isReactionConfirmable(row.name) ? ' 👍' : '';
  if (/\?\s*(?:👍)?\s*$/.test(row.confirmationText)) return row.confirmationText;
  return `${row.confirmationText}\n\n${question}${reaction}`;
}

// Exact prepared details remain the authority; prose and internal request IDs
// are not a language the person needs to learn.
export function proposalPresentation(rows) {
  if (!rows.length) return '';
  if (rows.length === 1) return proposalCard(rows[0]);
  const lang = rows[0].language;
  const question = lang === 'en' ? 'May I proceed with these actions?'
    : lang === 'es' ? '¿Puedo realizar estas acciones?' : 'Posso realizar essas ações?';
  return `${rows.map(r => `• ${r.confirmationText}`).join('\n\n')}\n\n${question}`;
}
export function confirmationTargetsInMessage(rows, text) {
  const value = String(text || '');
  const candidates = rows.filter(r => r.confirmationText && value.includes(r.confirmationText));
  if (candidates.length > 1 && value.includes(proposalPresentation(candidates))) return candidates.map(r => r.id);
  const cards = rows.filter(r => value.includes(proposalCard(r)));
  // Identical visible text cannot prove which immutable payload was shown.
  if (new Set(cards.map(proposalCard)).size !== cards.length) return [];
  return cards.map(r => r.id);
}
export function proposalList(rows, prefix, lang) {
  const t = lang ? textosConfirmacao(lang) : txRows(rows);
  if (!rows.length) return {text:t.none,attachments:[],proposalIds:[]};
  const lead = prefix || (rows.length === 1 ? t.onePending : t.whichOne);
  return { text: `${lead}\n\n${proposalPresentation(rows)}`, attachments: [], proposalIds: rows.map(r => r.id) };
}

const displayedRows = (rows, ids) => ids.map(id => rows.find(r => r.id === id)).filter(Boolean);
const sameRequest = rows => rows.length > 1 && !!rows[0].source?.ownerText
  && rows.every(r => r.source?.ownerText === rows[0].source.ownerText);
// "realizar", "executar" and "ser" are included because the card itself asks
// "Posso realizar essas ações?": "pode realizar sim" turned into "which ones?"
// (case from 2026-10-03).
const consentAtom = '(?:pode(?: sim| seguir| fazer| criar| enviar| mandar| realizar| executar| prosseguir| ser)?|sim|confirma|confirme|confirmar|confirmo|confirmado|autorizo|aprovo|aprovado|ok(?:ay)?|claro|beleza|blz|bora|manda|envia|envie|isso(?: mesmo)?|ta certo|esta certo|exactly|correct|that[\'’]?s (?:right|correct)|exacto|correct[oa]|eso(?: es)?|asi es|go ahead|yes(?: please)?|sure|confirm|approve|si|adelante|dale|perfecto|(?:yes|yeah|yep|ok)?[, ]*(?:do it|send it|go ahead|please do|proceed)|yeah|yep|yup|confirmed|sounds good|looks good|de acuerdo|esta bien|me parece bien|vale|(?:si|yes)[, ]+(?:por favor|please)|puede(?:s)?(?: hacerlo| seguir| continuar| hacer| crear| guardar| enviar| realizar| proceder)?)';
// "Ok, pode seguir." and "isso, pode fazer" are the same yes as "pode": up to
// three pure-consent terms in a row, nothing beyond them.
const plainConsentPattern = new RegExp(`^${consentAtom}(?:[, ]+${consentAtom}){0,2}[.! ]*$`);
const plainConsent = text => plainConsentPattern.test(folded(text).trim())
  || esConsent(text);
// Spanish imperative with an attached pronoun only counts WITH an accent, same as
// confirm.mjs's STRONG_ES: without the accent "mandalo"/"envialo" is the crooked
// spelling of Portuguese's "mandá-lo"/"enviá-lo". That's why this part looks at
// the original text, not the duplicated one.
const esConsent = text => /^(?:s[íi][, ]+)?(?:hazlo|házlo|hágalo|envíalo|mándalo|publícalo|súbelo|créalo)(?:[, ]+por favor)?[.! ]*$/iu.test(String(text).trim());
const naturalApproval = text => /^(?:por favor[, ]+)?(?:confirmo|confirma|confirme|confirmar|autorizo|aprovo|pode|sim|ok|yes|confirm|approve|go ahead|si|adelante)\b/.test(folded(text))
  && !/\b(?:se|if|caso|quando|when|menos|exceto|except|unless|talvez|maybe)\b/.test(folded(text));
const QUANT = '(?:os dois|as duas|ambos|ambas|todos|todas|both|all|los dos|las dos)';
const quantPattern = new RegExp(`\\b(?:as |os )?${QUANT}(?: (?:as |os )?(?:acoes|coisas|actions|acciones))?\\b`);
// Linking verb attached to the quantifier: "do both", "go ahead with both", "haz las dos".
const quantWithLink = new RegExp(`(?:\\b(?:do|with|haz|con)\\s+)?${quantPattern.source}`);
// "as duas"/"todas" plus a pure yes, in any order: "pode ser as duas",
// "sim, as duas", "confirmo os dois". Any other word ("menos o B", "sem
// convidados", "se der") still stays out, because the rest has to be a pure yes.
const allConsent = text => {
  const clean = folded(text).trim();
  if (!quantPattern.test(clean)) return false;
  const rest = clean.replace(quantWithLink, ' ').replace(/\b(?:por favor|please)\b/g, ' ').replace(/^[, ]+|[, ]+(?=[.! ]*$)/g, '').trim();
  return !rest.replace(/[.! ]/g, '') || plainConsent(rest);
};
// Reply with only the quantifier ("as duas", "ambas") to the card that asks
// "Posso realizar essas ações?".
const bareAll = text => new RegExp(`^${quantPattern.source}[.! ]*$`).test(folded(text).trim());

// The person points at the action by the beginning of the CARD ITSELF, which is
// platform text: "pode criar a rotina", "salvar o arquivo". The rest of the
// sentence has to be just yes/filler; any word outside the card breaks the
// match, so a new condition ("a rotina às 8h") never approves the old request.
const phraseLead = /^(?:(?:agora|entao|ok|okay|beleza|tambem|e|por favor|pode|sim|isso|confirmo|confirma|confirme|autorizo|aprovo|yes|yeah|yep|sure|please|go ahead and|and|then|now|also|si|vale|dale|adelante|y|ahora|puedes|puede)\s+)*/;
const phraseWords = text => folded(String(text || '')).replace(/["“”'‘’,:;.!]/g, ' ').replace(/\s+/g, ' ').trim();
function phraseSelection(rows, text) {
  const said = String(text || '').trim();
  if (!said || said.endsWith('?')) return null;
  const whole = phraseWords(said);
  const lead = whole.match(phraseLead)[0];
  const words = whole.slice(lead.length).split(' ').filter(Boolean);
  if (words.length < 2) return null;
  const found = rows.filter(row => {
    const card = phraseWords(row.confirmationText).split(' ');
    return card.length >= words.length
      && words.every((w, i) => w === card[i] || (i === 0 && card[0] === `${w}r`));
  });
  if (!found.length) return null;
  return { rows: found, consent: /\b(?:pode|sim|isso|ok|okay|beleza|confirmo|confirma|confirme|autorizo|aprovo|yes|yeah|yep|sure|please|go ahead|si|vale|dale|adelante|puedes|puede)\b/.test(lead), bare: !lead.trim() };
}
function approvalOfTargets(text, rows) {
  if (!naturalApproval(text)) return false;
  let rest = folded(text);
  for (const row of rows) {
    const title = proposalTitle(row);
    if (title) rest = rest.replace(folded(String(title)), '');
    if (title && / [a-z]$/.test(folded(String(title)))) rest = rest.replace(new RegExp(`\\b(?:o|evento|teste) ${folded(String(title)).slice(-1)}\\b`),'');
  }
  const times = [...rest.matchAll(/\b(\d{1,2})(?:h(?:(\d{2}))?|:(\d{2}))\b/g)]
    .map(m => `${m[1].padStart(2,'0')}:${m[2] || m[3] || '00'}`);
  const approvedTimes = rows.flatMap(row => [row.args?.start || row.args?.inicio || row.binding?.event?.start?.dateTime,
    row.args?.end || row.args?.fim || row.binding?.event?.end?.dateTime].filter(Boolean).map(value => String(value).slice(11,16)));
  if (times.some(time => !approvedTimes.includes(time))) return false;
  rest = rest.replace(/\b\d{1,2}(?:h(?:\d{2})?|:\d{2})\b/g,'')
    .replace(/\b(?:primeir[oa]|segund[oa]|terceir[oa]|first|second|third)\b/g,'')
    .replace(/\b(?:apenas|so|somente|o|a|as|das|dos|de|evento|teste|por favor)\b/g,'')
    .replace(/["“”'‘’,]/g,'').replace(/\s+/g,' ').trim();
  return plainConsent(rest) || /^(?:confirma|confirme)[.! ]*$/.test(rest)
    || /^(?:confirmo|confirma|confirmar|confirm|approve)(?: apenas| so)?\s+(?:o |a )?\d+[.! ]*$/.test(folded(text));
}
const proposalTitle = row => row.args?.title || row.args?.summary || row.args?.titulo || row.args?.nome || row.args?.name || row.args?.subject || row.binding?.event?.summary;
function naturalTargets(rows, text, positions = true) {
  const clean = folded(text);
  const titled = rows.filter(row => {
    const title = proposalTitle(row);
    if (!title || String(title).length < 3) return false;
    const subject = folded(String(title));
    return clean.includes(subject)
      || (/\b(?:evento|teste)\b/.test(subject) && / [a-z]$/.test(subject)
        && new RegExp(`\\b(?:o|evento|teste) ${subject.slice(-1)}\\b`).test(clean));
  });
  if (titled.length) return titled;
  const time = clean.match(/\b(?:d[oa]s? |as? )?(\d{1,2})(?:h(?:(\d{2}))?|:(\d{2}))\b/);
  if (time) {
    const hm = `${time[1].padStart(2,'0')}:${time[2] || time[3] || '00'}`;
    return rows.filter(r => String(r.args?.start || r.args?.inicio || '').slice(11,16) === hm);
  }
  if (!positions) return [];
  const position = clean.match(/\b(primeir[oa]|segund[oa]|terceir[oa]|first|second|third)\b/);
  if (position) {
    const index = /^(primeir|first)/.test(position[1]) ? 0 : /^(segund|second)/.test(position[1]) ? 1 : 2;
    return rows[index] ? [rows[index]] : [];
  }
  const numeric = clean.match(/^(?:confirmo|confirma|confirmar|confirm|approve|cancela|cancele|cancel)(?: apenas| so)?\s+(?:o |a )?(\d+)[.! ]*$/);
  return numeric && rows[Number(numeric[1])-1] ? [rows[Number(numeric[1])-1]] : [];
}

// Only owner text and authenticated transport metadata can authorize a set.
// A previous assistant message establishes the visible scope, never a model ID.
export function selectConfirmation(rows, message, target, viaReaction = false, inputId = null, implicitId = null, implicitIds = []) {
  const said = userSaid(message);
  const pending = rows.filter(r => r.state === 'pending');
  const prior = inputId && rows.find(r => r.decisionKey === inputId);
  if (prior) return { kind:'replay', row:prior,
    ...(prior.decisionGroup ? {rows:rows.filter(r => r.decisionGroup === prior.decisionGroup)} : {}) };
  const explicit = [...new Set([...said.matchAll(numberPattern)].map(m => Number(m[1])))];
  // Without a pending proposal, "pode ir na seção de supermercado" is a normal
  // turn's topic. Broad consent signals can't swallow a new request. Explicit
  // references and reactions still need validation/replay.
  if (!pending.length && !explicit.length && target === undefined && !viaReaction) return {kind:'continue'};
  const body = said.replace(numberPattern, '').replace(/\s+/g, ' ').trim();
  const confirm = isConfirmation(body) || /^(?:confirma|confirme|confirmar|confirm|approve)[.! ]*$/i.test(body)
    || (/^(?:confirma|confirme)\b/.test(folded(body)) && naturalApproval(body));
  const edit = amendment(body);
  const naturalCancel = !body.trim().endsWith('?') && /^(?:por favor[, ]+)?(?:cancela|cancele|cancelar|cancel)\b/i.test(folded(body));
  const plainCancel = cancellation(body);
  const cancel = plainCancel || naturalCancel;
  let decision = viaReaction ? (confirm ? 'confirm' : 'cancel') : edit ? 'edit' : confirm ? 'confirm' : cancel ? 'cancel' : null;
  const visible = displayedRows(rows, implicitIds.length ? implicitIds : implicitId ? [implicitId] : []);
  const discoveryConsent = visible.length === 1 && visible[0].name === 'jornada_configurar' && confirmsPending(visible[0],said);
  if (!decision && discoveryConsent) decision = 'confirm';
  let selected = explicit.map(n => rows.find(r => r.number === n)).filter(Boolean);
  if (explicit.length !== selected.length) return {kind:'unknown',rows:pending};
  if (explicit.length && decision === 'confirm' && !plainConsent(explicit.length > 1 ? body.replace(/\b(?:e|and|y)\b/g,'').replace(/\s+/g,' ').trim() : body)
      && !/^(?:confirma|confirme)[.! ]*$/.test(folded(body))) return {kind:'ambiguous',rows:pending};
  let matches = [];
  if (target !== undefined) {
    matches = rows.filter(r => r.messageRefs?.some(ref => ref.channel === target?.channel && ref.messageId === target?.messageId));
    if (viaReaction && !pending.length && !matches.length) return {kind:'ignore'};
    if (!validConfirmationReference(target)) return {kind:decision || explicit.length ? 'unknown' : 'continue',rows:pending};
    if (!matches.length && !decision && !explicit.length) return {kind:'continue'};
    if (explicit.length && selected.some(r => !matches.some(m => m.id === r.id))) return {kind:'unknown',rows:pending};
    // A quote/reply naming no row and no number still gets the generic "unknown"
    // unless it's a reaction with something pending to fall back to (below).
    if (!matches.length && !explicit.length && !(viaReaction && pending.length)) return {kind:'unknown',rows:pending};
    if (matches.length || explicit.length) {
      selected = explicit.length ? selected : matches;
      if (!explicit.length && !viaReaction && decision === 'confirm') {
        const named = naturalTargets(rows,said,false);
        if (named.some(r => !matches.some(m => m.id === r.id))) return {kind:'unknown',rows:pending};
        if (matches.length === 1 && !plainConsent(body) && !approvalOfTargets(said,matches)
            && !(phraseSelection(matches,said)?.consent)
            && !(matches[0].name === 'jornada_configurar' && confirmsPending(matches[0],said))) return {kind:'ambiguous',rows:matches};
      }
      if (!explicit.length && !viaReaction && matches.length > 1) {
        const phrased = !plainCancel && decision === 'confirm' ? phraseSelection(matches,said) : null;
        const narrowed = plainCancel ? [] : phrased?.consent ? phrased.rows : naturalTargets(matches,said);
        if (narrowed.length) {
          if (narrowed.length > 1) return {kind:'ambiguous',rows:narrowed};
          if (decision === 'confirm' && !phrased?.consent && !approvalOfTargets(said,narrowed)) return {kind:'ambiguous',rows:matches};
          selected = narrowed;
        }
        else if (decision === 'confirm' && !plainConsent(body)
          && !allConsent(body)) {
          return {kind:'ambiguous',rows:matches};
        }
      }
    }
    // A reaction/reply pointing at something we no longer track (expired, or
    // simply not ours) carries no usable target: fall through and resolve it
    // like a plain, targetless decision instead of the generic "which one".
  }
  if (!selected.length) {
    // A full refusal ("não precisa fazer nada") doesn't name by name an event
    // called "Nada". Only visible context or an explicit reference links it.
    const candidates = visible.length ? visible : pending;
    const phrased = plainCancel || (decision && decision !== 'confirm') ? null : phraseSelection(candidates, said);
    // Without a yes word, the beginning of the card only approves the card the
    // person just saw ("salvar o arquivo" in reply to the list).
    if (phrased?.rows.length === 1 && !decision && phrased.bare && visible.some(v => v.id === phrased.rows[0].id)) decision = 'confirm';
    if (!decision && (bareAll(body) || allConsent(body)) && visible.length > 1) decision = 'confirm';
    const matched = plainCancel ? [] : phrased && decision === 'confirm' && (phrased.consent || phrased.bare)
      ? phrased.rows : naturalTargets(candidates, said,visible.length > 0);
    if (matched.length) {
      if (matched.length > 1) return {kind:'ambiguous',rows:matched};
      if (decision === 'confirm' && !(phrased && matched === phrased.rows) && !approvalOfTargets(said,matched)) return {kind:'ambiguous',rows:pending};
      selected = matched;
    }
    else if (/\b(?:os dois|as duas|ambos|ambas|todos|todas|both|all|los dos|las dos|ambos)\b/.test(folded(body)) && decision) {
      if (decision === 'confirm' && !allConsent(body) && !bareAll(body)) return {kind:'ambiguous',rows:pending};
      if (!visible.length || (/\b(?:os dois|as duas|both|los dos|las dos)\b/.test(folded(body)) && visible.length !== 2)) return {kind:'ambiguous',rows:pending};
      selected = visible;
    } else if (decision) {
      // A reaction's decision already came from the tap itself (positive/negative),
      // not from matching free text, so the plain-consent phrase check below does
      // not apply to it; it still needs a usable row to land on, same as any other.
      if (decision === 'confirm' && !viaReaction && !plainConsent(body) && !discoveryConsent) return {kind:'ambiguous',rows:pending};
      // Simple consent goes to the single card the person just saw, even with
      // older requests still pending; those stay open. A targetless refusal
      // still requires a single pending one.
      if (visible.length === 1 && visible[0].state === 'pending' && (pending.length === 1 || decision === 'confirm')) selected = visible;
      else if (visible.length > 1 && sameRequest(visible) && decision === 'confirm') selected = visible;
      // Everything still open came from the one same request (e.g. a reaction
      // that lost its specific target): one "yes" covers all of it, same as
      // it already does when the grouped card is the thing being replied to.
      else if (pending.length > 1 && sameRequest(pending) && decision === 'confirm') selected = pending;
      else if (pending.length) return {kind:'ambiguous',rows:pending};
    }
  }
  if (!selected.length) return {kind:'continue'};
  // Same test a genuinely targetless message gets: an untracked target (the
  // reaction/reply above fell through to here) carries no more weight than none.
  const noUsableTarget = target === undefined || (!matches.length && !explicit.length);
  if (selected.length > 1 && (!decision || decision === 'edit' || (!explicit.length && noUsableTarget
      && !/\b(?:os dois|as duas|ambos|ambas|todos|todas|both|all|los dos|las dos)\b/.test(folded(body)) && !sameRequest(selected)))) return {kind:'ambiguous',rows:selected};
  if (selected.some(r => r.state !== 'pending')) return selected.every(r => r.state !== 'pending')
    ? {kind:'replay',row:selected[0],rows:selected} : {kind:'ambiguous',rows:selected};
  if (selected.some(r => !r.presented)) return {kind:'unseen',rows:selected};
  // Selecting by name alone is a question/continuation, never consent.
  if (!decision) return target !== undefined ? {kind:'inspect',row:selected[0]} : {kind:'continue'};
  return {kind:decision,row:selected[0],...(selected.length > 1 ? {rows:selected} : {})};
}

export function terminalConfirmation(row) {
  if (row.state === 'completed' && row.result?.text) return { text: row.result.text, attachments: row.result.attachments || [], replay: true };
  const t = textosConfirmacao(row.language);
  return { text: t.terminal(row.label, t.status[row.state] || t.status.other), attachments: [], replay: true };
}

async function prepareRow(session, row, resolveTool) {
  const adapter = await resolveTool(row);
  if (!adapter?.confirmationTool) throw Error('A ferramenta não está disponível com as permissões atuais.');
  setThreadLanguage(session.scope.threadId, row.language);
  setOwnerText(session.scope.threadId, row.source?.ownerHistory || '', row.source?.ownerText || '');
  const prepared = await gateTool(adapter.confirmationTool, session.scope.threadId, {
    ...adapter.confirmationOptions, confirmationPreview:true,
    ...(row.binding && adapter.confirmationTool.restoreConfirmation ? {restoreDescriptor:row.binding} : {}),
  }).run(row.args);
  if (typeof prepared?.run !== 'function') throw Error('O alvo deixou de estar disponível.');
  const fingerprint = confirmationFingerprint({name:prepared.name,args:prepared.args,binding:prepared.binding,
    context:session.context,label:prepared.label,confirmationText:prepared.confirmationText});
  if (fingerprint !== row.fingerprint) throw Error('Os detalhes ou as permissões mudaram.');
  if (adapter.executeConfirmed) {
    const run = prepared.run; prepared.run = args => adapter.executeConfirmed(() => run(args));
  }
  return {prepared,adapter};
}

function replayRows(rows) {
  return {text:rows.map(r => terminalConfirmation(r).text).join('\n\n'),
    attachments:rows.flatMap(r => r.result?.attachments || []),replay:true};
}

async function handleGroup(session, rows, {decision, viaReaction, inputId, resolveTool, afterComplete, heartbeatMs}) {
  if (decision === 'cancel') {
    const done = await session.store.closeMany(session.scope,rows.map(r => r.id),inputId);
    await session.refresh();
    return done ? {text:txRows(rows).canceledMany(rows.length),attachments:[]}
      : replayRows(rows.map(r => session.rows.find(current => current.id === r.id) || r));
  }
  if (viaReaction && rows.some(r => !isReactionConfirmable(r.name))) return proposalList(rows,txRows(rows).textOnlyMany);
  const plans = [];
  for (const row of rows) {
    try { plans.push({...await prepareRow(session,row,resolveTool),row}); }
    catch {
      await session.close(row,'invalidated',inputId);
      return {text:txRows(rows).groupNotStarted(row.label),attachments:[]};
    }
  }
  const claims = await session.store.claimMany(session.scope,rows.map(r => ({id:r.id,fingerprint:r.fingerprint})),inputId);
  if (!claims) {
    await session.refresh();
    return replayRows(rows.map(r => session.rows.find(current => current.id === r.id) || r));
  }
  const active = new Map(claims.map(c => [c.id,c]));
  const timer = setInterval(() => {for (const claim of active.values()) void session.store.heartbeat(session.scope,claim).catch(() => {});},heartbeatMs);
  timer.unref?.();
  const replies = [], attachments = [];
  try {
    for (const {row,prepared,adapter} of plans) {
      const claim = active.get(row.id);
      try {
        const rawResult = await prepared.run(prepared.args);
        const text = renderConfirmed(row,rawResult), files = adapter.confirmedAttachments?.() || [];
        const result = {text,rawResult:rawResult ?? null,attachments:files};
        const evidence = actionEvidenceFor(row.name,row.args,rawResult);
        if (!await session.store.finish(session.scope,claim,result,evidence?.state === 'unknown' ? 'uncertain' : 'completed')) throw Error('Result not recorded');
        await session.refresh();
        await afterComplete(session.rows.find(r => r.id === row.id)).catch(() => {});
        replies.push(text);attachments.push(...files);
      } catch {
        const text = txRows([row]).groupUncertain(row.label);
        await session.store.finish(session.scope,claim,{text},'uncertain').catch(() => {});
        replies.push(text);
      } finally {active.delete(row.id);}
    }
    await session.refresh();
    return {text:replies.join('\n\n'),attachments};
  } finally {clearInterval(timer);}
}

export async function handleConfirmation(session, { message, target, viaReaction = false, inputId = null,
  resolveTool, afterComplete = async () => {}, heartbeatMs = 30_000 } = {}) {
  const selected = selectConfirmation(session.rows, message, target, viaReaction, inputId, session.implicitTargetId, session.implicitTargetIds || []);
  if (selected.kind === 'continue') return null;
  if (selected.kind === 'ignore') return {ignore:true};
  if (selected.kind === 'replay') {
    if (selected.rows?.length > 1) {
      for (const row of selected.rows) if (row.state === 'completed') await afterComplete(row).catch(() => {});
      return replayRows(selected.rows);
    }
    if (selected.row.state === 'completed') await afterComplete(selected.row).catch(() => {});
    return terminalConfirmation(selected.row);
  }
  if (['unknown', 'ambiguous', 'unseen'].includes(selected.kind)) {
    return proposalList(selected.rows, selected.kind === 'unknown'
      ? txRows(selected.rows).unknown
      : selected.kind === 'unseen' ? txRows(selected.rows).unseen : undefined, selected.rows?.length ? undefined : session.language);
  }
  if (selected.rows?.length > 1) return handleGroup(session,selected.rows,{decision:selected.kind,viaReaction,inputId,resolveTool,afterComplete,heartbeatMs});
  const row = selected.row;
  if (selected.kind === 'inspect') return { note: `O dono está falando sobre o pedido ${row.number}: ${row.label}. Ele continua pendente; uma pergunta não autoriza execução.` };
  if (selected.kind === 'cancel' || selected.kind === 'edit') {
    if (!await session.close(row, selected.kind === 'edit' ? 'superseded' : 'canceled', inputId)) {
      return terminalConfirmation(session.rows.find(r => r.id === row.id) || { ...row, state: 'executing' });
    }
    if (selected.kind === 'edit') return { note: `O pedido ${row.number} foi invalidado antes de qualquer execução. O dono pediu uma alteração: ${userSaid(message)}. Proponha novamente a ferramenta ${row.name} com os argumentos corrigidos, a partir destes dados: ${JSON.stringify(row.args)}. Outros pedidos continuam pendentes. Não execute a versão antiga.` };
    return { text: textosConfirmacao(row.language).canceledOne(row.label), attachments: [] };
  }
  if (viaReaction && !isReactionConfirmable(row.name)) return proposalList([row], textosConfirmacao(row.language).textOnlyOne);
  let prepared, adapter;
  try {
    ({prepared,adapter} = await prepareRow(session,row,resolveTool));
  } catch {
    await session.close(row, 'invalidated', inputId);
    return { text: textosConfirmacao(row.language).notExecuted(row.label), attachments: [] };
  }
  const claim = await session.store.claim(session.scope, row.id, row.fingerprint, inputId);
  if (!claim) { await session.refresh(); return terminalConfirmation(session.rows.find(r => r.id === row.id) || { ...row, state: 'uncertain' }); }
  let timer;
  try {
    timer = setInterval(() => { void session.store.heartbeat(session.scope, claim).catch(() => {}); }, heartbeatMs);
    timer.unref?.();
    // Durable claim precedes the side effect. A crash after this point never
    // authorizes retry; completed receipts are replayed without executing.
    const rawResult = await prepared.run(prepared.args);
    const text = renderConfirmed(row, rawResult);
    const attachments = adapter.confirmedAttachments?.() || [];
    const result = { text, rawResult: rawResult ?? null, attachments };
    const evidence = actionEvidenceFor(row.name, row.args, rawResult);
    if (!await session.store.finish(session.scope, claim, result, evidence?.state === 'unknown' ? 'uncertain' : 'completed')) throw Error('Result not recorded');
    await session.refresh();
    // The SQL receipt is already final. A continuation queue failure must not
    // relabel that effect as uncertain; the durable recovery will retry enqueue.
    await afterComplete(session.rows.find(r => r.id === row.id)).catch(() => {});
    return { text, attachments };
  } catch {
    const text = textosConfirmacao(row.language).uncertain(row.label);
    await session.store.finish(session.scope, claim, { text }, 'uncertain').catch(() => {});
    await session.refresh();
    return { text, attachments: [] };
  } finally { if (timer) clearInterval(timer); }
}
