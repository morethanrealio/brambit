import {productI18n} from './i18n.mjs';
import {LEGACY_TEXT_LANGUAGE} from './locale.mjs';
export const codingPauseReason = result => result?.coding_task?.reason || result?.app_build?.motivo || 'execution_error';
const resumable = new Set(['execution_window','execution_quantum','workspace_busy','new_user_input','execution_error',
  'account_credit_exhausted','account_credit_reserved','credit_reservation_unavailable','credit_quote_unavailable',
  'credit_reconciliation_required','credit_control_unavailable','provider_failure','provider_unavailable',
  'report_partial','report_rejected','report_unavailable','review_partial','edit_validation_pending']);
// The next step goes straight to the person (chat, Telegram, WhatsApp), so it comes
// from the catalog in the account language and names the resume phrase that
// codingControlIntent recognizes in that language.
export function codingRecovery(result,language=LEGACY_TEXT_LANGUAGE) {
  const reason = codingPauseReason(result);
  const canResume = resumable.has(reason);
  const key = reason === 'uncertain_action' || reason === 'canceled_pending_reconciliation' ? 'uncertain'
    : ['access_denied','target_changed','mode_conflict','scope_clarification','draft_changed'].includes(reason) ? 'check_scope'
    : reason === 'account_credit_exhausted' ? 'credit_exhausted'
    : reason === 'account_credit_reserved' ? 'credit_reserved'
    : reason === 'credit_reconciliation_required' ? 'credit_reconciliation'
    : reason === 'credit_reservation_unavailable' ? 'credit_reservation'
    : canResume ? 'resumable' : 'needs_instruction';
  const {t}=productI18n();
  const nextStep = t(`coding.recovery.${key}`, language, {command: t('coding.resume_command', language)});
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
