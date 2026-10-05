import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {createAppTaskStore} from './web/app-task-store.mjs';
import {createProgrammingRuntime} from './web/coding-runtime.mjs';
import {createCodingJobs,codingJobScope,codingPolicySnapshot} from './web/coding-jobs.mjs';
import {codingDeliveryKey} from './web/coding-recovery-policy.mjs';
import {ExecutionCreditError} from './web/execution-error.mjs';
import {createCodingApprovals} from './web/coding-approvals.mjs';
import {makeAppTaskControlTool} from './web/app-task-runner.mjs';
import {appendThreadMessage} from './web/thread-history.mjs';
import net from 'node:net';import tls from 'node:tls';
net.Socket.prototype.connect=()=>{throw Error('Network forbidden')};tls.connect=()=>{throw Error('Network forbidden')};globalThis.fetch=()=>{throw Error('Network forbidden')};
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const identity={userId:'owner',agentId:'agent',threadId:'thread'};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'coding-runtime-'));const key=crypto.randomBytes(32);
 const seal=text=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64')};
 const open=text=>{const b=Buffer.from(text,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString()};
 const store=name=>createAppTaskStore({root:path.join(root,name),seal,open});
 const app=store('tasks'),jobStore=store('jobs');let content='old',modelSteps=0,patches=0;const cached=new Map(),billed=[];
 const agent={id:'agent',category:'pessoal',perm_mode:'aceitar_edicoes',model:'fake',active_project_id:null};
 const revision=()=>crypto.createHash('sha256').update(content).digest('hex');
 const listing=async()=>({ok:true,alvo_validacao:'owner:demo',revisao:revision(),arquivos:[{caminho:'server.js',hash:revision()}]});
 const hostTools=()=>[
  {name:'listar_arquivos_do_app',run:listing},
  {name:'ler_arquivo_do_app',run:async a=>{assert.equal(a.nome_do_sistema,'demo');return {ok:true,arquivo:'server.js',hash:revision(),conteudo:content};}},
  {name:'editar_arquivo_do_app',run:async a=>{assert.equal(a.nome_do_sistema,'demo');assert.equal(a.trecho_antigo,content);content=a.trecho_novo;patches++;return {ok:true,alvo_validacao:'owner:demo',arquivo:'server.js',hash:revision()};}},
  {name:'validar_rascunho_do_app',run:async()=>({ok:true,alvo_validacao:'owner:demo',revisao:revision(),validacao:'aprovado'})},
 ];
 const provider={name:'fake',completeDurable:async(input,{callId})=>{
  if(cached.has(callId))return cached.get(callId);modelSteps++;
  const name=['ler_arquivo_do_app','editar_arquivo_do_app','validar_rascunho_do_app'][modelSteps-1];
  const result=name?{stop:'tool',toolCalls:[{id:'call'+modelSteps,name,args:{caminho:'server.js',trecho_antigo:'old',trecho_novo:'new'}}],usage:{in:5,out:2}}:{stop:'end',text:'Rascunho alterado; validação estática passou, runtime não testado.',usage:{in:5,out:2}};
  cached.set(callId,result);return result;
 }};
 const deps={getAgentOwned:async(a,u)=>a==='agent'&&u==='owner'?agent:null,getThreadOwned:async(id,u)=>id==='thread'&&u==='owner'?{id,agent_id:'agent'}:null,
  getUserLocale:async()=>({language:'pt-BR'}),hasProviderExecution:()=>true,DEEPSEEK_AGENT_MODEL:'not-selected',GEMINI_COMPARISON_ID:'not-selected-either',isDeepSeekTurn:()=>false,isGeminiComparison:()=>false,
  recordUsages:async(usages,dims,options)=>{assert.equal(dims.userId,'owner');assert.ok(options.eventId);billed.push(options.eventId)},makeHeavyProvider:()=>provider,
  primaryIsGeminiOverride:false,hostingTools:hostTools,APP_SUB_TOOLS:new Set(hostTools().map(t=>t.name)),appTaskStore:app,
  getProject:async()=>null,userHasSshKey:async()=>false,runnerOnline:()=>false,runnerBoundAgentId:()=>null,validProviderToken:async()=>{throw Error('No credentials in fixtures')},
 };
 const db=new PGlite();await db.exec(`CREATE SCHEMA fixture;CREATE TABLE fixture.threads(id text primary key,agent_id text,user_id text,history jsonb default '[]',updated_at timestamptz default now());CREATE TABLE fixture.messages(id bigserial primary key,thread_id text,agent_id text,role text,content text,attachments jsonb);CREATE TABLE fixture.thread_delivery_receipts(thread_id text,delivery_key text,primary key(thread_id,delivery_key));INSERT INTO fixture.threads(id,agent_id,user_id)VALUES('thread','agent','owner');`);
 let tail=Promise.resolve();const pool={connect:async()=>{const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return {release,query:(...a)=>db.query(...a)}}};
 const deliver=job=>appendThreadMessage(pool,'fixture',{threadId:job.threadId,userId:job.userId,text:job.result.text,deliveryKey:codingDeliveryKey(job),clean:x=>x});
 t.after(async()=>{await db.close();await fs.rm(root,{recursive:true,force:true})});
 return {root,store,app,jobStore,deps,agent,provider,listing,db,deliver,billed,get patches(){return patches},get steps(){return modelSteps}};
}
test('real encrypted stores: approved control → restart recovery → basic adapter → tools → idempotent history delivery',async t=>{
 const f=await fixture(t),session='owner:agent:thread:app',scope=JSON.stringify([session,'demo','']);
 await f.app.withTask(scope,async({save})=>save({id:'old-task',targetIdentity:'owner:demo',mode:'revisao',objective:'Diagnosticar',status:'paused',history:[],calls:0,tokens:0,elapsed:0,journal:[],evidence:[],report:[],signatures:[],progress:[],pending:null}));
 const tool=makeAppTaskControlTool({store:f.app,sessionKey:session,authorize:f.listing});const args={app:'demo',acao:'atualizar_escopo',modo:'edicao',objetivo:'Corrigir server.js sem publicar'};
 const prepared=await tool.prepareConfirmation(args),approvals=createCodingApprovals({store:f.app,scope:JSON.stringify(['owner','agent','thread'])});
 const proposal=await approvals.propose({name:tool.name,args,binding:prepared.descriptor,context:{identity,policy:codingPolicySnapshot(f.agent),channel:'chat'}});
 await assert.rejects(()=>approvals.resolve(proposal.id,true,async p=>{await tool.restoreConfirmation(p.args,p.binding).run();throw Error('crash after effect')}));
 // New stores/runtime/job controller: no pending RAM callback or previous runner survives.
 const app=f.store('tasks'),deps={...f.deps,appTaskStore:app},runtime=createProgrammingRuntime(deps);
 const jobs=createCodingJobs({store:f.store('jobs'),execute:runtime.execute,deliver:f.deliver,onError:e=>{throw e}});
 await runtime.recoverApprovals({submit:async()=>({ok:false,programming_job:{id:'unrelated'}})});
 assert.equal((await approvals.peek()).state,'approved');
 await runtime.recoverApprovals(jobs);assert.equal((await jobs.status(identity)).programming_job.state,'queued');
 await jobs.drive(codingJobScope(identity));assert.equal((await jobs.status(identity)).programming_job.state,'completed');assert.equal(f.patches,1);assert.equal(f.steps,4);
 assert.equal((await f.db.query('SELECT * FROM fixture.messages')).rows.length,1);
 // Crash gap: executor saved completion, but worker did not save its terminal receipt.
 await f.jobStore.withTask(codingJobScope(identity),async({record,save})=>save({...record,state:'running',delivered:false,result:null}));
 const restarted=createCodingJobs({store:f.store('jobs'),execute:runtime.execute,deliver:f.deliver});await restarted.drive(codingJobScope(identity));await runtime.recoverApprovals(restarted);
 assert.equal(f.patches,1);assert.equal((await f.db.query('SELECT * FROM fixture.messages')).rows.length,1);assert.equal(new Set(f.billed).size,4);
});
test('runtime rechecks policy before every basic tool; revocation prevents patch',async t=>{
 const f=await fixture(t),original=f.provider.completeDurable;let calls=0;
 f.provider.completeDurable=async(...a)=>{calls++;const result=await original(...a);if(calls===2)f.agent.perm_mode='plano';return result;};
 const runtime=createProgrammingRuntime(f.deps),jobs=createCodingJobs({store:f.jobStore,execute:runtime.execute,deliver:f.deliver});
 await jobs.submit(identity,{kind:'basic',args:{app:'demo',modo:'edicao',objetivo:'Corrigir server.js'},userRequest:'Corrija',policy:codingPolicySnapshot(f.agent)},'revocation');await jobs.drive(codingJobScope(identity));
 assert.equal(f.patches,0);assert.equal((await jobs.status(identity)).programming_job.state,'paused');
});
test('advanced runtime binds the project adapter and does not mount unrelated SSH transport',async t=>{
 const f=await fixture(t);f.agent.active_project_id='project-A';let target;
 f.deps.getProject=async(id,u)=>id==='project-A'&&u==='owner'?{id,nome:'repo-A'}:null;
 f.deps.codingTools=(uid,opts)=>{target=opts.project;return [{name:'ler_arquivo',run:async()=> 'source'}];};
 f.deps.sshTools=()=>{throw Error('must not mount SSH in a project job')};let n=0;
 f.provider.completeDurable=async()=>++n===1?{stop:'tool',toolCalls:[{id:'read',name:'ler_arquivo',args:{caminho:'a'}}]}:{stop:'end',text:'Checked source'};
 const runtime=createProgrammingRuntime(f.deps),jobs=createCodingJobs({store:f.jobStore,execute:runtime.execute,deliver:f.deliver});
 const environment={projectId:'project-A',runner:false,ssh:false,sshLivre:false,livre:false,mode:'aceitar_edicoes',category:'pessoal'};
 await jobs.submit(identity,{kind:'advanced',args:{objetivo:'Inspect source'},environment,policy:codingPolicySnapshot(f.agent)},'advanced');await jobs.drive(codingJobScope(identity));
 assert.deepEqual(target,{ownerUserId:'owner',nome:'repo-A'});assert.equal((await jobs.status(identity)).programming_job.state,'completed');
});
test('two conversations cannot concurrently mutate the same app workspace',async t=>{
 const f=await fixture(t);await f.db.exec("INSERT INTO fixture.threads(id,agent_id,user_id)VALUES('thread2','agent','owner')");
 f.deps.getThreadOwned=async(id,u)=>['thread','thread2'].includes(id)&&u==='owner'?{id,agent_id:'agent'}:null;
 let release,entered;const wait=new Promise(r=>release=r),ready=new Promise(r=>entered=r);const original=f.provider.completeDurable;
 f.provider.completeDurable=async(...a)=>{if(f.steps===0){entered();await wait;}return original(...a)};
 const runtime=createProgrammingRuntime(f.deps),jobs=createCodingJobs({store:f.jobStore,execute:runtime.execute,deliver:f.deliver});
 const input={kind:'basic',args:{app:'demo',modo:'edicao',objetivo:'Corrigir server.js'},userRequest:'Corrija',policy:codingPolicySnapshot(f.agent)};
 await jobs.submit(identity,input,'one');await jobs.submit({...identity,threadId:'thread2'},input,'two');
 const first=jobs.drive(codingJobScope(identity));await ready;await jobs.drive(codingJobScope({...identity,threadId:'thread2'}));
 assert.equal((await jobs.status({...identity,threadId:'thread2'})).programming_job.state,'queued');assert.equal(f.steps,0);
 release();await first;assert.equal(f.patches,1);
});

