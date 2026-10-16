import { createScheduledDelivery } from '../web/scheduled-delivery.mjs';
// Real adapters, mocked fetch only. Deny sockets/processes even if a test is miswired.
import assert from 'node:assert/strict';import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=denied;syncBuiltinESMExports();
process.env.WA_TOKEN='synthetic';process.env.WA_PHONE_NUMBER_ID='1';process.env.WA_VERIFY_TOKEN='synthetic';
let calls=[],behavior='ok';globalThis.fetch=async(url,opts)=>{const body=JSON.parse(opts.body);calls.push({url,body});if(behavior==='timeout')throw Error('synthetic timeout');return {ok:true,json:async()=>String(url).includes('api.telegram.org')?{ok:true,result:{message_id:calls.length}}:{messages:[{id:'wamid-'+calls.length}]}};};
const {sendTelegramMessage}=await import('../web/telegram.mjs');const {sendWhatsAppProactive,setWaHooks}=await import('../web/whatsapp.mjs');
let n=0;const eq=(a,b)=>{assert.deepEqual(a,b);n++;};
const tg=await sendTelegramMessage('synthetic','123','texto '.repeat(800));eq(tg.message_ids.length,2);eq(tg.message_id,1);eq(calls.length,2);
calls=[];setWaHooks({lastInboundAt:async()=>null});let receipt=await sendWhatsAppProactive('5511000000000','multiline\ntext',{templateText:'texto em linha única',retryUnknown:false});eq(receipt.via,'template');eq(calls.length,1);eq(calls[0].body.type,'template');eq(calls[0].body.template.components[0].parameters[0].text,'texto em linha única');
calls=[];setWaHooks({lastInboundAt:async()=>new Date()});receipt=await sendWhatsAppProactive('5511000000000','texto',{templateText:'texto',retryUnknown:false});eq(receipt.via,'session');eq(calls.length,1);
calls=[];behavior='timeout';await assert.rejects(()=>sendWhatsAppProactive('5511000000000','texto',{templateText:'texto',retryUnknown:false}));n++;eq(calls.length,1); // no blind fallback on uncertain send
// Exact production adapter returns normalized receipts and disables LLM/template retries for curation.
let waOpts;
const {deliverRoutine:deliver}=createScheduledDelivery({sendEmail:async()=>({ok:true,id:'email'}),
 getTelegramBotForDelivery:async()=>({token:'synthetic',chat_id:'1'}),sendTelegramMessage:async()=>({message_id:23}),
 waEnabled:()=>true,getWhatsAppLinkForUser:async()=>({wa_phone:'5511000000000'}),
 sendWhatsAppProactive:async(p,t,o)=>{waOpts=o;return {wamid:'wa'};},whatsappProse:denied,persistProactiveToThread:async()=>{}});
eq(await deliver({channel:'telegram'},'text'),{ok:true,id:'23',channel:'telegram',status:'accepted'});
eq(await deliver({channel:'email',email:'synthetic@example.invalid'},'text'),{ok:true,id:'email',channel:'email',status:'accepted'});
eq(await deliver({channel:'whatsapp'},{type:'flight-monitor-v1',text:'text',templateText:'plain'}),{ok:true,id:'wa',channel:'whatsapp',status:'accepted'});
eq(waOpts.retryUnknown,false);eq(waOpts.proseFallback,null);eq(waOpts.templateText,'plain');
console.log(`OK: ${n} verificações dos transportes reais, fetch simulado; zero mensagens/rede reais.`);
