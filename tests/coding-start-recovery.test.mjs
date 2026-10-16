// Synthetic providers/tools only. Run with the workspace I/O blocker.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { runAgent, ToolRegistry } from '../core-proto/core.mjs';
import { makeDeepSeekFlash } from '../core-proto/deepseek/provider.mjs';
import { codingPromise, executionSignature } from '../core-proto/turn-recovery.mjs';
import { makeConstruirAppTool } from '../web/coding-subagent.mjs';
import { gateTool, takePending } from '../web/confirm.mjs';
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const defs=[{name:'construir_app',parameters:{type:'object'}}];
const promise='Vou construir a Fase 1 agora e já te aviso quando estiver pronta pra publicar. Deixa comigo.';
for (const s of [promise,'Estou construindo o lobby.','Tô programando o app.','Já comecei a implementar o multiplayer agora.','Vou codar agora.','Vamos implementar isso agora.']) ok(codingPromise(s,defs),s);
for (const s of ['Vou construir depois da sua confirmação.','Se você quiser, vou construir agora.','Posso construir agora?','Não estou construindo o app.','> Estou construindo o app.','"Estou construindo o app."','```js\nEstou construindo o app.\n```','Exemplo:\nEstou construindo o app.','Rascunho: Vou codar agora.','O lobby está pronto no rascunho. Posso publicar?','Na próxima etapa, vamos desenvolver o multiplayer.','Ela está construindo o app.','Já comecei a implementar o multiplayer ontem.']) eq(codingPromise(s,defs),false);
eq(codingPromise(promise,[]),false);
eq(executionSignature({name:'x',args:{a:1,b:{z:2,y:3}}}),executionSignature({name:'x',args:{b:{y:3,z:2},a:1}}));
ok(executionSignature({name:'x',args:{s:'a'.repeat(500)+'x'}})!==executionSignature({name:'x',args:{s:'a'.repeat(500)+'y'}}));
const response=(msg,finish='stop')=>new Response(JSON.stringify({choices:[{message:msg,finish_reason:finish}],usage:{prompt_tokens:30,completion_tokens:4,total_tokens:34}}));
const tc=(name='construir_app',args={objetivo:'No app fictício ocean-demo, implemente coop e pontos individuais.'},id='t1')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
// Malformed on purpose (broken JSON): refused by the common rules. An unknown NAME is not
// a refusal any more (the core answers "tool desconhecida"), so it can't trigger repair.
const quebrada=(name='construir_app')=>({id:'b',type:'function',function:{name,arguments:'{'}});
const providerFor=(sequence)=>{let calls=0;const bodies=[];return {get calls(){return calls;},bodies,p:makeDeepSeekFlash({secret:async()=>'SYNTHETIC',request:async(url,opts)=>{eq(String(url),'https://api.deepseek.com/chat/completions');bodies.push(JSON.parse(opts.body));const item=sequence[calls++];ok(item,'Unexpected request');return response(item.message,item.finish);}})};};
const userInput='Coop, com pontuação por jogador. Pode implementar o rascunho; não publique.';
// Whole batch validation: one valid call followed by ANY invalid member -> zero executes.
for (const [bad,code] of [
 [{function:{name:'construir_app',arguments:'{}'}},'missing_call_id'],
 [{id:'bad',function:{arguments:'{}'}},'invalid_tool_name'],
 [{id:'bad',function:{name:'construir_app',arguments:'{'}},'invalid_json_args'],
 [{id:'bad',function:{name:'construir_app',arguments:'[]'}},'invalid_args_shape'],
 [tc('construir_app',{},'valid'),'duplicate_call_id']
]) {
 let runs=0;const reg=new ToolRegistry().add({name:'construir_app',parameters:{type:'object'},run:async()=>{runs++;return 'Rascunho pronto, não publicado.';}});
 const f=providerFor([{message:{tool_calls:[tc('construir_app',{},'valid'),bad]}},{message:{tool_calls:[tc()]}},{message:{content:'Rascunho pronto; publicação não executada.'}}]);
 const events=[];const r=await runAgent({provider:f.p,tools:reg,userInput,system:'fixture',maxSteps:5,onEvent:e=>events.push(e)});
 eq(runs,1);eq(f.calls,3);eq(r.usages.length,3);eq(events.find(e=>e.type==='provider_protocol_error').code,code);
 ok(f.bodies[1].messages[0].content.includes('protocol recovery'));ok(f.bodies[1].messages.some(m=>m.content===userInput));
 eq(r.messages.at(-1).content,r.text);ok(!r.text.includes('inválida'));
}
// Non-array calls and unstructured markup are typed; output length rejects the entire batch and permits one bounded core repair.
for(const [msg,finish,code] of [[{tool_calls:{}},'stop','invalid_calls_shape'],[{content:'<tool_call>SECRET</tool_call>'},'stop','unstructured_tool_call'],[{tool_calls:[tc()]},'length','output_truncated']]){
 const f=providerFor([{message:msg,finish}]);const r=await f.p.complete({messages:[],tools:defs});eq(r.protocolError?.code||null,code);eq(r.toolCalls,undefined);eq(f.calls,1);
}
// Rejection repaired only once; previous valid reads do not become "nothing executed".
{
 let reads=0;const reg=new ToolRegistry().add({name:'abrir_ferramentas',parameters:{},run:async()=>{reads++;return 'Grupo já aberto.';}});
 const bad={tool_calls:[quebrada('abrir_ferramentas')]};const f=providerFor([{message:{tool_calls:[tc('abrir_ferramentas',{},'open')]}},{message:bad},{message:bad}]);
 const r=await runAgent({provider:f.p,tools:reg,userInput,maxSteps:8});eq(f.calls,3);eq(reads,1);eq(r.usages.length,3);ok(r.text.includes('chamadas anteriores'));ok(!r.text.includes('Nenhuma ferramenta'));eq(r.messages.at(-1).content,r.text);
}
// At last step no retry/salvage that could run more tools or invent a ceiling failure.
{
 const f=providerFor([{message:{tool_calls:[quebrada()]}}]);const r=await runAgent({provider:f.p,tools:new ToolRegistry(),userInput,maxSteps:1});eq(f.calls,1);ok(r.text.includes('formato inválido'));ok(!r.text.includes('grande'));
}
// Actual observed sequence: promise first, recovery invokes builder with preserved requirements.
for (const account of ['fixture-account-A','fixture-account-B']) {
 let runs=0;const reg=new ToolRegistry().add({name:'construir_app',parameters:{type:'object'},run:async args=>{runs++;ok(args.objetivo.includes('coop'));ok(args.objetivo.includes('pontos individuais'));return 'Rascunho feito; nada publicado.';}});
 const f=providerFor([{message:{content:promise}},{message:{tool_calls:[tc()]}},{message:{content:'Lobby no rascunho, solo preservado. Posso publicar?'}}]);const events=[];
 const r=await runAgent({provider:f.p,tools:reg,userInput,system:account,onEvent:e=>events.push(e)});
 eq(runs,1);eq(f.calls,3);ok(f.bodies[1].messages[0].content.includes('answer NOT sent yet'));ok(f.bodies[1].messages.some(m=>m.content===userInput));
 eq(events.filter(e=>e.type==='coding_promise_blocked').length,1);ok(!events.some(e=>['end','assistant'].includes(e.type)&&e.text===promise));ok(!r.messages.some(m=>m.content===promise));eq(r.messages.at(-1).content,r.text);
}
// Failed repair cannot create infinite promises; no fake background job.
{
 const f=providerFor([{message:{content:promise}},{message:{content:promise}}]);let runs=0;
 const reg=new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{runs++;}});const r=await runAgent({provider:f.p,tools:reg,userInput,maxSteps:9});eq(f.calls,2);eq(runs,0);ok(r.text.includes('Não iniciei'));ok(!r.text.includes('te aviso'));ok(r.text.includes('Não vou te pedir'));
}
// Execution already returned: don't run coding again just to make the promise true.
for (const result of ['Rascunho atualizado.','ERRO: indisponível']) {
 let runs=0;const reg=new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{runs++;return result;}});
 const f=providerFor([{message:{tool_calls:[tc()]}},{message:{content:'Estou construindo o lobby.'}}]);
 const r=await runAgent({provider:f.p,tools:reg,userInput});eq(runs,1);eq(f.calls,2);ok(r.text.includes('chamada de programação'));eq(r.messages.at(-1).content,r.text);
}
// Repair must never replay a previous identical action (including reordered JSON).
{
 let writes=0;const reg=new ToolRegistry().add({name:'write',parameters:{},run:async()=>{writes++;return 'written';}});
 const f=providerFor([{message:{tool_calls:[tc('write',{a:1,b:2},'one')]}},{message:{tool_calls:[quebrada('write')]}},{message:{tool_calls:[tc('write',{b:2,a:1},'two')]}}]);
 const r=await runAgent({provider:f.p,tools:reg,userInput});eq(writes,1);ok(r.text.includes('Bloqueei a repetição'));eq(r.usages.length,3);
}
// Cancellation arriving after a promise discards it before automatic repair.
{
 let polls=0,complete=0,runs=0;const reg=new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{runs++;}});
 const r=await runAgent({provider:{name:'offline',complete:async({messages})=>{complete++;if(complete===1)return {stop:'end',text:promise};ok(messages.some(m=>m.raw==='Cancele. Não altere nada.'));return {stop:'end',text:'Certo, não iniciei alterações.'};}},tools:reg,userInput,pollNewUserMsg:async()=>++polls===2?'Cancele. Não altere nada.':null});
 eq(runs,0);eq(complete,2);ok(r.text.includes('não iniciei'));
}
// Late cancellation is also read on the boundary after malformed protocol.
{
 let polls=0,runs=0;const f=providerFor([{message:{tool_calls:[quebrada()]}},{message:{content:'Certo, não iniciei alterações.'}}]);const reg=new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{runs++;}});
 await runAgent({provider:f.p,tools:reg,userInput,pollNewUserMsg:async()=>++polls===2?'Cancele. Não altere nada.':null});eq(runs,0);ok(f.bodies[1].messages.some(m=>m.content?.includes('Cancele. Não altere nada.')));
}
// Publication remains gated even after repair. No permission manufactured by a note.
{
 let publishes=0;const reg=new ToolRegistry().add(gateTool({name:'publicar_sistema',parameters:{},description:'fixture',run:async()=>{publishes++;return 'published';}},'fixture-recovery-gate'));
 const f=providerFor([{message:{tool_calls:[quebrada()]}},{message:{tool_calls:[tc('publicar_sistema',{nome_do_sistema:'ocean-demo'})]}},{message:{content:'Posso publicar esse rascunho?'}}]);
 const r=await runAgent({provider:f.p,tools:reg,userInput});eq(publishes,0);ok(r.messages.some(m=>m.role==='tool'&&m.content.includes('PENDENTE')));ok(takePending('fixture-recovery-gate'));
}
// Real construir_app wrapper -> real nested core -> synthetic edits only.
{
 let edits=0,nestedCalls=0,mainCalls=0;const subReg=new ToolRegistry().add({name:'escrever_arquivo_do_app',parameters:{},run:async()=>{edits++;return {ok:true};}});
 const builder=makeConstruirAppTool({sessionKey:'fixture-build-recovery',compact:false,buildAppContext:async()=>({tools:subReg,provider:{name:'offline-sub',complete:async({messages})=>{nestedCalls++;ok(messages.some(m=>m.content?.includes('coop')));return nestedCalls===1?{stop:'tool',toolCalls:[{id:'edit',name:'escrever_arquivo_do_app',args:{caminho:'lobby.js'}}]}:{stop:'end',text:'Rascunho pronto, não publicado.'};}}})});
 const r=await runAgent({tools:new ToolRegistry().add(builder),userInput,provider:{name:'offline-main',complete:async()=>{mainCalls++;return mainCalls===1?{stop:'end',text:promise}:mainCalls===2?{stop:'tool',toolCalls:[{id:'build',name:'construir_app',args:{app:'ocean-demo',objetivo:'coop, pontuação individual, preservar solo'}}]}:{stop:'end',text:'Rascunho pronto. Posso publicar?'};}}});
 eq(edits,1);eq(nestedCalls,2);eq(mainCalls,3);ok(r.text.includes('Posso publicar'));
}
// Salvage cannot reintroduce fake background work.
{
 let calls=0;const reg=new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=> 'Rascunho pronto.'});
 const r=await runAgent({provider:{name:'offline',complete:async()=>++calls===1?{stop:'tool',toolCalls:[{id:'x',name:'construir_app',args:{}}]}:{stop:'end',text:promise}},tools:reg,userInput,maxSteps:1});eq(calls,2);ok(r.text.includes('chamada de programação'));eq(r.messages.at(-1).content,r.text);
}
// Ordinary clarification, success and noncoding turns are unchanged and have no extra call.
for(const text of ['Coop ou versus?','Você quer pontuação individual?','Rascunho pronto. Posso publicar?','Não consegui ler o arquivo: preciso do nome do app.']){
 let n=0;const r=await runAgent({provider:{name:'offline',complete:async()=>{n++;return {stop:'end',text};}},tools:new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{throw Error('not expected');}}),userInput});eq(n,1);eq(r.text,text);
}
// Metering is retained; billing/auth failure is not retried, transient 429/503 is (common rule, 4 attempts).
for(const status of [401,402,429,503]){
 let n=0;const p=makeDeepSeekFlash({secret:async()=>'SYNTHETIC',request:async()=>{n++;return new Response('PRIVATE',{status});}});
 await assert.rejects(()=>runAgent({provider:p,tools:new ToolRegistry(),userInput}),/DeepSeek HTTP/);eq(n,[429,503].includes(status)?4:1);
}
// Service failure during repair preserves prior usage/history (the 429 is retried, then gives up).
{
 let n=0;const p=makeDeepSeekFlash({secret:async()=>'SYNTHETIC',request:async()=>{n++;if(n===1)return response({tool_calls:[quebrada()]});return new Response('PRIVATE_ERROR',{status:429});}});
 const r=await runAgent({provider:p,tools:new ToolRegistry(),userInput});eq(n,5);eq(r.usages.length,1);ok(r.text.includes('serviço de geração falhou'));ok(!r.text.includes('PRIVATE_ERROR'));eq(r.messages.at(-1).content,r.text);
}
// Both recovery classes have separate one-shot caps and share the same step budget.
{
 let writes=0;const reg=new ToolRegistry().add({name:'construir_app',parameters:{},run:async()=>{writes++;return 'feito';}});
 const f=providerFor([{message:{content:promise}},{message:{tool_calls:[quebrada()]}},{message:{tool_calls:[tc()]}},{message:{content:'Rascunho pronto.'}}]);
 const r=await runAgent({provider:f.p,tools:reg,userInput,maxSteps:4});eq(f.calls,4);eq(writes,1);eq(r.usages.length,4);eq(r.text,'Rascunho pronto.');
}
// An actual gate refusal remains a proposal, not an action executed by recovery.
// Available tool definitions are read on every step (progressive disclosure).
{
 const reg=new ToolRegistry();let writes=0,calls=0;
 reg.add({name:'abrir_ferramentas',parameters:{},run:async()=>{reg.add({name:'construir_app',parameters:{},run:async()=>{writes++;return 'feito';}});return 'Grupo aberto';}});
 const r=await runAgent({tools:reg,userInput,maxSteps:6,provider:{name:'fixture',complete:async({tools})=>{
  calls++;if(calls===1)return {stop:'tool',toolCalls:[{id:'open',name:'abrir_ferramentas',args:{}}]};
  ok(tools.some(t=>t.name==='construir_app'));
  if(calls===2)return {stop:'end',text:promise};
  if(calls===3)return {stop:'tool',toolCalls:[{id:'build',name:'construir_app',args:{}}]};
  return {stop:'end',text:'Rascunho pronto.'};
 }}});eq(writes,1);eq(calls,4);ok(r.text.includes('pronto'));
}
// Fresh conversations also recover: promise -> open code group -> build -> final.
{
 let calls=0,writes=0;const reg=new ToolRegistry().add({name:'abrir_ferramentas',parameters:{},run:async()=>{reg.add({name:'construir_app',parameters:{},run:async()=>{writes++;return 'feito';}});return 'Grupo aberto';}});
 const r=await runAgent({tools:reg,userInput,maxSteps:6,provider:{name:'offline',complete:async({system,tools})=>{
  calls++;ok(system.includes('abrir_ferramentas'));
  if(calls===1)return {stop:'end',text:promise};
  if(calls===2)return {stop:'tool',toolCalls:[{id:'open',name:'abrir_ferramentas',args:{grupo:'codigo'}}]};
  if(calls===3){ok(tools.some(t=>t.name==='construir_app'));return {stop:'tool',toolCalls:[{id:'build',name:'construir_app',args:{}}]};}
  return {stop:'end',text:'Rascunho pronto.'};
 }}});eq(writes,1);eq(calls,4);eq(r.text,'Rascunho pronto.');
}
const source=readFileSync('web/server.mjs','utf8');ok(source.includes('[turn_recovery] thread='));ok(source.includes('repair_replay_blocked'));ok(!source.includes('JSON.stringify(ev.protocolError)'));
console.log(`PASS ${checks} recovery checks: real adapter/core/builder/gate; no external I/O, live user, DB or app writes.`);
