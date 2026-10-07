import { tagIdioma } from './locale.mjs';
// Janela de uma batida do scheduler (60s): protege só a entrega imediata da
// execução no MESMO canal, não lembretes futuros nem rotinas de ação (none).
export const ROUTINE_DELIVERY_WINDOW_MS = 60_000;
export const ROUTINE_NO_NEWS = '[ROTINA_SEM_NOVIDADES]';
const CHANNELS = { whatsapp: 'WhatsApp', telegram: 'Telegram', email: 'e-mail' };
export function routineExecutionFrame({ kind, title = '', channel } = {}) {
  if (kind !== 'routine') return '';
  const base = `[ROUTINE EXECUTION] The routine${title ? ` "${title}"` : ''} is firing NOW. The text below is the TASK you must carry out right now, not a request to schedule something: the cadence (days and time) is already scheduled by the platform and does not depend on you. Carry out the task and return the finished RESULT. Do not describe the routine, do not ask for confirmation to activate it, do not say it "is already set up" and do not change its configuration. If the task cannot be done right now, state the concrete reason. If you greet, the greeting follows the local time in the "System context" at the end of this message (good morning until 12:00, good afternoon until 18:00, good evening after that, in the person's language), never the one from earlier deliveries in this conversation.`;
  const condition = `\n\n[CONDITIONAL DELIVERY] Only if the task explicitly asks for silence when there is nothing new, and you completed the check successfully, reply EXACTLY ${ROUTINE_NO_NEWS} in that case, with no other sentence. The platform will interpret this as delivering no message. Do not send \"no updates\". Never use this signal when there is a failure, a partial search, denied access or doubt: report the limitation. Do not use silence for a routine that asks for a report even when there is nothing new.`;
  if (!CHANNELS[channel]) return base + condition + '\n\n[ACTION ROUTINE] There is no automatic delivery in this mode. Only use sending tools if the task explicitly asks for it; do not send extra receipts or notices. The result of one action does not authorize another message.';
  return base + condition + `\n\n[ENTREGA AUTOMÁTICA] The platform will forward your final answer directly to the user via ${CHANNELS[channel]}. Your answer IS the content to deliver, not a sending receipt. If the task says "send a reminder", write the reminder directly. Do not say "I sent it", "sent successfully" or "I will send it". Do not create drafts in Gmail/Outlook or send emails through tools: the platform already delivers the result. Do not call enviar_mensagem or criar_lembrete to repeat/postpone the delivery itself (not even to the next minute); that is already the platform's responsibility. FUTURE reminders independent of the current delivery are still allowed, when the task really asks for them. There is no need to recreate the recurrence: the scheduler will run this same routine on the next configured days/times.`;
}

// Rotina de texto livre (cardápio, sugestões, plano da semana) roda sempre na
// mesma thread e com o mesmo pedido. Sem aviso, o modelo lê as entregas
// anteriores no histórico e devolve a mesma coisa (caso de 02/10/2026: o
// mesmo cardápio de 5 pratos em três sextas seguidas). Curadoria, monitor de voos
// e busca de e-mail têm controle próprio e não passam por aqui. As entregas vão
// no frame, e não só no histórico, porque a compactação resume o histórico e os
// itens somem dele. Quem decide se a tarefa pede variedade continua sendo o
// modelo: lembrete fixo e relatório de dado novo repetem a estrutura de propósito.
const ENTREGAS_ANTERIORES = 3;
const ENTREGA_MAX_CHARS = 1500;
// Devolve o bloco já com a separação ('\n\n...') ou '' quando não se aplica.
export function routineVarietyBlock(history = [], { kind, ownControl = false } = {}) {
  if (kind !== 'routine' || ownControl) return '';
  const entregas = [];
  for (let i = history.length - 1; i >= 0 && entregas.length < ENTREGAS_ANTERIORES; i--) {
    const m = history[i];
    if (m?.role !== 'assistant' || typeof m.content !== 'string' || !m.content.trim()) continue;
    const t = m.content.trim();
    entregas.push(t.length > ENTREGA_MAX_CHARS ? t.slice(0, ENTREGA_MAX_CHARS) + ' [...]' : t);
  }
  if (!entregas.length) return '';
  return `\n\n[PREVIOUS DELIVERIES OF THIS ROUTINE] Below is what this routine delivered in its last ${entregas.length} run(s), from most recent to oldest. If the task asks for new content on each run (menu, recipes, suggestions, ideas, plan, reading list), do NOT repeat the items already delivered: bring different options, unless the task or the person asked to keep them. If the task is a fixed reminder or a report of the day's data (calendar, quotes, emails), repeating the structure is expected; what changes is today's data. Never copy a previous delivery as your answer.\n`
    + entregas.map((t, i) => `--- delivery ${i + 1} ---\n${t}`).join('\n');
}

export function routineReminderDeliveryConflict({ kind, channel, reminderChannel, whenMs, nowMs = Date.now() }) {
  if (kind !== 'routine' || !CHANNELS[channel] || reminderChannel !== channel || !Number.isFinite(whenMs)) return false;
  const delta = whenMs - nowMs;
  return delta >= -60_000 && delta <= ROUTINE_DELIVERY_WINDOW_MS;
}

export const ROUTINE_REMINDER_CONFLICT = 'NÃO criei outro lembrete: esta rotina já terá a resposta entregue automaticamente neste canal. Dentro do próximo minuto, devolva o texto do lembrete diretamente como resposta final, sem dizer que já enviou e sem tentar adiar a própria entrega. Esta trava não altera a recorrência da rotina. Lembretes futuros independentes, fora dessa janela, continuam disponíveis.';

// Protocolo de saída, não um detector semântico de novidades: a decisão sobre a
// condição da tarefa continua com o modelo. Só consome um sinal EXATO no contexto
// de rotina. Uma cobertura parcial conhecida impede o silêncio.
export function routineFinalText(text, { kind, completed = false, failed = false, language } = {}) {
  const s = String(text ?? '');
  if (kind !== 'routine' || s.trim() !== ROUTINE_NO_NEWS) return s;
  if (!completed || failed) return ({
    en: 'I could not confirm that there are no updates: this run has no successful check or encountered an error/limit.',
    es: 'No pude confirmar que no haya novedades: esta ejecución no tiene una comprobación exitosa o encontró un error/límite.',
  })[tagIdioma(language)] || 'Não pude confirmar que não há novidades: esta execução não tem uma verificação bem-sucedida ou encontrou erro/limite.';
  return ''; // O aviso obrigatório de cobertura é aplicado depois, inclusive aqui.
}
