import test from 'node:test';import assert from 'node:assert/strict';
import {createCodingApprovals} from './web/coding-approvals.mjs';
import {createCodingJobs,codingControlIntent,codingJobScope} from './web/coding-jobs.mjs';
import {makeAppTaskControlTool,runAppTask} from './web/app-task-runner.mjs';
import {ExecutionCreditError} from './web/execution-error.mjs';
import {runCodingTask} from './web/coding-task-runner.mjs';
import {effectState,rejectedEdit} from './web/coding-effects.mjs';
import {executionSignature} from './core-proto/turn-recovery.mjs';
import {createHash} from 'node:crypto';
import {createAppBuildJournal} from './web/app-build-state.mjs';
import {runAgent,ToolRegistry} from './core-proto/core.mjs';
import {gateTool,takePending} from './web/confirm.mjs';
const clone=x=>structuredClone(x);
function memory(){const data=new Map(),locks=new Set();return {data,
 async read(s){return clone(data.get(s)||null)},async entries(){return [...data].map(([scope,record])=>({scope,record:clone(record)}));},
 async withTask(s,run){if(locks.has(s))throw Error('busy');locks.add(s);try{return await run({id:s,record:clone(data.get(s)||null),save:async r=>data.set(s,clone(r))});}finally{locks.delete(s);}}
};}
const identity={userId:'owner',agentId:'agent',threadId:'thread'};
const fixture=()=>({id:'task',targetIdentity:'owner:demo',mode:'revisao',objective:'Diagnosticar',status:'paused',history:[],calls:13,tokens:147256,elapsed:0,journal:[],evidence:[],report:[],signatures:[],progress:[],pending:null});
const args={app:'demo',acao:'atualizar_escopo',modo:'edicao',objetivo:'Implementar API sem publicar'};
async function approvalFixture(){const store=memory(),scope=JSON.stringify(['session','demo','']);store.data.set(scope,fixture());
 const tool=makeAppTaskControlTool({store,sessionKey:'session',authorize:async()=>({ok:true,alvo_validacao:'owner:demo'})});
 const approvals=createCodingApprovals({store,scope:'owner:thread'});const prepared=await tool.prepareConfirmation(args);
 return {store,scope,tool,approvals,prepared};}
