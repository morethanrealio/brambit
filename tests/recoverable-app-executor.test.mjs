import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ToolRegistry} from '../core-proto/core.mjs';
import {filePage} from '../core-proto/file-page.mjs';
import {searchAppCode} from '../web/app-code-search.mjs';
import {runAppTask,closeTaskHistory,makeAppTaskControlTool} from '../web/app-task-runner.mjs';
import {makeConstruirAppTool} from '../web/coding-subagent.mjs';
import {gateTool,takePending,isReactionConfirmable} from '../web/confirm.mjs';
import {createAppBuildJournal} from '../web/app-build-state.mjs';
let checks=0;const ok=x=>{assert.ok(x);checks++;};const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const b64=s=>Buffer.from(s).toString('base64'),hash=s=>createHash('sha256').update(s).digest('hex').slice(0,12);
function memory(){const records=new Map();return {records,async withTask(k,fn){return fn({id:hash(k),record:structuredClone(records.get(k)||null),save:async r=>records.set(k,structuredClone(r))});}};}
const step=(name,args={},id='1')=>({stop:'tool',toolCalls:[{name,args,id}],usage:{in:100,out:20}});
const end={stop:'end',text:'Parecer parcial, não publicado.',usage:{in:100,out:20}};
const seq=a=>({name:'fixture',complete:async()=>{ok(a.length>0);return a.shift();}});
function registry(){let writes=0,reads=0;const r=new ToolRegistry();r.add({name:'listar_arquivos_do_app',parameters:{},run:async()=>({ok:true,arquivos:[]})});
 r.add({name:'ler_arquivo_do_app',parameters:{},run:async a=>{reads++;const content='function marker() {}';return filePage({content,hash:hash(content),arquivo:a.caminho,bytes:content.length});}});
 r.add({name:'validar_rascunho_do_app',parameters:{},run:async()=>({ok:true,revisao:'a'.repeat(64),validacao:'aprovado',lint_erros:[],lint_avisos:[],omitidos:0})});
 for(const name of ['escrever_arquivo_do_app','definir_segredo','chamar_sistema','publicar_sistema'])r.add({name,parameters:{},run:async()=>{writes++;return {ok:true,hash:'new'};}});
 return {r,get writes(){return writes;},get reads(){return reads;}};
}
const text='x'.repeat(51000)+'\nfunction target() {}\n'+Array.from({length:70},(_,i)=>`// target ${i}`).join('\n'),files={'public/game.js':b64(text)};
let s=searchAppCode(files,{texto:'target',limite:20});ok(s.ok);eq(s.resultados[0].linha,2);ok(s.resultados[0].inicio>50000);let found=s.resultados.length;
while(s.proximo_inicio!==null){s=searchAppCode(files,{texto:'target',limite:20,inicio:s.proximo_inicio,revisao_esperada:s.revisao});ok(s.ok);found+=s.resultados.length;ok(JSON.stringify(s).length<19000);}eq(found,71);
for(const args of [{texto:'target',inicio:1},{texto:'target',revisao_esperada:'stale'},{texto:'x',caminho:'../private'},{texto:'x',limite:51},{texto:'x\nx'},{texto:'x',inicio:-1}])eq(searchAppCode(files,args).ok,false);
eq(searchAppCode(files,{texto:'.*'}).resultados.length,0);eq(searchAppCode(files,{texto:'x',caminho:'missing'}).ok,false);
{
 const f=registry(),store=memory();let i=0,usage=0;
 const provider={name:'fixture',complete:async input=>{i++;if(i<=45)return step('ler_arquivo_do_app',{caminho:`part${i}.js`},String(i));if(i===46)return step('validar_rascunho_do_app',{},'v');
 if(i===47){const ids=JSON.parse(input.messages.filter(x=>x.name==='ler_arquivo_do_app').at(-1).content).evidencias;return step('registrar_parecer_do_app',{itens:[{assunto:'Função marker',avaliacao:'sem_problema_observado',observacao:'A declaração está presente no trecho consultado.',evidencias:ids}]},'report');}return end;}};
 const tool=makeConstruirAppTool({sessionKey:'u:a:t',taskStore:store,onUsage:()=>usage++,buildAppContext:async()=>({tools:f.r,provider})});
 const first=await tool.run({app:'demo',objetivo:'Conferir os arquivos.'});eq(first.app_build.motivo,'execution_quantum');eq(i,40);
 const out=await tool.run({app:'demo',objetivo:'Conferir os arquivos.'});eq(out.app_build.version,2);eq(out.app_build.modo,'revisao');eq(out.app_build.motivo,'completed');eq(i,48);eq(usage,48);eq(f.writes,0);eq(f.reads,45);eq(out.app_build.parecer.length,1);
 const journal=createAppBuildJournal({technicalDetails:true});journal.toolResult({name:'construir_app'},out);const rendered=journal.finish('Tudo funciona e foi publicado!');ok(rendered.includes('Função marker'));ok(!rendered.includes('Tudo funciona'));ok(rendered.includes('não confirma'));eq(journal.blockPublish(),null);
 for(const language of ['en','es']){const j=createAppBuildJournal({language,technicalDetails:true});j.toolResult({name:'construir_app'},out);ok(j.finish('').length>100);}
}
{
 const f=registry();let n=0;const result=await runAppTask({store:memory(),scope:'review',objetivo:'Confira',tools:f.r,system:'fixture',provider:{name:'f',complete:async({tools})=>{ok(!tools.some(x=>x.name==='chamar_sistema'));ok(!tools.some(x=>x.name==='escrever_arquivo_do_app'));return n++===0?step('escrever_arquivo_do_app',{caminho:'a.js'}):end;}}});eq(result.app_build.motivo,'completed');eq(f.writes,0);
}
{
 const store=memory(),f=registry();const a=await runAppTask({store,scope:'same',objetivo:'Confira',tools:f.r,system:'fixture',limits:{calls:2},provider:seq([step('ler_arquivo_do_app',{caminho:'a.js'}),step('ler_arquivo_do_app',{caminho:'b.js'})])});
 eq(a.app_build.orcamento.chamadas,2);let invoked=0;
 const b=await runAppTask({store,scope:'same',objetivo:'Novo texto continua',tools:f.r,system:'fixture',limits:{calls:2},provider:{name:'f',complete:async()=>{invoked++;return end;}}});eq(invoked,0);eq(b.app_build.motivo,'task_budget');eq(f.reads,2);
}
{
 const f=registry();let paused=0,calls=0;const r=await runAppTask({store:memory(),scope:'cancel',objetivo:'x',tools:f.r,system:'x',shouldPause:async()=>++paused===2,provider:{name:'f',complete:async()=>{calls++;return step('ler_arquivo_do_app',{caminho:'a.js'});}}});eq(calls,1);eq(r.app_build.motivo,'new_user_input');eq(f.reads,1);
}
{
 const h=closeTaskHistory([{role:'assistant',toolCalls:[{id:'a',name:'read'},{id:'b',name:'write'}]},{role:'tool',toolCallId:'a',name:'read',content:'ok'}]);eq(h.length,3);ok(h[2].content.includes('não executada'));
 const store=memory(),f=registry();await runAppTask({store,scope:'uncertain',objetivo:'edit',mode:'edicao',tools:f.r,system:'x',provider:seq([end])});const task=store.records.get('uncertain');task.status='paused';task.pending={mutating:true,name:'write'};let count=0;
 const out=await runAppTask({store,scope:'uncertain',objetivo:'continua',mode:'edicao',tools:f.r,system:'x',provider:{name:'f',complete:async()=>{count++;return end;}}});eq(count,0);eq(out.app_build.motivo,'uncertain_action');eq(f.writes,0);
}
{
 const f=registry(),store=memory();let n=0;
 const provider={name:'f',complete:async({messages})=>{n++;if(n===1)return step('registrar_parecer_do_app',{itens:[{assunto:'fake',avaliacao:'sem_problema_observado',observacao:'publiquei tudo',evidencias:[]}]});
 if(n===2){eq(JSON.parse(messages.at(-1).content).ok,false);return step('ler_arquivo_do_app',{caminho:'a.js'});}
 if(n===3){const ids=JSON.parse(messages.at(-1).content).evidencias;return step('registrar_parecer_do_app',{itens:[{assunto:'marker',avaliacao:'sem_problema_observado',observacao:'Declaração encontrada.',evidencias:ids}]});}return end;}};
 const out=await runAppTask({store,scope:'report',objetivo:'review',tools:f.r,system:'x',provider,shouldPause:async()=>n>=3});eq(out.app_build.motivo,'new_user_input');eq(out.app_build.parecer.length,1);const j=createAppBuildJournal({technicalDetails:true});j.toolResult({name:'construir_app'},out);ok(j.finish('').includes('Declaração encontrada'));ok(j.blockPublish());
}
// Authorization is checked before loading persisted private context.
{
 const f=registry();f.r.map.get('listar_arquivos_do_app').run=async()=>({ok:false});let touched=0;
 const out=await runAppTask({store:{withTask:()=>{touched++;}},scope:'no',objetivo:'x',tools:f.r,provider:{complete:()=>{touched++;}}});eq(touched,0);eq(out.app_build.motivo,'access_denied');
}
// Lifecycle controls preserve accumulated usage and never replay an uncertain effect.
{
 const f=registry(),store=memory(),scope=JSON.stringify(['s','demo','']);
 await runAppTask({store,scope,objetivo:'x',tools:f.r,system:'x',limits:{calls:1},provider:seq([step('ler_arquivo_do_app',{caminho:'a'})])});
 const before=store.records.get(scope).calls;const control=makeAppTaskControlTool({store,sessionKey:'s',authorize:async()=>true});
 const renewed=await control.run({app:'demo',acao:'renovar_orcamento'});eq(renewed.ok,false);eq(store.records.get(scope).calls,before);eq(store.records.get(scope).extraBudget,undefined);
 const canceled=await control.run({app:'demo',acao:'cancelar'});ok(canceled.ok);eq(store.records.get(scope).status,'cancelled');
 const denied=makeAppTaskControlTool({store,sessionKey:'s',authorize:async()=>false});eq((await denied.run({app:'demo',acao:'cancelar'})).ok,false);
}
// Real between-step compaction with a large restored context, not a toy summary helper.
{
 const store=memory(),f=registry();await runAppTask({store,scope:'compact',objetivo:'Original objective',tools:f.r,system:'x',provider:seq([end])});
 const task=store.records.get('compact');task.status='paused';task.history=Array.from({length:24},(_,i)=>({role:i%2?'assistant':'user',content:'context '+i+' '+ 'x'.repeat(10000)}));
 let main=0,compacts=0,compactionBill=0;const out=await runAppTask({store,scope:'compact',objetivo:'Continue',tools:f.r,system:'x',onUsage:u=>{if(u.kind==='compact'){ok(u.noBill);compactionBill++;}},provider:{name:'f',complete:async({system,messages})=>{
  if(system.startsWith('Resuma')){compacts++;return {...end,text:'Revisão parcial. Falta outro arquivo.'};}
  main++;if(main>8)ok(messages[0].content.includes('Original objective'));
  return main<11?step('ler_arquivo_do_app',{caminho:'part'+main+'.js'},String(main)):end;
 }}});eq(out.app_build.motivo,'report_rejected');eq(compacts,1);eq(compactionBill,1);
}
{
 let ran=0;const tool=gateTool({name:'gerenciar_tarefa_de_app',parameters:{},run:async()=>{ran++;return {ok:true};}},'fixture-task-control');
 const out=await tool.run({app:'demo',acao:'renovar_orcamento'});eq(ran,0);ok(String(out).includes('CONFIRMAÇÃO'));ok(takePending('fixture-task-control'));eq(isReactionConfirmable('gerenciar_tarefa_de_app'),false);
}
console.log(`PASS ${checks} recoverable executor checks (offline)`);
