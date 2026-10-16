import {ExecutionCreditError} from './execution-error.mjs';
// Product stop reasons, separate from format validation and account exhaustion.
export function creditPauseReason(error) {
  if(!(error instanceof ExecutionCreditError))return null;
  if(error.code==='credit_result_stopped')return error.pauseReason || 'credit_control_unavailable';
  if(['account_credit_exhausted','account_credit_reserved','credit_reservation_unavailable'].includes(error.code))return error.code;
  if(error.code==='credit_provider_unavailable')return 'provider_unavailable';
  if(error.code==='credit_quote_unavailable')return 'credit_quote_unavailable';
  if(error.code==='metered_provider_failed')return error.creditReceipt?.settled?'provider_failure':'credit_reconciliation_required';
  if(['credit_usage_unavailable','credit_response_recovery_required','credit_settlement_pending'].includes(error.code))return 'credit_reconciliation_required';
  return 'credit_control_unavailable';
}
// No credit-control failure may trigger a provider retry or sticky fallback.
export function throwIfCreditFailure(error){if(error instanceof ExecutionCreditError)throw error;}
// Deterministic principal-turn stop: never a promise of background work, and
// never mislabel reserved/unknown credit as an exhausted account balance.
export function creditStopMessage(reason,language='pt-BR'){
 const lang=/^en\b/i.test(language)?'en':/^es\b/i.test(language)?'es':'pt';
 const text={
  pt:{account_credit_exhausted:'Seus créditos disponíveis acabaram. Não iniciei outra chamada. Você pode retomar quando houver saldo.',account_credit_reserved:'Há créditos reservados para chamadas em andamento ou ainda sem confirmação. Isso não significa que seu saldo acabou. Não iniciei outra chamada.',credit_reservation_unavailable:'A reserva estimada para esta chamada ultrapassa o saldo livre. Não iniciei a chamada; isso não significa que todos os créditos acabaram.',credit_reconciliation_required:'Tive uma falha temporária ao concluir esta resposta. Não repeti a chamada automaticamente para evitar duplicidade. Pode tentar novamente.',credit_quote_unavailable:'Não consegui calcular a reserva desta chamada com segurança. Não a enviei e não atribuí o problema a falta de créditos.',provider_unavailable:'O serviço de geração está indisponível. Não iniciei a chamada nem debitei créditos.',credit_control_unavailable:'O controle de créditos está temporariamente indisponível. Não iniciei outra chamada nem afirmei falta de saldo.',provider_failure:'A geração falhou. O consumo informado foi registrado uma única vez; não repeti a chamada.'},
  en:{account_credit_exhausted:'Your available credits are exhausted. I did not start another call. You can resume when credit is available.',account_credit_reserved:'Credits are reserved for in-flight or unconfirmed calls. This does not mean your balance ran out. No new call was started.',credit_reservation_unavailable:'The estimated reservation exceeds your available balance. The call was not sent; this does not mean all credits are exhausted.',credit_reconciliation_required:'A call has an unconfirmed result or charge. I did not replay it. This needs reconciliation before continuing.',credit_quote_unavailable:'I could not safely estimate this call. It was not sent; this is not a claim of insufficient credits.',provider_unavailable:'Generation is unavailable. No call was sent or charged.',credit_control_unavailable:'Credit control is temporarily unavailable. No new call was started; this does not mean credit is exhausted.',provider_failure:'Generation failed. The reported usage was recorded once; I did not repeat the call.'},
  es:{account_credit_exhausted:'Se agotaron tus créditos disponibles. No inicié otra llamada. Puedes retomar cuando haya saldo.',account_credit_reserved:'Hay créditos reservados para llamadas en curso o sin confirmar. Eso no significa que se agotó el saldo. No inicié otra llamada.',credit_reservation_unavailable:'La reserva estimada supera el saldo libre. No envié la llamada; eso no significa que se agotaron todos los créditos.',credit_reconciliation_required:'Una llamada tiene resultado o cobro sin confirmar. No la repetí. Hay que reconciliarla antes de continuar.',credit_quote_unavailable:'No pude estimar la reserva con seguridad. No envié la llamada ni atribuí el problema a falta de créditos.',provider_unavailable:'La generación no está disponible. No envié ni cobré una llamada.',credit_control_unavailable:'El control de créditos no está disponible temporalmente. No inicié otra llamada ni afirmé que faltaba saldo.',provider_failure:'La generación falló. Registré una vez el consumo informado; no repetí la llamada.'},
 };
 return text[lang][reason]||text[lang].credit_control_unavailable;
}

// Every reason creditStopMessage can render: a turn whose termination is one of
// these ended on a credit stop, not on a model answer.
export const CREDIT_STOP_REASONS=new Set(['account_credit_exhausted','account_credit_reserved','credit_reservation_unavailable','credit_reconciliation_required','credit_quote_unavailable','provider_unavailable','credit_control_unavailable','provider_failure']);

// Auxiliary consumers need an exception, not the principal-turn display text.
// Never persist a control-plane stop as OCR/caption/content or trigger fallback.
export function requireProviderContent(result) {
  if(result?.creditStop || result?.unavailable) {
    const error=new ExecutionCreditError('credit_result_stopped');
    const allowed=['account_credit_exhausted','account_credit_reserved','credit_reservation_unavailable','credit_reconciliation_required','credit_quote_unavailable','provider_unavailable','credit_control_unavailable','provider_failure'];
    error.pauseReason=allowed.includes(result.creditStop)?result.creditStop:'credit_control_unavailable';
    error.creditStop=error.pauseReason;
    error.creditStopText=result.text || creditStopMessage(error.pauseReason);
    throw error;
  }
  return result;
}