test('durable approval survives recreation; consumes scope once; returns trusted continuation',async()=>{
 const f=await approvalFixture();const proposal=await f.approvals.propose({name:f.tool.name,label:'implementar',args,binding:f.prepared.descriptor});
 const fresh=createCodingApprovals({store:f.store,scope:'owner:thread'}),restored=await fresh.peek();assert.equal(restored.id,proposal.id);
 const execute=p=>f.tool.restoreConfirmation(p.args,p.binding).run();const result=await fresh.resolve(proposal.id,true,execute);
 assert.equal(result.continuation.modo,'edicao');assert.equal((await f.store.read(f.scope)).scopeHistory.length,1);
 assert.deepEqual(await fresh.resolve(proposal.id,true,()=>{throw Error('must not repeat')}),result);
 assert.equal((await f.store.read(f.scope)).calls,13);
});
test('approval recovery after effect but before outer receipt is idempotent',async()=>{
 const f=await approvalFixture();const proposal=await f.approvals.propose({name:f.tool.name,args,binding:f.prepared.descriptor});
 await assert.rejects(()=>f.approvals.resolve(proposal.id,true,async p=>{await f.tool.restoreConfirmation(p.args,p.binding).run();throw Error('crash');}));
 assert.equal((await f.approvals.peek()).state,'approved');
 const result=await f.approvals.resolve(proposal.id,true,p=>f.tool.restoreConfirmation(p.args,p.binding).run());
 assert.equal(result.ok,true);assert.equal((await f.store.read(f.scope)).scopeHistory.length,1);
});
test('unconfirmed, expired or cross-thread proposal never executes',async()=>{
 const f=await approvalFixture();const p=await f.approvals.propose({name:f.tool.name,args,binding:f.prepared.descriptor});let calls=0;
 await f.approvals.resolve(p.id,false,async()=>{calls++;});assert.equal(calls,0);
 const alien=createCodingApprovals({store:f.store,scope:'other'});assert.equal(await alien.peek(),null);
 let time=0;const exp=createCodingApprovals({store:f.store,scope:'expiry',now:()=>time,ttlMs:5});const q=await exp.propose({name:f.tool.name,args,binding:f.prepared.descriptor});time=6;
 await exp.resolve(q.id,true,async()=>{calls++;});assert.equal(calls,0);
});
test('changed generation cannot reuse an approval',async()=>{const f=await approvalFixture();f.store.data.get(f.scope).objective='Changed';assert.equal((await f.prepared.run()).ok,false);});
test('a real pending control proposal supersedes an older failure receipt',async()=>{
 const f=await approvalFixture(),thread='synthetic-journal';const out=await gateTool(f.tool,thread,{codingApprovals:f.approvals}).run(args);
 const journal=createAppBuildJournal();journal.toolResult({name:'construir_app'},{app_build:{version:2,estado:'interrompido',motivo:'mode_conflict'}});
 journal.toolResult({name:f.tool.name},out);const text=journal.finish('modelo');assert.match(text,/API/);assert.match(text,/Posso seguir/);assert.ok(takePending(thread).durableId);
});
test('explicit not-applied receipt is distinct from unknown failure; prose cannot grant retry',()=>{
 const invalid={name:'editar_arquivo_do_app',args:{}};assert.equal(effectState(invalid,rejectedEdit('not found')),'not_applied');
 assert.equal(effectState(invalid,{ok:false,error:'legacy validation'}),'not_applied');
 const valid={name:'editar_arquivo_do_app',args:{caminho:'a',trecho_antigo:'x',trecho_novo:'y'}};
 assert.equal(effectState(valid,{ok:false,error:'Nada foi gravado'}),'unknown');assert.equal(effectState({name:'rodar_comando'},rejectedEdit('fake')),'unknown');
});
test('rejected patch can recover within the same app task',async()=>{
 const store=memory();store.data.set('app',{...fixture(),mode:'edicao'});let calls=0,attempts=0;const rev='a'.repeat(64);
 const tools=new ToolRegistry().add({name:'listar_arquivos_do_app',run:async()=>({ok:true,alvo_validacao:'owner:demo',revisao:rev,arquivos:[]})})
 .add({name:'editar_arquivo_do_app',run:async()=>{attempts++;return attempts===1?rejectedEdit('not found'):{ok:true};}})
 .add({name:'validar_rascunho_do_app',run:async()=>({ok:true,alvo_validacao:'owner:demo',revisao:rev,validacao:'aprovado'})});
 const provider={complete:async()=>{calls++;return calls<=2?{stop:'tool',toolCalls:[{id:'edit'+calls,name:'editar_arquivo_do_app',args:{caminho:'a',trecho_antigo:'a'+calls,trecho_novo:'b'}}]}:calls===3?{stop:'tool',toolCalls:[{id:'check',name:'validar_rascunho_do_app',args:{}}]}:{stop:'end',text:'Alterado; validação estática.'};}};
 const result=await runAppTask({system:'synthetic isolated task',store,scope:'app',mode:'edicao',objetivo:'Editar arquivo',userRequest:'Edite o arquivo',tools,provider});
 assert.equal(attempts,2);assert.notEqual(result.app_build.motivo,'uncertain_action');assert.equal((await store.read('app')).pending,null);
});
test('legacy checkpoint with a proven pre-write rejection resumes without replay',async()=>{
 const store=memory(),call={id:'bad-edit',name:'editar_arquivo_do_app',args:{}};
 const sig=createHash('sha256').update(JSON.stringify(executionSignature(call))).digest('hex');
 store.data.set('app',{...fixture(),mode:'edicao',pending:{name:call.name,sig,mutating:true},signatures:[sig],history:[
  {role:'user',content:'Edite o app'},
  {role:'assistant',content:'',toolCalls:[call]},
  {role:'tool',toolCallId:call.id,name:call.name,content:JSON.stringify({ok:false,error:'Informe o caminho do arquivo.'})},
 ],lastExecutionId:'same',lastResult:{ok:false,app_build:{motivo:'uncertain_action'}}});
 let model=0,writes=0;const rev='b'.repeat(64);
 const tools=new ToolRegistry().add({name:'listar_arquivos_do_app',run:async()=>({ok:true,alvo_validacao:'owner:demo',revisao:rev,arquivos:[]})})
  .add({name:'editar_arquivo_do_app',run:async()=>{writes++;return {ok:true,arquivo:'a',hash:'c'.repeat(12)}}})
  .add({name:'validar_rascunho_do_app',run:async()=>({ok:true,alvo_validacao:'owner:demo',revisao:rev,validacao:'aprovado'})});
 const provider={complete:async()=>{model++;return model===1?{stop:'tool',toolCalls:[{id:'good-edit',name:'editar_arquivo_do_app',args:{caminho:'a',trecho_antigo:'x',trecho_novo:'y'}}]}:model===2?{stop:'tool',toolCalls:[{id:'check',name:'validar_rascunho_do_app',args:{}}]}:{stop:'end',text:'Alterado e validado estaticamente.'};}};
 const result=await runAppTask({system:'synthetic isolated task',store,scope:'app',executionId:'same',mode:'edicao',objetivo:'Continue',userRequest:'Continue',tools,provider});
 const saved=await store.read('app');assert.equal(writes,1);assert.notEqual(result.app_build.motivo,'uncertain_action');assert.equal(saved.pending,null);
 assert.ok(saved.journal.some(x=>x.event==='pending_reconciled_not_applied'&&x.signature===sig));
});
test('app editing yields after a productive quantum and can be requeued automatically',async()=>{
 const store=memory(),tools=new ToolRegistry();let model=0,writes=0,validations=0;const rev='d'.repeat(64);
 tools.add({name:'listar_arquivos_do_app',run:async()=>({ok:true,alvo_validacao:'owner:demo',revisao:rev,arquivos:[]})})
  .add({name:'escrever_arquivo_do_app',run:async({caminho})=>{writes++;return {ok:true,alvo_validacao:'owner:demo',arquivo:caminho,hash:String(writes).padStart(64,'0'),effect:{version:1,state:'applied'}};}})
  .add({name:'validar_rascunho_do_app',run:async()=>{validations++;return {ok:true,alvo_validacao:'owner:demo',revisao:rev,validacao:'aprovado'};}});
 const provider={complete:async()=>{model++;return model<=45?{stop:'tool',toolCalls:[{id:'w'+model,name:'escrever_arquivo_do_app',args:{caminho:'f'+model,conteudo:'x'}}]}:model===46?{stop:'tool',toolCalls:[{id:'validate',name:'validar_rascunho_do_app',args:{}}]}:{stop:'end',text:'done'};}};
 const first=await runAppTask({store,scope:'app-quantum',executionId:'job',mode:'edicao',objetivo:'Criar arquivos',userRequest:'Criar arquivos',tools,provider,system:'test'});
 assert.equal(first.app_build.motivo,'execution_quantum');assert.equal(writes,40);
 const result=await runAppTask({store,scope:'app-quantum',executionId:'job',mode:'edicao',objetivo:'Criar arquivos',userRequest:'Criar arquivos',tools,provider,system:'test'});
 assert.equal(result.app_build.motivo,'completed');assert.equal(writes,45);assert.equal(validations,1);assert.equal(model,47);
});

