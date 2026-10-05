export const codingPauseReason = result => result?.coding_task?.reason || result?.app_build?.motivo || 'execution_error';
const resumable = new Set(['execution_window','execution_quantum','workspace_busy','new_user_input','execution_error',
  'account_credit_exhausted','account_credit_reserved','credit_reservation_unavailable','credit_quote_unavailable',
  'credit_reconciliation_required','credit_control_unavailable','provider_failure','provider_unavailable',
  'report_partial','report_rejected','report_unavailable','review_partial','edit_validation_pending']);
export function codingRecovery(result) {
  const reason = codingPauseReason(result);
  const canResume = resumable.has(reason);
  const nextStep = reason === 'uncertain_action' || reason === 'canceled_pending_reconciliation'
    ? 'Há uma operação com resultado incerto. É preciso conferir seu efeito no ambiente antes de continuar; não vou repeti-la.'
    : ['access_denied','target_changed','mode_conflict','scope_clarification','draft_changed'].includes(reason)
      ? 'Confira o acesso, o alvo e o escopo da tarefa antes de autorizar uma nova execução.'
    : reason === 'account_credit_exhausted'
      ? 'O progresso está salvo. Quando houver saldo, diga “retomar programação”.'
    : reason === 'account_credit_reserved'
      ? 'O progresso está salvo; há créditos reservados, o que não significa saldo esgotado. Depois da liberação, diga “retomar programação”.'
    : reason === 'credit_reconciliation_required'
      ? 'Diga “retomar programação” para tentar recuperar o resultado e a cobrança já registrados. Uma chamada ainda incerta não será reenviada.'
    : reason === 'credit_reservation_unavailable'
      ? 'O saldo livre não cobre a reserva estimada da próxima chamada. O progresso está salvo; retome quando houver saldo suficiente.'
    : canResume ? 'O progresso está salvo. Diga “retomar programação” para continuar a mesma tarefa.'
      : 'A tarefa precisa de uma instrução que resolva a pendência indicada antes de continuar.';
  return { reason, canResume, nextStep };
}
export function codingConsumption(result) {
  const calls=result?.coding_task?.calls ?? result?.app_build?.orcamento?.chamadas;
  const tokens=result?.coding_task?.tokens ?? result?.app_build?.orcamento?.tokens_contabilizados;
  return { calls:Number.isFinite(calls)?calls:null, tokens:Number.isFinite(tokens)?tokens:null,
    pending:result?.coding_task?.consumptionPending === true || result?.app_build?.consumo_pendente === true };
}
export const codingExecutionId = job => Number(job.resumeCount)>0 ? `${job.id}:resume:${job.resumeCount}` : job.id;
export const codingDeliveryKey = job => `coding-job:${codingExecutionId(job)}`;
