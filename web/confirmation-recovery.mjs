import { gateTool, setThreadLanguage, renderConfirmed } from './confirm.mjs';
import { codingPolicySnapshot } from './coding-jobs.mjs';

// This recovery only reads an already committed app-control receipt. It never
// retries a tool or an external side effect after a crash.
export function createConfirmationRecovery({ store, appTaskStore, jobs, getAgentOwned }) {
  async function continueCoding(scope, proposal) {
    if (proposal?.name !== 'gerenciar_tarefa_de_app' || proposal.state !== 'completed' || proposal.continuationAcknowledged) return;
    const result = proposal.result?.rawResult;
    const agent = await getAgentOwned(scope.agentId, scope.userId);
    if (!agent || codingPolicySnapshot(agent) !== proposal.context?.policy) {
      await store.acknowledgeContinuation(scope,proposal.id,true); proposal.continuationAcknowledged=true; return;
    }
    if (result?.ok && result.continuation) {
      const task = proposal.binding?.scope ? await appTaskStore.read(proposal.binding.scope) : null;
      if (!task || task.status === 'cancelled' || task.objective !== result.continuation.objetivo
          || task.mode !== result.continuation.modo
          || JSON.stringify(task.reviewFiles || []) !== JSON.stringify(result.continuation.arquivos_revisao || [])) {
        await store.acknowledgeContinuation(scope,proposal.id,true); proposal.continuationAcknowledged=true; return;
      }
      if (!await store.isContinuationAllowed(scope,proposal.id)) return;
      const queued = await jobs.submit(scope, {kind:'basic', args:result.continuation,
        confirmationId:proposal.id,
        userRequest:result.continuation.objetivo, policy:proposal.context.policy,
        channel:proposal.source?.channel || 'chat'}, 'confirmation:'+proposal.id);
      if (!queued?.ok || !queued.programming_job) return;
    }
    await store.acknowledgeContinuation(scope, proposal.id);
    proposal.continuationAcknowledged=true;
  }
  let running = false;
  return { continueCoding, async recover() {
    if (running) return;
    running = true;
    try {
      for (const {scope,claim,proposal} of await store.recoverableCoding()) {
        try {
          if (proposal.state !== 'completed') {
            const binding = proposal.binding;
            if (binding?.version !== 1 || typeof binding.scope !== 'string' || typeof binding.operationId !== 'string') continue;
            const record = await appTaskStore.read(binding.scope);
            const rawResult = record?.controlReceipts?.[binding.operationId];
            if (!rawResult) continue;
            const result = {text:renderConfirmed(proposal,rawResult),rawResult};
            if (!await store.recordCodingReceipt(scope,claim,result)) continue;
            proposal.state='completed';proposal.result=result;
          }
          await continueCoding(scope,proposal);
        } catch { /* leave the durable receipt available for the next attempt */ }
      }
    } finally { running = false; }
  } };
}

// Bridge the previous single-pending app store at rollout. Re-present it with
// a stable request number; an old unnumbered "yes" cannot silently approve it.
export async function migrateCodingConfirmation(session, legacy, resolveTool) {
  const old = await legacy.peek();
  if (!old || old.state !== 'pending') return null;
  if (old.expiresAt <= Date.now() || old.context?.policy !== session.context.policy) {
    await legacy.cancel(); return null;
  }
  const proposal = {...old,source:{ownerText:'',channel:old.context?.channel || 'chat'}};
  const adapter = await resolveTool(proposal);
  if (!adapter?.confirmationTool) { await legacy.cancel(); return null; }
  setThreadLanguage(session.scope.threadId,old.language);
  const prepared = await gateTool(adapter.confirmationTool,session.scope.threadId,{
    ...adapter.confirmationOptions,confirmationPreview:true,restoreDescriptor:old.binding,
  }).run(old.args);
  if (typeof prepared?.run !== 'function') { await legacy.cancel(); return null; }
  const {run,...payload} = prepared;
  const row = await session.store.propose(session.scope,{...payload,context:session.context,source:proposal.source},
    {migrationKey:old.id,expiresAt:new Date(old.expiresAt).toISOString()});
  await legacy.cancel();
  await session.refresh();
  return row.state === 'pending' ? row : null;
}
