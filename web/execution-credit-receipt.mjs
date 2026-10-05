// Process-local attestation, not a model-supplied 'paid' flag. Symbol survives
// internal object spreads; it is deliberately absent from JSON/checkpoints.
// Recovery receives a new attestation only AFTER idempotent ledger settlement.
const TAG=Symbol('settled-execution-credit');
const receipts=new WeakMap();
const meteringKey=u=>JSON.stringify(['model','in','cached','out','think','total','deepseekPeak'].map(k=>u?.[k]??null));
export function attestSettledUsage(usage,receipt){
 if(receipt?.settled!==true||typeof receipt.userId!=='string'||typeof receipt.callId!=='string'||typeof receipt.attempt!=='string')throw Error('Verified settlement required');
 const tag=Object.freeze({});receipts.set(tag,{userId:receipt.userId,key:meteringKey(usage)});
 return {...usage,[TAG]:tag};
}
export function isSettledUsage(usage,{userId}={}){
 const tag=usage?.[TAG];
 const record=(tag&&typeof tag==='object'?receipts.get(tag):null)||directReceipts.get(usage);return !!record&&record.userId===userId&&record.key===meteringKey(usage);
}
const directReceipts=new WeakMap();
// Legacy collectors may receive frozen usage objects. Remember the exact
// observation without mutating it or trusting an externally supplied flag.
export function rememberSettledUsage(usage,receipt){
 const attested=attestSettledUsage(usage,receipt);
 directReceipts.set(usage,receipts.get(attested[TAG]));return usage;
}