test('app editing may inspect many distinct files across a quantum before its first mutation',async()=>{
 const store=memory(),tools=new ToolRegistry();let model=0,reads=0,writes=0,validations=0;const rev='e'.repeat(64);
 const files=Array.from({length:60},(_,i)=>({caminho:'f'+i+'.js',hash:String(i+1).padStart(64,'0')}));
 tools.add({name:'listar_arquivos_do_app',run:async()=>({ok:true,alvo_validacao:'owner:demo',revisao:rev,arquivos:files})})
  .add({name:'ler_arquivo_do_app',run:async({caminho})=>{reads++;const file=files.find(x=>x.caminho===caminho);return {ok:true,alvo_validacao:'owner:demo',revisao:rev,arquivo:caminho,hash:file.hash,inicio:0,fim:1,total_chars:1,conteudo:'x'};}})
  .add({name:'escrever_arquivo_do_app',run:async()=>{writes++;return {ok:true,alvo_validacao:'owner:demo',arquivo:'result.js',hash:'f'.repeat(64),effect:{version:1,state:'applied'}};}})
  .add({name:'validar_rascunho_do_app',run:async()=>{validations++;return {ok:true,alvo_validacao:'owner:demo',revisao:rev,validacao:'aprovado'};}});
 const provider={complete:async()=>{model++;return model<=60
  ?{stop:'tool',toolCalls:[{id:'r'+model,name:'ler_arquivo_do_app',args:{caminho:'f'+(model-1)+'.js'}}]}
  :model===61?{stop:'tool',toolCalls:[{id:'write',name:'escrever_arquivo_do_app',args:{caminho:'result.js',conteudo:'done'}}]}
  :model===62?{stop:'tool',toolCalls:[{id:'validate',name:'validar_rascunho_do_app',args:{}}]}
  :{stop:'end',text:'done'};}};
 const input={store,scope:'app-many-reads',executionId:'many-reads',mode:'edicao',objetivo:'Entender os módulos e implementar',userRequest:'Entenda os módulos e implemente',tools,provider,system:'test'};
 const first=await runAppTask(input);assert.equal(first.app_build.motivo,'execution_quantum');assert.equal(reads,40);assert.equal(writes,0);
 const result=await runAppTask(input);
 assert.equal(result.app_build.motivo,'completed');assert.equal(reads,60);assert.equal(writes,1);assert.equal(validations,1);assert.equal(model,63);
});
test('advanced yields after its execution quantum and resumes without new permission',async()=>{
 const store=memory();let calls=0,actions=0;const tools=new ToolRegistry().add({name:'ler_arquivo',run:async()=>{actions++;return 'read';}});
 const provider={complete:async()=>{calls++;return calls<=51?{stop:'tool',toolCalls:[{id:'c'+calls,name:'ler_arquivo',args:{path:'file'+calls}}],usage:{in:2,out:1}}:{stop:'end',text:'Done',usage:{in:2,out:1}};}};
 const first=await runCodingTask({store,scope:'advanced',executionId:'job',target:'project-A',objetivo:'Inspect 51 files',tools,provider,authorize:async()=>true});
 assert.equal(first.coding_task.reason,'execution_quantum');assert.equal(actions,40);
 const result=await runCodingTask({store,scope:'advanced',executionId:'job',target:'project-A',objetivo:'Inspect 51 files',tools,provider,authorize:async()=>true});
 assert.equal(actions,51);assert.equal(calls,52);assert.equal(result.coding_task.state,'completed');
});