test('basic task survives a billing pause and restart, then resumes without duplicate model use or edits',async t=>{
 const f=await fixture(t),original=f.deps.recordUsages;let fail=true;
 f.deps.recordUsages=async(...args)=>{if(fail)throw Error('Synthetic ledger unavailable');return original(...args);};
 const makeJobs=()=>{const runtime=createProgrammingRuntime({...f.deps,appTaskStore:f.store('tasks')});
  return createCodingJobs({store:f.store('jobs'),execute:runtime.execute,deliver:f.deliver,cancelTask:runtime.cancelTask});};
 const policy=codingPolicySnapshot(f.agent),scope=codingJobScope(identity);
 let jobs=makeJobs();
 await jobs.submit(identity,{kind:'basic',args:{app:'demo',modo:'edicao',objetivo:'Corrigir server.js'},userRequest:'Corrija',policy},'resume-basic');
 await jobs.drive(scope);const paused=await jobs.status(identity);
 assert.equal(paused.programming_job.state,'paused');assert.equal(paused.programming_job.recovery.reason,'credit_reconciliation_required');
 assert.equal(f.steps,1);assert.equal(f.patches,0);assert.equal(f.billed.length,0);
 fail=false;jobs=makeJobs();
 const resumed=await jobs.resume(identity,{policy,requestId:'resume-input'});
 assert.equal(resumed.programming_job.id,paused.programming_job.id);assert.equal(resumed.programming_job.resumeCount,1);
 await jobs.drive(scope);const done=await jobs.status(identity);
 assert.equal(done.programming_job.state,'completed');assert.equal(f.steps,4);assert.equal(f.patches,1);
 assert.equal(new Set(f.billed).size,4);assert.equal(f.billed.length,4);
 assert.equal(done.programming_job.consumption.calls,4);
 assert.equal((await f.db.query('SELECT * FROM fixture.messages')).rows.length,2,'pause and completion are separate durable deliveries');
 // Crash after completing the resumed task but before the worker commits it.
 await f.jobStore.withTask(scope,async({record,save})=>save({...record,state:'running',delivered:false,result:null}));
 jobs=makeJobs();await jobs.drive(scope);
 assert.equal(f.patches,1);assert.equal(f.steps,4);assert.equal(f.billed.length,4);
 assert.equal((await f.db.query('SELECT * FROM fixture.messages')).rows.length,2);
});

