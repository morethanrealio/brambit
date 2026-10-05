import {AsyncLocalStorage} from 'node:async_hooks';
// Transport hook only. No account, keys, database or billing rules in core.
// One invocation = ONE physical request; retry loops must invoke this each time.
const active=new AsyncLocalStorage();
export const withProviderAttempts=(observer,run)=>active.run(observer,run);
export const hasProviderAttempts=()=>typeof active.getStore()==='function';
export async function providerAttempt(spec,dispatch){
 const observer=active.getStore();
 return observer?observer(spec,dispatch):dispatch(spec.body);
}
export function throwIfAttemptControl(error){if(error?.name==='ExecutionCreditError'||error?.constructor?.name==='ExecutionCreditError')throw error;}
export function chatAttemptUsage(data,model){
 const u=data?.usage;
 if(!u||!Number.isSafeInteger(u.prompt_tokens)||!Number.isSafeInteger(u.completion_tokens)){const error=new Error('Provider did not report usage');error.code='PROVIDER_USAGE_MISSING';throw error;}
 return {model,in:u.prompt_tokens,cached:u.prompt_tokens_details?.cached_tokens??0,out:u.completion_tokens,think:0,total:u.total_tokens??u.prompt_tokens+u.completion_tokens};
}

// Account binding is installed by the trusted server, never by tool arguments.
// Factories used by other modules (housekeeping, connectors) inherit it as well.
const execution=new AsyncLocalStorage();
export const hasProviderExecution=identity=>!!execution.getStore()&&(identity===undefined||execution.getStore().identity===identity);
export const withProviderExecution=(bind,run,identity)=>execution.run({bind,identity},run);
export function wrapProvider(provider,policy={}){
 if(provider.executionWrapped)return provider;
 return {
  ...provider,executionWrapped:true,
  complete(input){
   const delegate=provider.executionDelegate?.();if(delegate)return (delegate.forBillingPhase?.(policy)||delegate).complete(input);
   const bind=execution.getStore()?.bind;
   return bind&&!hasProviderAttempts()?bind(provider,input,null,policy):provider.complete(input);
  },
  completeDurable(input,options){
   const delegate=provider.executionDelegate?.();if(delegate)return (delegate.forBillingPhase?.(policy)||delegate).completeDurable(input,options);
   const bind=execution.getStore()?.bind;
   if(!bind)throw Error('Durable execution requires trusted account binding');
   return bind(provider,input,options||{},policy);
  },
  forBillingPhase:next=>wrapProvider(provider,{...policy,...next}),
 };
}
