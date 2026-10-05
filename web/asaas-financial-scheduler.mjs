import {
  asaasAuthorizationHash,
  secureAsaasTokenMatch,
  asaasResponseError,
  submitAsaasBillImmediate,
} from './connectors-vault.mjs';
import { marca } from './marca.mjs';

export async function processAsaasWithdrawalAuthorization({ payload, token, expectedToken, decide } = {}) {
  if (!expectedToken || !secureAsaasTokenMatch(token, expectedToken)) {
    return { httpStatus: 401, body: { status: 'REFUSED', refuseReason: 'Token de autenticação inválido' } };
  }
  const type = String(payload?.type || '').toUpperCase();
  const op = type === 'BILL' ? payload?.bill : type === 'TRANSFER' ? payload?.transfer : null;
  if (!op?.id || !['BILL', 'TRANSFER'].includes(type)) {
    return { httpStatus: 200, body: { status: 'REFUSED', refuseReason: `Tipo de operação não reconhecido pelo ${marca().nome}` } };
  }
  const payloadHash = asaasAuthorizationHash(payload);
  if (!payloadHash) {
    return { httpStatus: 200, body: { status: 'REFUSED', refuseReason: 'Operação sem dados verificáveis' } };
  }
  const decision = await decide({ providerOperationId: String(op.id), kind: type, payloadHash });
  if (!decision?.approved) {
    return { httpStatus: 200, body: { status: 'REFUSED', refuseReason: `Operação não reconhecida (${decision?.reason || 'sem correspondência'})` } };
  }
  return { httpStatus: 200, body: { status: 'APPROVED' } };
}

const terminalFailure = (status) => ['FAILED', 'CANCELLED', 'REFUNDED'].includes(String(status || '').toUpperCase());
const completed = (status) => ['PAID', 'DONE'].includes(String(status || '').toUpperCase());

function userMessage(row, state, detail = {}) {
  const id = row.id;
  if (state === 'completed') return `O pagamento agendado ${id} foi concluído.${detail.receipt ? ` Comprovante: ${detail.receipt}` : ''}`;
  if (state === 'awaiting_authorization') return `O pagamento agendado ${id} foi enviado à Asaas, mas aguarda a validação de segurança automática. Não repita o pedido; avisarei quando o estado mudar.`;
  if (state === 'submitted') return `O pagamento agendado ${id} foi enviado à Asaas e está em processamento. Não repita o pedido; avisarei quando concluir.`;
  if (state === 'needs_review' && detail.reason === 'execution_date_missed') return `Não executei o pagamento agendado ${id}: a data programada passou enquanto o serviço não estava disponível. Por segurança, não paguei atrasado automaticamente. Fale comigo para conferir e autorizar novamente.`;
  if (state === 'needs_review') return `Não executei o pagamento agendado ${id}: os dados do boleto mudaram desde a confirmação. Fale comigo para conferir valor e beneficiário antes de autorizar novamente.`;
  if (state === 'uncertain') return `Não consegui confirmar se o pagamento agendado ${id} foi recebido pela Asaas. Por segurança, não repeti. Consulte esse agendamento comigo antes de qualquer nova tentativa.`;
  return `O pagamento agendado ${id} não foi executado.${detail.reason ? ` Motivo: ${detail.reason}` : ''}`;
}