test('advanced task preserves applied step and consumption when balance is restored',async t=>{
 const f=await fixture(t);let steps=0,writes=0,deny=true;const cached=new Map();
 f.deps.codingTools=()=>[{name:'escrever_arquivo',run:async()=>{writes++;return {ok:true,effect:{version:1,state:'applied'}};}}];
 f.deps.sshTools=()=>[];
 f.deps.makeHeavyProvider=()=>({name:'synthetic',completeDurable:async(input,{callId})=>{
  if(cached.has(callId))return cached.get(callId);
  if(steps===1&&deny)throw new ExecutionCreditError('account_credit_exhausted');
  steps++;const value=steps===1?{stop:'tool',toolCalls:[{id:'write',name:'escrever_arquivo',args:{}}],usage:{in:10,out:2}}
   :{stop:'end',text:'Etapa concluída.',usage:{in:5,out:1}};cached.set(callId,value);return value;
 }});
 const runtime=createProgrammingRuntime(f.deps),jobs=createCodingJobs({store:f.jobStore,execute:runtime.execute,deliver:f.deliver});
 const policy=codingPolicySnapshot(f.agent),environment={projectId:null,runner:false,ssh:false,sshLivre:false,livre:false,mode:'aceitar_edicoes',category:'pessoal'};
 await jobs.submit(identity,{kind:'advanced',args:{objetivo:'Criar arquivo'},environment,policy},'resume-advanced');
 await jobs.drive(codingJobScope(identity));const paused=await jobs.status(identity);
 assert.equal(paused.programming_job.recovery.reason,'account_credit_exhausted');assert.equal(writes,1);assert.equal(steps,1);
 deny=false;await jobs.resume(identity,{policy,requestId:'resume-advanced-1'});await jobs.drive(codingJobScope(identity));
 const done=await jobs.status(identity);assert.equal(done.programming_job.state,'completed');
 assert.equal(writes,1);assert.equal(steps,2);assert.equal(done.programming_job.consumption.calls,2);assert.equal(done.programming_job.consumption.tokens,18);
 assert.equal((await f.db.query('SELECT * FROM fixture.messages')).rows.length,2);
});

