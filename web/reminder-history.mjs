import { recurrenceLabel, recurrenceOccurrences } from './calendar-recurrence.mjs';
// Provider acceptance is evidence of submission, never of delivery or reading.
const parentLabels = {
  pending: 'agendado', sent: 'processado', failed: 'envio falhou',
  uncertain: 'resultado incerto', canceled: 'cancelado', deduped: 'agrupado com lembrete equivalente',
};
const occurrenceLabels = {
  scheduled: 'agendado, sem tentativa de envio', claimed: 'preparando envio',
  delivering: 'envio iniciado, aguardando resultado',
  accepted: 'aceito pelo canal; não comprova entrega nem leitura',
  failed: 'envio falhou; esta ocorrência não será repetida automaticamente',
  uncertain: 'resultado incerto; confira o canal antes de pedir novo envio',
  canceled: 'cancelado antes do envio', deduped: 'coberto por lembrete equivalente',
};
const channels = { telegram: 'Telegram', whatsapp: 'WhatsApp', email: 'e-mail' };
const deliveryLabels = {
  delivered: 'entrega confirmada pelo canal; leitura não confirmada',
  read: 'leitura confirmada pelo canal',
  partial: 'envio parcial: algumas partes foram aceitas; as demais falharam ou estão sem confirmação. Não reenviar a mensagem inteira',
  failed: 'falha confirmada pelo canal; esta ocorrência não será repetida automaticamente',
};

export function reminderHistoryText(rows, { includeRecent = false, timeZone = 'America/Sao_Paulo' } = {}) {
  if (!rows.length) return includeRecent
    ? 'Você não tem lembretes agendados nem histórico nos últimos 30 dias.'
    : 'Você não tem nenhum lembrete pendente.';
  const date = value => value ? new Date(value).toLocaleString('pt-BR', {
    timeZone, dateStyle: 'short', timeStyle: 'short',
  }) : 'horário não registrado';
  const lines = rows.map(row => {
    const when = row.status === 'pending' ? 'previsto para' : 'horário registrado';
    const cadence = row.calendar_recurrence;
    const repeat = cadence ? '; '+recurrenceLabel(cadence.regra,cadence.inicio,cadence.fuso)
      : row.repeat_every_min
      ? `; repete a cada ${row.repeat_every_min} min${row.repeat_until ? ` até ${date(row.repeat_until)}` : ' até você cancelar'}` : '';
    const last = row.last_occurrence;
    const outcome = last
      ? `${date(last.scheduledAt)}: ${deliveryLabels[last.deliveryState] || occurrenceLabels[last.status] || 'resultado não determinado'}`
      : row.status === 'sent' ? 'registro antigo sem recibo de aceitação; entrega não comprovada'
      : 'sem tentativa registrada';
    const preview = cadence ? recurrenceOccurrences(cadence.regra,cadence.inicio,cadence.fuso,{after:row.run_at,limit:2}).map(v=>date(v.instant)).join('; ') : '';
    return `• ${String(row.message || '').replace(/^⏰\s*/, '').slice(0, 160)} — ${channels[row.channel] || row.channel}\n`
      + (row.id ? `  Referência interna para edição/cancelamento: ${row.id}; quando_atual=${new Date(row.run_at).toISOString()}. Não exponha o identificador ao usuário.\n` : '')
      + `  ${parentLabels[row.status] || 'estado não determinado'}; ${when} ${date(row.run_at)}${repeat}.\n`
      + (preview ? `  Ocorrências seguintes da série: ${preview}.\n` : '')
      + `  Último registro: ${outcome}.`;
  });
  const title = includeRecent ? 'Lembretes agendados e histórico dos últimos 30 dias' : 'Lembretes pendentes';
  return `${title} (${rows.length}${rows.length >= 200 ? '; limite de consulta atingido' : ''}):\n${lines.join('\n')}`;
}