export function createAsaasFinancialScheduler({
  claimDue,
  finish,
  getCredential,
  ensureWebhook,
  saveIntent,
  saveOperation,
  notify,
  requestForCredential,
  intervalMs = 60_000,
  log = console,
} = {}) {
  let running = false;
  let stopped = false;
  let timer = null;

  const finalize = async (row, status, outcome = {}, providerOperationId = null) => {
    const persisted = await finish(row.id, { status, outcome, providerOperationId });
    if (!persisted) {
      log.warn?.(`[asaas-schedule] resultado ignorado: lease/estado mudou para ${row.id}`);
      return null;
    }
    try { await notify?.(row, userMessage(row, status, outcome)); }
    catch (e) { log.error?.('[asaas-schedule] notificação falhou:', e?.message || e); }
    return persisted;
  };

  const processOne = async (row) => {
    let providerMayHaveReceived = false;
    try {
      if (row?.recovered_uncertain) {
        try { await notify?.(row, userMessage(row, 'uncertain', row.outcome || {})); }
        catch (e) { log.error?.('[asaas-schedule] notificação de recuperação falhou:', e?.message || e); }
        return;
      }
      if (row?.recovered_needs_review) {
        try { await notify?.(row, userMessage(row, 'needs_review', row.outcome || {})); }
        catch (e) { log.error?.('[asaas-schedule] notificação de data perdida falhou:', e?.message || e); }
        return;
      }
      if (!row?.payload || !row.expected_hash || !row.external_reference) {
        return finalize(row, 'failed', { reason: 'agendamento_corrompido' });
      }
      const cred = await getCredential(row.owner_user_id);
      if (!cred?.key) return finalize(row, 'failed', { reason: 'conta_asaas_desconectada' });
      if (row.account_id && cred.accountId && row.account_id !== cred.accountId) {
        return finalize(row, 'needs_review', { reason: 'conta_asaas_mudou' });
      }
      const request = (path, opts = {}) => requestForCredential(cred.key, path, opts);
      await ensureWebhook?.(row, cred);
      const { result } = await submitAsaasBillImmediate(
        request, row.payload, row.external_reference, row.expected_hash,
      );
      providerMayHaveReceived = !result?.__changedBeforeSubmit;
      if (result?.__changedBeforeSubmit) {
        return finalize(row, 'needs_review', { reason: 'dados_mudaram_antes_do_envio' });
      }
      if (result?.__incerto) return finalize(row, 'uncertain', { reason: 'resposta_asaas_inconclusiva' });
      const error = asaasResponseError(result, 'o pagamento agendado');
      if (error) return finalize(row, 'failed', { reason: error });
      if (!result?.id) return finalize(row, 'uncertain', { reason: 'resposta_sem_id' });

      const authHash = asaasAuthorizationHash({ type: 'BILL', bill: result });
      if (!authHash) return finalize(row, 'uncertain', { reason: 'resposta_sem_dados_para_autorizacao' }, result.id);
      await saveIntent(row.owner_user_id, {
        providerOperationId: result.id,
        accountId: cred.accountId || row.account_id || '',
        kind: 'BILL', externalReference: row.external_reference, expectedHash: authHash,
      });
      const status = String(result.status || '').toUpperCase();
      const receipt = result.transactionReceiptUrl || null;
      await saveOperation(row.owner_user_id, {
        id: result.id, tipo: 'boleto', status, valor: result.value,
        accountId: cred.accountId || row.account_id || '',
        agentId: row.agent_id, threadId: row.thread_id, originChannel: row.origin_channel,
        comprovante: completed(status) ? receipt : null,
        comprovanteEntregue: completed(status) && !!receipt,
        modoExecucao: 'scheduled', agendadaParaSolicitada: String(row.execute_on).slice(0, 10),
        agendadaParaProvedor: result.scheduleDate || null, vencimento: result.dueDate || null,
      });
      const awaiting = result.awaitingCriticalActionAuthorization === true || result.authorized === false;
      const finalState = terminalFailure(status) ? 'failed' : completed(status) ? 'completed' : awaiting ? 'awaiting_authorization' : 'submitted';
      return finalize(row, finalState, {
        provider_status: status, valor: result.value, receipt,
        reason: terminalFailure(status) ? `status_${status || 'desconhecido'}` : undefined,
      }, result.id);
    } catch (e) {
      log.error?.('[asaas-schedule] execução falhou:', e?.message || e);
      // Antes do POST, erro é falha conhecida; depois do POST os caminhos acima
      // já marcam uncertain. Não há retry automático financeiro.
      return finalize(row, providerMayHaveReceived ? 'uncertain' : 'failed', {
        reason: String(e?.message || e).slice(0, 400),
      });
    }
  };

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const rows = await claimDue(10);
      for (const row of rows) await processOne(row);
    } catch (e) { log.error?.('[asaas-schedule] tick falhou:', e?.message || e); }
    finally { running = false; }
  };

  return {
    start() {
      stopped = false;
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
    tick,
    processOne,
  };
}
