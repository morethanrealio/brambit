import { createScheduledDelivery } from './web/scheduled-delivery.mjs';
import { actionResult } from './web/action-evidence.mjs';
// No real accounts, database, delivery or subprocesses. Extract real orchestration.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
const {routineExecutionFrame,routineFinalText,ROUTINE_NO_NEWS}=await import('./web/routine-delivery.mjs');
const {turnSearchCoverage}=await import('./web/turn-search-coverage.mjs');
const {runAgent,ToolRegistry}=await import('./core-proto/core.mjs');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},ok=a=>{assert.ok(a);checks++;};
const source=readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');
const extract=name=>{const a=source.indexOf('async function '+name+'('),b=source.indexOf('\n}\n',a)+2;assert.ok(a>=0&&b>a);return source.slice(a,b);};
const a=source.indexOf("    name: 'enviar_mensagem'"),b=source.indexOf('\n  });',a),literal='{'+source.slice(a,b)+'\n}';
function harness({kind='routine',sendFail=false,persistFail=false,skipped=false,via='session',connected=true}={}){
 const calls=[];
 const deps={actionResult,kind,agent:{id:'synthetic-agent',name:'Mock'},userId:'synthetic-user',
 console:{error:()=>{calls.push(['persist-error']);}},
 getOrCreateThreadByTitle:async r=>{calls.push(['thread',r]);if(persistFail)throw Error('DB mock failure');return {id:'synthetic-channel-thread'};},
 appendAssistantToThread:async r=>{calls.push(['append',r]);},normalizeSubject:s=>s.replace(/^Re:\s*/i,''),
 getTelegramBotForDelivery:async()=>connected?{token:'MOCK',chat_id:'MOCK'}:null,
 waEnabled:()=>connected,getWhatsAppLinkForUser:async()=>({wa_phone:'MOCK',enabled:connected}),whatsappProse:denied,
 getUserById:async()=>connected?{email:'mock@example.invalid',name:'Mock'}:null,
 sendTelegramMessage:async(...args)=>{calls.push(['send-tg',...args]);if(sendFail)throw Error('mock send failed');},
 sendWhatsAppProactive:async(...args)=>{calls.push(['send-wa',...args]);if(sendFail)throw Error('mock send failed');return {via};},
 sendEmail:async args=>{calls.push(['send-email',args]);if(sendFail)throw Error('mock send failed');return {skipped};},
 };
 deps.persistProactiveToThread=new Function(...Object.keys(deps),extract('persistProactiveToThread')+';return persistProactiveToThread;')(...Object.values(deps));
 return {calls,tool:new Function(...Object.keys(deps),'return '+literal)(...Object.values(deps))};
}
for(const ch of ['telegram','whatsapp','email']){
 const h=harness();const out=await h.tool.run({canal:ch,mensagem:'Mensagem sintética.'});ok(out.includes('Envio aceito'));
 eq(h.calls.filter(x=>x[0].startsWith('send-')).length,1);eq(h.calls.filter(x=>x[0]==='append').length,1);
 const thread=h.calls.find(x=>x[0]==='thread')[1];eq(thread.userId,'synthetic-user');eq(thread.agentId,'synthetic-agent');
 eq(thread.title,ch==='telegram'?'Telegram':ch==='whatsapp'?'WhatsApp':'📧 Mensagem sintética.');
 eq(h.calls.find(x=>x[0]==='append')[1],{threadId:'synthetic-channel-thread',userId:'synthetic-user',text:'Mensagem sintética.'});
 ok(h.calls.findIndex(x=>x[0].startsWith('send-'))<h.calls.findIndex(x=>x[0]==='append'));
 for(const opts of [{sendFail:true},{connected:false}]){const f=harness(opts);const r=await f.tool.run({canal:ch,mensagem:'Mock'});ok(!/enviada.*✅/.test(r));eq(f.calls.filter(x=>x[0]==='append'||x[0]==='thread').length,0);}
 const fail=harness({persistFail:true});const r=await fail.tool.run({canal:ch,mensagem:'Mock'});ok(r.includes('Envio aceito'));eq(fail.calls.filter(x=>x[0].startsWith('send-')).length,1);ok(fail.calls.some(x=>x[0]==='persist-error'));
 for(const kind of ['chat','telegram','whatsapp','email']){const ordinary=harness({kind});await ordinary.tool.run({canal:ch,mensagem:'Mock'});eq(ordinary.calls.filter(x=>x[0]==='append'||x[0]==='thread').length,0);}
 const third=harness();await third.tool.run({canal:ch,mensagem:'Mock',para:'Outra pessoa'});eq(third.calls,[]);
}
const skipped=harness({skipped:true});ok((await skipped.tool.run({canal:'email',mensagem:'Mock'})).includes('não realizou'));eq(skipped.calls.filter(x=>x[0]==='append').length,0);
const template=harness({via:'template'});ok((await template.tool.run({canal:'whatsapp',mensagem:'Mock'})).includes('notificação'));eq(template.calls.filter(x=>x[0]==='append').length,1);
// Registry pruning: only automatic-delivery routines, before constructing provider tools.
const names=['enviar_mensagem','gmail_create_draft','gmail_send','hotmail_send','gmail_search','consultar_google','criar_lembrete','drive_upload'];
const start=source.indexOf("  if (!noTools && kind === 'routine' && routineChannel && routineChannel !== 'none') {"),end=source.indexOf('  // Segunda camada do fix acima',start);
assert.ok(start>0&&end>start);const prune=new Function('registry','kind','routineChannel','noTools','console',source.slice(start,end));
for(const kind of ['routine','chat','whatsapp'])for(const ch of ['email','telegram','whatsapp','none',null])for(const noTools of [false,true]){
 const reg=new ToolRegistry();for(const name of names)reg.add({name,run:denied});prune(reg,kind,ch,noTools,{log:()=>{}});
 const auto=kind==='routine'&&ch&&ch!=='none'&&!noTools;
 for(const name of names)eq(reg.map.has(name),!(auto&&names.slice(0,4).includes(name)));
}
// Exact no-news protocol only for routine and after successful check. Not NLP.
for(const kind of ['chat','telegram','routine'])for(const completed of [false,true])for(const failed of [false,true]){
 const value=routineFinalText(ROUTINE_NO_NEWS,{kind,completed,failed});
 if(kind!=='routine')eq(value,ROUTINE_NO_NEWS);else if(completed&&!failed)eq(value,'');else ok(value.includes('Não pude confirmar'));
}
for(const text of ['Nenhuma novidade.',`Texto ${ROUTINE_NO_NEWS}`,`${ROUTINE_NO_NEWS} texto`,'Preço alterou.',''])eq(routineFinalText(text,{kind:'routine',completed:true}),text);
for(const language of ['en','es','pt-BR'])ok(routineFinalText(ROUTINE_NO_NEWS,{kind:'routine',language}).length>30);
for(const channel of ['whatsapp','telegram','email','none']){
 const frame=routineExecutionFrame({kind:'routine',channel});ok(frame.includes(ROUTINE_NO_NEWS));ok(frame.includes('explicitamente'));ok(frame.includes('busca parcial'));
 if(channel==='none'){ok(!frame.includes('ENTREGA AUTOMÁTICA'));ok(frame.includes('Não há entrega automática'));}else ok(frame.includes('Não crie rascunhos'));
}
// Real core returns the protocol; no salvage/extra call; real deliverRoutine sends nothing.
let step=0;const reg=new ToolRegistry().add({name:'consultar',parameters:{type:'object',properties:{}},run:async()=>'{"items":[],"partial":false}'});
const routineCheck={completed:false,failed:false};const toolCounts={};
const eventStart=source.indexOf("      if (ev?.type === 'tool_result') {",source.indexOf('  const interjecoes = [];'));
const eventEnd=source.indexOf('      // Mensagem que o usuário',eventStart);
assert.ok(eventStart>0&&eventEnd>eventStart);const onEvent=new Function('ev','routineCheck','toolCounts',source.slice(eventStart,eventEnd));
const result=await runAgent({provider:{name:'mock',complete:async()=>++step===1?{stop:'tool',toolCalls:[{id:'c',name:'consultar',args:{}}]}:{stop:'end',text:ROUTINE_NO_NEWS}},tools:reg,system:'Mock',history:[],userInput:'Só avisar se houver novidades',onEvent:ev=>onEvent(ev,routineCheck,toolCounts)});
eq(step,2);eq(routineCheck,{completed:true,failed:false});
const body=routineFinalText(result.text,{kind:'routine',...routineCheck});eq(body,'');
let deliveries=[];
const {deliverRoutine:deliver}=createScheduledDelivery({sendEmail:denied,
 getTelegramBotForDelivery:async()=>({token:'synthetic',chat_id:'1'}),
 sendTelegramMessage:async(token,chatId,text)=>{deliveries.push([chatId,text]);return {message_id:deliveries.length};},persistProactiveToThread:async()=>{}});
for(const channel of ['whatsapp','telegram','email','none'])await deliver({channel},body);eq(deliveries,[]);
await deliver({channel:'telegram'},'Resultado útil');eq(deliveries.length,1);
const partial=turnSearchCoverage();partial.observe(true);await deliver({channel:'telegram'},partial.finish(body,'pt-BR'));eq(deliveries.length,2);ok(deliveries.at(-1)[1].includes('Não consegui concluir parte da busca'));
for(const ev of [{type:'tool_result',out:'ERRO mock'},{type:'tool_result',out:{ok:false}},{type:'max_steps'},{type:'loop_break'},{type:'salvage_error'}]){const r={completed:true,failed:false};onEvent(ev,r,{});eq(r.failed,true);ok(routineFinalText(ROUTINE_NO_NEWS,{kind:'routine',...r}).length>0);}
console.log(`OK: ${checks} verificações de rotinas, envio/contexto e silêncio condicional; zero I/O real.`);