test('advanced clears a mutation only from an explicit applied or not-applied receipt',async()=>{
 const store=memory();let calls=0,attempts=0;
 const tools=new ToolRegistry().add({name:'editar_arquivo',run:async()=>{attempts++;return attempts===1
  ?{ok:false,error:'preflight',effect:{version:1,state:'not_applied'}}
  :{ok:true,effect:{version:1,state:'applied'}};}});
 const provider={complete:async()=>{calls++;return calls<=2?{stop:'tool',toolCalls:[{id:'edit'+calls,name:'editar_arquivo',args:{path:'a'}}]}:{stop:'end',text:'done'};}};
 const result=await runCodingTask({store,scope:'effect-known',target:'p',objetivo:'edit',tools,provider,authorize:async()=>true});
 assert.equal(result.coding_task.state,'completed');assert.equal(attempts,2);assert.equal((await store.read('effect-known')).pending,null);
});

test('advanced stops the batch on an unknown mutation receipt and never executes its sibling',async()=>{
 const store=memory();let dangerous=0;
 const tools=new ToolRegistry().add({name:'rodar_comando',run:async()=>({ok:false,error:'transport',effect:{version:1,state:'unknown'}})})
  .add({name:'editar_arquivo',run:async()=>{dangerous++;return {ok:true,effect:{version:1,state:'applied'}};}});
 const provider={complete:async()=>({stop:'tool',toolCalls:[{id:'cmd',name:'rodar_comando',args:{command:'x'}},{id:'edit',name:'editar_arquivo',args:{path:'b'}}]})};
 const result=await runCodingTask({store,scope:'effect-unknown',target:'p',objetivo:'run',tools,provider,authorize:async()=>true});
 assert.equal(result.coding_task.reason,'uncertain_action');assert.equal(dangerous,0);assert.equal((await store.read('effect-unknown')).pending.name,'rodar_comando');
});

