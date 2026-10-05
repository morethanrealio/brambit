import test from 'node:test';import assert from 'node:assert/strict';
import {createCodingNotifier} from './web/coding-notify.mjs';
const job={userId:'owner',agentId:'agent',channel:'whatsapp',result:{text:'Alterado.\nVerificação pendente.'}};
test('WhatsApp uses origin owner, single-line template, no unknown retry and no model call',async()=>{
 let received;const send=createCodingNotifier({getAgent:async()=>({name:'Bento'}),getWhatsAppLink:async u=>{assert.equal(u,'owner');return {enabled:true,wa_phone:'synthetic'}},waEnabled:()=>true,sendWhatsApp:async(...a)=>{received=a;return {wamid:'fake'}}});
 assert.equal((await send(job)).state,'sent');assert.equal(received[2].retryUnknown,false);assert.ok(!received[2].templateText.includes('\n'));
});
test('no connected origin never falls back to another channel',async()=>{
 const send=createCodingNotifier({getAgent:async()=>({}),getWhatsAppLink:async()=>null,waEnabled:()=>true,getTelegramBot:()=>{throw Error('must not cross channels')}});assert.equal((await send(job)).state,'unavailable');
});
test('paused task notification includes the saved result and concrete resume instruction',async()=>{
 let text;const send=createCodingNotifier({getAgent:async()=>({name:'Fixture'}),getWhatsAppLink:async()=>({enabled:true,wa_phone:'synthetic'}),waEnabled:()=>true,sendWhatsApp:async(_phone,value)=>{text=value;return {wamid:'receipt'};}});
 await send({...job,state:'paused',result:{text:'Alteração preservada.',coding_task:{reason:'account_credit_reserved'}}});
 assert.match(text,/Alteração preservada/);assert.match(text,/retomar programação/);assert.match(text,/não significa saldo esgotado/);
});
test('Telegram verifies a returned receipt and bounds the notification without losing full stored result',async()=>{
 let text;const send=createCodingNotifier({getAgent:async()=>({name:'Bento'}),getTelegramBot:async()=>({enabled:true,token:'synthetic',chat_id:'fake'}),sendTelegram:async(t,c,s)=>{text=s;return {message_id:10}}});
 const input={...job,channel:'telegram',result:{text:'x'.repeat(5000)}};assert.equal((await send(input)).state,'sent');assert.ok(text.length<3100);assert.equal(input.result.text.length,5000);
});
