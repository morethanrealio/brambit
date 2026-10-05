import {randomUUID} from 'node:crypto';
import {ExecutionCreditError} from './execution-error.mjs';
// A shared admission barrier for REPORTED legacy usage, not an estimate of an
// external operation still in flight. Model requests use pre-dispatch holds.
// Retry is only the idempotent local write, never the paid operation.
export function createPendingUsageWrites(){
 const accounts=new Map();
 return {
  enqueue(userId,write){
   const entry={write,promise:null};let set=accounts.get(userId);
   if(!set)accounts.set(userId,set=new Set());set.add(entry);
   const attempt=()=>{entry.promise=Promise.resolve().then(write).then(()=>{set.delete(entry);if(!set.size)accounts.delete(userId);},()=>{entry.promise=null;});};
   entry.retry=attempt;attempt();
  },
  // Contas com gravação ainda pendente. Na conta empresarial o saldo é da
  // empresa inteira, então a admissão de um membro drena também os colegas.
  pendingUsers(){return [...accounts.keys()];},
  async drain(userId){
   // Snapshot: do not wait indefinitely for unrelated new activity to stop.
   const entries=[...(accounts.get(userId)||[])];
   for(const entry of entries){if(!entry.promise)entry.retry();await entry.promise;if(!entry.promise)throw new ExecutionCreditError('credit_settlement_pending');}
  },
 };
}
export function createIncrementalUsageCollector({userId,write,pending}){
 const entries=[];
 return {
  push(...items){for(const e of items){
   if(!e?.usage)continue;
   const entry={...e,usage:e.usage,eventId:randomUUID()};entries.push(entry);
   pending.enqueue(userId,()=>write(entry));
  }return entries.length;},
  [Symbol.iterator](){return entries[Symbol.iterator]();},
  get length(){return entries.length;},
 };
}