test('advanced classifies actual search and read commands as read-only',async()=>{
 const store=memory();let calls=0;
 const tools=new ToolRegistry().add({name:'buscar_no_codigo',run:async()=>({ok:false,error:'not found'})})
  .add({name:'rodar_leitura',run:async()=>({ok:false,error:'read failed'})});
 const provider={complete:async()=>{calls++;return calls===1?{stop:'tool',toolCalls:[{id:'search',name:'buscar_no_codigo',args:{query:'x'}},{id:'read',name:'rodar_leitura',args:{command:'cat x'}}]}:{stop:'end',text:'done'};}};
 const result=await runCodingTask({store,scope:'reads',target:'p',objetivo:'inspect',tools,provider,authorize:async()=>true});
 assert.equal(result.coding_task.state,'completed');assert.equal((await store.read('reads')).pending,null);
});
test('advanced context survives runner recreation and is separated by target',async()=>{
 const store=memory(),tools=new ToolRegistry();let seen=[];
 await runCodingTask({store,scope:'A',target:'project-A',objetivo:'ORIGINAL',tools,provider:{complete:async()=>{throw Error('network')}},authorize:async()=>true});
 // Prepared/dispatched unknown provider call remains fail-closed; it is not silently repeated.
 const result=await runCodingTask({store,scope:'A',target:'project-A',objetivo:'continue',tools,provider:{complete:async()=>{seen.push('called');return {stop:'end',text:'x'}}},authorize:async()=>true});
 assert.equal(seen.length,0);assert.equal(result.coding_task.state,'paused');
 await assert.rejects(()=>runCodingTask({store,scope:'A',target:'project-B',objetivo:'continue',tools,provider:{},authorize:async()=>true}),/target mismatch/);
 assert.match(JSON.stringify(await store.read('A')),/ORIGINAL/);
});
test('unknown effect blocks replay; access revocation blocks all tools',async()=>{
 const store=memory();store.data.set('A',{version:1,id:'t',target:'p',status:'paused',history:[],pending:{mutating:true},calls:0,tokens:0,events:[]});let calls=0;
 const p={complete:async()=>{calls++;}};
 const r=await runCodingTask({store,scope:'A',target:'p',objetivo:'continue',tools:new ToolRegistry(),provider:p,authorize:async()=>true});assert.equal(r.coding_task.reason,'uncertain_action');assert.equal(calls,0);
 const denied=await runCodingTask({store,scope:'A',target:'p',objetivo:'continue',tools:new ToolRegistry(),provider:p,authorize:async()=>false});assert.equal(denied.coding_task.reason,'access_denied');
});
test('worker status stays readable while running; cancel signals safe boundary',async()=>{
 const store=memory();let release,entered;const entry=new Promise(r=>entered=r),done=new Promise(r=>release=r);let delivered=0;
 const jobs=createCodingJobs({store,execute:async(job,c)=>{entered(c);await done;return {coding_task:{state:'completed'},text:'done'};},deliver:async job=>{delivered++;assert.match(job.result.text,/interrompida/);assert.equal(job.result.ok,false);}});
 await jobs.submit(identity,{kind:'advanced',args:{objetivo:'x'}},'req');const run=jobs.drive(codingJobScope(identity));const c=await entry;
 assert.equal((await jobs.status(identity)).programming_job.state,'running');await jobs.cancel(identity);assert.equal(await c.shouldStop(),true);release();await run;
 assert.equal((await jobs.status(identity)).programming_job.state,'cancelled');assert.equal(delivered,1);
});
test('worker restart resumes queued job; duplicate request does not create another execution',async()=>{
 const store=memory();let runs=0;const config={store,execute:async()=>{runs++;return {coding_task:{state:'completed'},text:'done'};},deliver:async()=>{}};
 const first=createCodingJobs(config),p=await first.submit(identity,{kind:'advanced',args:{objetivo:'x'}},'req');const fresh=createCodingJobs(config);
 await fresh.drive(codingJobScope(identity));const duplicate=await fresh.submit(identity,{kind:'advanced',args:{objetivo:'x'}},'req');assert.equal(duplicate.programming_job.id,p.programming_job.id);assert.equal(runs,1);
 assert.equal((await fresh.status({...identity,userId:'other'})).ok,false);
});
test('operational window and execution quantum requeue internally rather than asking user to continue',async()=>{
 for(const reason of ['execution_window','execution_quantum']){
  const store=memory();let n=0,deliveries=0;const jobs=createCodingJobs({store,execute:async()=>++n===1?{coding_task:{state:'paused',reason}}:{coding_task:{state:'completed'},text:'done'},deliver:async()=>{deliveries++;}});
  await jobs.submit(identity,{kind:'advanced'},'req-'+reason);await jobs.drive(codingJobScope(identity));assert.equal((await jobs.status(identity)).programming_job.state,'queued');assert.equal(deliveries,0);
  await jobs.drive(codingJobScope(identity));assert.equal(n,2);assert.equal(deliveries,1);
 }
});
test('parent stops after accepted job and closes skipped tool-call pairs',async()=>{
 let sideEffects=0,calls=0;const tools=new ToolRegistry().add({name:'codar',run:async()=>({programming_job:{background:true},text:'queued'})}).add({name:'danger',run:async()=>{sideEffects++;}});
 const r=await runAgent({tools,provider:{complete:async()=>{calls++;return {stop:'tool',toolCalls:[{id:'a',name:'codar',args:{}},{id:'b',name:'danger',args:{}}]};}},userInput:'code',control:{afterTool:({out})=>out?.programming_job?{stop:'coding_job',text:out.text}:undefined}});
 assert.equal(sideEffects,0);assert.equal(calls,1);assert.equal(r.termination,'coding_job');assert.ok(r.messages.some(m=>m.role==='tool'&&m.toolCallId==='b'));
});
test('status/cancel grammar is exact and cannot infer destructive intent from quoted content',()=>{
 assert.equal(codingControlIntent('Como está?'),'status');assert.equal(codingControlIntent('Pode parar'),'cancel');assert.equal(codingControlIntent('O texto diz "pare"'),null);assert.equal(codingControlIntent('Para melhorar a API'),null);
});
test('approved handoff remains durable until job accepted, then explicit acknowledge closes it',async()=>{
 const f=await approvalFixture(),p=await f.approvals.propose({name:f.tool.name,args,binding:f.prepared.descriptor});
 await f.approvals.resolve(p.id,true,r=>f.tool.restoreConfirmation(r.args,r.binding).run());assert.equal((await f.approvals.peek()).state,'approved');
 await f.approvals.acknowledge(p.id);assert.equal(await f.approvals.peek(),null);
});
test('cancel stops approved but not yet queued continuation without reverting the applied scope',async()=>{
 const f=await approvalFixture(),p=await f.approvals.propose({name:f.tool.name,args,binding:f.prepared.descriptor});
 await f.approvals.resolve(p.id,true,r=>f.tool.restoreConfirmation(r.args,r.binding).run());await f.approvals.cancel();assert.equal(await f.approvals.peek(),null);
 assert.equal((await f.store.read(f.scope)).mode,'edicao');
});
test('graceful stop yields at boundary and retains queued work for next process',async()=>{
 const store=memory();let entered,release;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 const jobs=createCodingJobs({store,execute:async(j,c)=>{entered();await wait;assert.equal(await c.shouldStop(),true);return {coding_task:{state:'paused',reason:'new_user_input'}};},deliver:async()=>{throw Error('must not deliver a terminal result')}});
 await jobs.submit(identity,{kind:'advanced'},'req');const run=jobs.drive(codingJobScope(identity));await ready;const stopped=jobs.stop();release();await Promise.all([run,stopped]);assert.equal((await jobs.status(identity)).programming_job.state,'queued');
});
test('large outputs are recoverable artifacts, not instructions to avoid reading',async()=>{
 const store=memory();let step=0,ref;const tools=new ToolRegistry().add({name:'ler_arquivo',run:async()=> 'X'.repeat(12_345)});
 const provider={complete:async({messages})=>{
  step++;if(step===1)return {stop:'tool',toolCalls:[{id:'read',name:'ler_arquivo',args:{path:'big'}}]};
  if(step===2){const output=JSON.parse(messages.findLast(m=>m.role==='tool').content);ref=output.resultado_persistente;assert.ok(ref);return {stop:'tool',toolCalls:[{id:'recover',name:'ler_resultado_de_programacao',args:{ref,inicio:12000}}]};}
  const output=JSON.parse(messages.findLast(m=>m.role==='tool').content);assert.equal(output.text.length,345);return {stop:'end',text:'done'};
 }};
 const result=await runCodingTask({store,scope:'artifact-A',target:'project-A',objetivo:'Read a file',tools,provider,authorize:async()=>true});assert.equal(result.ok,true);assert.ok(ref);
});
test('durable compaction preserves objective and lets productive work continue',async()=>{
 const store=memory();let toolsCount=0,compactions=0;const tools=new ToolRegistry().add({name:'ler_arquivo',run:async()=>('read '+(++toolsCount)).repeat(100)});
 const provider={complete:async p=>{
  if(p.tools.length===0){compactions++;return {stop:'end',text:'Objetivo original e arquivos lidos; continuar.'};}
  return toolsCount<20?{stop:'tool',toolCalls:[{id:'read'+toolsCount,name:'ler_arquivo',args:{path:'f'+toolsCount}}]}:{stop:'end',text:'done'};
 }};
 const result=await runCodingTask({store,scope:'compact',target:'p',objetivo:'ORIGINAL_GOAL',tools,provider,authorize:async()=>true,compactChars:5000});assert.equal(result.ok,true);assert.ok(compactions>0);assert.match(JSON.stringify(await store.read('compact')),/ORIGINAL_GOAL/);
});
test('unknown external notification is not retried after controller restart',async()=>{
 const store=memory();let sends=0,history=0;
 const options={store,execute:async()=>({coding_task:{state:'completed'},text:'done'}),deliver:async()=>{history++},notify:async()=>{sends++;throw Error('unknown network result')}};
 const jobs=createCodingJobs(options);await jobs.submit(identity,{kind:'advanced',channel:'telegram'},'req');await jobs.drive(codingJobScope(identity));
 assert.equal((await jobs.status(identity)).programming_job.notification,'unknown');await createCodingJobs(options).drive(codingJobScope(identity));assert.equal(sends,1);assert.equal(history,1);
});
test('crash during notification dispatch does not resend on recovery',async()=>{
 const store=memory();const scope=codingJobScope(identity);store.data.set(scope,{...identity,id:'old',kind:'basic',channel:'whatsapp',state:'completed',result:{text:'done'},delivered:false,notification:{state:'dispatching'}});let sends=0;
 const jobs=createCodingJobs({store,execute:async()=>{throw Error('must not execute')},deliver:async()=>{},notify:async()=>{sends++}});await jobs.drive(scope);assert.equal(sends,0);assert.equal((await jobs.status(identity)).programming_job.notification,'unknown');
});
test('new task request while busy is queued separately and runs only after the first result is delivered',async()=>{
 const store=memory(),seen=[],delivered=[];const jobs=createCodingJobs({store,execute:async job=>{seen.push(job.args.objetivo);return {coding_task:{state:'completed'},text:job.args.objetivo};},deliver:async job=>delivered.push(job.result.text)});
 await jobs.submit(identity,{kind:'advanced',args:{objetivo:'A'}},'one');
 const result=await jobs.submit(identity,{kind:'advanced',args:{objetivo:'B'}},'two');assert.equal(result.ok,true);assert.equal(result.queued_request,true);
 await jobs.drive(codingJobScope(identity));assert.deepEqual(seen,['A']);assert.deepEqual(delivered,['A']);assert.equal((await jobs.status(identity)).programming_job.state,'queued');
 await jobs.drive(codingJobScope(identity));assert.deepEqual(seen,['A','B']);assert.deepEqual(delivered,['A','B']);
});

