import {randomUUID,createHash} from 'node:crypto';
import {ExecutionCreditError} from './execution-error.mjs';
const copy=x=>JSON.parse(JSON.stringify(x));
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw new ExecutionCreditError(code);};
const legacyUnusableResponse=response=>response?.creditReconciliationPending===true&&
 response?.creditStop==='credit_reconciliation_required'&&response?.unavailable===true&&
 !response?.toolCalls?.length;
// Lives INSIDE the existing encrypted, exclusively locked app checkpoint.
// A request identity survives process death and is never regenerated on retry.
// completeDurable must settle idempotently BEFORE exposing model output. An
// unmetered legacy provider is never replayed after an uncertain dispatch.
export function createAppModelCalls({task,persist,provider,onUsage,onAdvance,now=()=>Date.now()}) {
  let usedThisInvocation=false;
  const checkpoint=async()=>{try{await persist();}catch{fail('credit_checkpoint_unavailable');}};
  const settleResponse=async pending=>{
    if(pending.accounted)return;
    const u=pending.response?.usage;
    if(u){
      // Consumers receive a stable key even when the provider needs no ledger
      // (synthetic tests). Real billing must deduplicate this key transactionally.
      try{await onUsage?.({...u,kind:pending.kind,noBill:pending.kind==='compact',executionCallId:pending.id});}
      catch(e){if(e instanceof ExecutionCreditError)throw e;fail('credit_settlement_pending');}
    }
    pending.accounted=true;
    if(!pending.metricsApplied){
      task.calls++;task.tokens+=u&&Number.isFinite(u.in)&&Number.isFinite(u.out)?Math.max(0,u.in)+Math.max(0,u.out):0;
      pending.metricsApplied=true;
    }
    await checkpoint();
  };
  return {
    get pending(){return task.modelCall||null;},
    get recovering(){return !!task.modelCall&&!usedThisInvocation;},
    // At a new loop boundary all prior tools have completed. This is also used
    // after a compact/report result has been consumed and saved by its caller.
    async consumed(){if(!usedThisInvocation)return;task.modelCall=null;usedThisInvocation=false;await checkpoint();},
    async toolConsumed(call){
      const p=task.modelCall;if(!p?.response)return;
      p.consumedTools=[...new Set([...(p.consumedTools||[]),call.id])];await checkpoint();
    },
    async complete(input,kind='subagent'){
      let p=task.modelCall;
      if(p&&usedThisInvocation){
        // A second provider call means a protocol repair or report phase. No
        // effectful tool can occur here without the core tool checkpoint hooks.
        await this.consumed();p=null;
      }
      if(!p){
        p={id:randomUUID(),kind,input:copy(input),requestHash:hash(input),state:'prepared',response:null,accounted:false,metricsApplied:false,consumedTools:[],createdAt:now()};
        task.modelCall=p;await checkpoint();
      } else if(p.kind!==kind){
        // Do not consume a compact/report response as an exploration response.
        fail('credit_response_recovery_required');
      }
      if(!p.response){
        if(p.state==='dispatched'&&typeof provider.completeDurable!=='function')fail('credit_response_recovery_required');
        p.state='dispatched';await checkpoint();
        let response;
        try{
          response=typeof provider.completeDurable==='function'
            ?await provider.completeDurable(p.input,{callId:p.id,kind:p.kind,noBill:p.kind==='compact'})
            :await provider.complete(p.input);
        }catch(e){
          // A proven pre-dispatch denial can be retried after credit/access is
          // restored. An unknown call keeps its identity and cannot be repeated.
          if(!e?.creditHasPriorAttempt&&['account_credit_exhausted','account_credit_reserved','credit_reservation_unavailable','credit_quote_unavailable','credit_provider_unavailable'].includes(e?.code)){
            task.modelCall=null;await checkpoint();
          }
          throw e;
        }
        if(!response||typeof response!=='object')fail('credit_response_recovery_required');
        p.response=copy(response);p.state='observed';await checkpoint();
        // Keep the live attested usage for this attempt; do not serialize an
        // attestation as an instruction to bypass billing on a later process.
        if(response.usage)p.response.usage=response.usage;
      }else if(!p.accounted&&typeof provider.completeDurable==='function'){
        // Recover the same settled response/receipt, NEVER make a new request.
        const recovered=await provider.completeDurable(p.input,{callId:p.id,kind:p.kind,noBill:p.kind==='compact'});
        if(hash(copy(recovered))!==hash(copy(p.response)))fail('credit_response_recovery_required');
        p.response=recovered;
      }else if(p.accounted&&legacyUnusableResponse(p.response)&&typeof provider.completeDurable==='function'){
        // Older app checkpoints saved the product-level reconciliation message
        // after the physical Together response had already been preserved. Ask
        // the durable provider for the SAME logical call again: it must recover
        // the primary bytes locally and may persist a separately admitted
        // fallback result. Never clear the task call or mint a new primary ID.
        const recovered=await provider.completeDurable(p.input,{callId:p.id,kind:p.kind,noBill:p.kind==='compact'});
        if(!recovered||typeof recovered!=='object')fail('credit_response_recovery_required');
        if(hash(copy(recovered))!==hash(copy(p.response))){
          p.response=copy(recovered);p.state='observed';p.recoveredLegacyCreditStop=true;await checkpoint();
          if(recovered.usage){p.accounted=false;await settleResponse(p);}
        }
      }
      await settleResponse(p);usedThisInvocation=true;
      const response=copy(p.response);
      if(response.usage)response.usage=p.response.usage;
      if(response.toolCalls?.length){
        response.toolCalls=response.toolCalls.filter(c=>!p.consumedTools.includes(c.id));
        if(!response.toolCalls.length){
          // All effects were checkpointed before the process died. The saved
          // conversation already contains their results; continue, don't rerun.
          await this.consumed();return onAdvance?onAdvance(input,kind):this.complete(input,kind);
        }
      }
      return response;
    },
  };
}