test('canceling a paused job cancels its checkpoint and never silently resumes it as a different request',async t=>{
 const f=await fixture(t),scope=codingJobScope(identity),policy=codingPolicySnapshot(f.agent);
 f.deps.recordUsages=async()=>{throw Error('Synthetic ledger unavailable');};
 const runtime=createProgrammingRuntime(f.deps),jobs=createCodingJobs({store:f.jobStore,execute:runtime.execute,deliver:f.deliver,cancelTask:runtime.cancelTask});
 const input={kind:'basic',args:{app:'demo',modo:'edicao',objetivo:'Corrigir server.js'},userRequest:'Corrija',policy};
 await jobs.submit(identity,input,'cancel-paused');await jobs.drive(scope);await jobs.cancel(identity);
 assert.equal((await jobs.status(identity)).programming_job.state,'cancelled');
 const checkpoint=await f.app.read(JSON.stringify(['owner:agent:thread:app','demo','']));
 assert.equal(checkpoint.status,'cancelled');assert.ok(checkpoint.modelCall,'unknown billing must not be discarded');
 await jobs.submit(identity,input,'new-request');await jobs.drive(scope);
 assert.equal((await jobs.status(identity)).programming_job.recovery.reason,'canceled_pending_reconciliation');
 assert.equal(f.steps,1);assert.equal(f.patches,0);
});