test('concurrent admission is serialized and acknowledges the exact queued request',async()=>{
 const store=memory();const read=store.read;let staleReads=0;
 store.read=async scope=>scope===codingJobScope(identity)&&staleReads++<2?null:read(scope);
 const jobs=createCodingJobs({store,execute:async()=>{},deliver:async()=>{}});
 await jobs.submit(identity,{kind:'advanced'},'first');
 const other=await jobs.submit(identity,{kind:'advanced'},'second');
 assert.equal(other.ok,true);assert.equal(other.queued_request,true);assert.equal((await read(codingJobScope(identity))).queuedInputs[0].requestId,'second');
});

test('scheduler gives one execution slot per account and reports queue health',async()=>{
 const store=memory();let release,entered=0;const wait=new Promise(r=>release=r);
 const jobs=createCodingJobs({store,concurrency:2,execute:async()=>{entered++;await wait;return {coding_task:{state:'completed'},text:'done'};},deliver:async()=>{}});
 const otherThread={...identity,threadId:'other-thread'};
 await jobs.submit(identity,{kind:'advanced'},'one');await jobs.submit(otherThread,{kind:'advanced'},'two');await jobs.tick();
 await new Promise(r=>setTimeout(r,10));assert.equal(entered,1);const metrics=await jobs.metrics();assert.equal(metrics.activeUsers,1);assert.equal(metrics.states.queued+metrics.states.running,2);
 release();await jobs.stop();
});
test('scheduler never exceeds its global worker cap when one scan launches many candidates',async()=>{
 const store=memory();let running=0,max=0,release;const wait=new Promise(r=>release=r);
 const jobs=createCodingJobs({store,concurrency:2,execute:async()=>{running++;max=Math.max(max,running);await wait;running--;return {coding_task:{state:'completed'},text:'done'};},deliver:async()=>{}});
 for(let i=0;i<4;i++)await jobs.submit({...identity,userId:'u'+i,threadId:'t'+i},{kind:'advanced'},'r'+i);
 await jobs.tick();await new Promise(r=>setTimeout(r,10));assert.equal(max,2);assert.equal((await jobs.metrics()).activeWorkers,2);
 release();await jobs.stop();
});

test('advanced completion receipt survives worker crash before terminal job save',async()=>{
 const store=memory();let calls=0;const options={store,scope:'receipt',executionId:'job-A',target:'p',objetivo:'task',tools:new ToolRegistry(),authorize:async()=>true,provider:{complete:async()=>{calls++;return {stop:'end',text:'done'}}}};
 const first=await runCodingTask(options);assert.deepEqual(await runCodingTask(options),first);assert.equal(calls,1);
 await runCodingTask({...options,executionId:'job-B'});assert.equal(calls,2);
});

test('advanced preserves reserved-credit explanation instead of claiming exhausted balance',async()=>{
 const result=await runCodingTask({store:memory(),scope:'credit',target:'p',objetivo:'task',tools:new ToolRegistry(),authorize:async()=>true,provider:{complete:async()=>{throw new ExecutionCreditError('account_credit_reserved')}}});
 assert.equal(result.coding_task.reason,'account_credit_reserved');assert.match(result.text,/não significa que seu saldo acabou/);
});
