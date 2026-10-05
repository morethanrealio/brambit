import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import net from 'node:net';import tls from 'node:tls';
import {createAppTaskStore} from './web/app-task-store.mjs';
import {makeAppTaskControlTool,runAppTask} from './web/app-task-runner.mjs';
import {gateTool,takePending,isConfirmation,renderConfirmed} from './web/confirm.mjs';
import {ToolRegistry} from './core-proto/core.mjs';
net.Socket.prototype.connect=()=>{throw Error('Network forbidden');};tls.connect=()=>{throw Error('Network forbidden');};globalThis.fetch=()=>{throw Error('Network forbidden');};
// Only the real store's static local flock child is used. All model replies are synthetic.
const session='synthetic-owner:agent:thread:app',scope=JSON.stringify([session,'demo','']);
const storageId=crypto.createHash('sha256').update(scope).digest('hex');
const proposal={app:'demo',acao:'atualizar_escopo',modo:'edicao',objetivo:'Concluir as alterações e testar o rascunho; não publicar.'};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'task-binding-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const key=crypto.randomBytes(32);
 const seal=s=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(s),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');};
 const open=s=>{const b=Buffer.from(s,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString();};
 const store=createAppTaskStore({root,seal,open});
 const initial={id:crypto.randomUUID(),targetIdentity:'owner:demo',mode:'revisao',objective:'Somente revisar',reviewFiles:null,status:'paused',phase:'paused',nextPhase:'repairing',calls:17,tokens:175107,elapsed:1500,history:[],journal:[],readCoverage:[],report:[],signatures:[],progress:['saved'],evidence:[],pending:null};
 await store.withTask(scope,async({save})=>save(initial));
 const read=()=>store.withTask(scope,async({record})=>record);const change=patch=>store.withTask(scope,async({record,save})=>save({...record,...patch}));
 let access={ok:true,alvo_validacao:'owner:demo'};
 const control=makeAppTaskControlTool({store,sessionKey:session,authorize:async()=>access});
 const thread=crypto.randomUUID();t.after(()=>takePending(thread));const gated=gateTool(control,thread,{mode:'aceitar_edicoes'});
 const file=path.join(root,storageId,'checkpoint.enc');
 return {store,initial,read,change,control,gated,thread,file,setAccess:x=>{access=x;}};
}
for(const hint of ['legacy-storage','record-uuid','omitted'])test(`real encrypted store: ${hint} → human Sim → same task resumes`,async t=>{
 const f=await fixture(t),before=await fs.readFile(f.file,'utf8');assert.notEqual(storageId,f.initial.id);
 const args={...proposal,...(hint==='omitted'?{}:{tarefa_id:hint==='legacy-storage'?storageId:f.initial.id})};
 const text=await f.gated.run(args);assert.match(text,/PENDENTE/);assert.equal(await fs.readFile(f.file,'utf8'),before);assert.ok(!before.includes('Somente revisar'));
 assert.equal(takePending('other-thread'),undefined);assert.equal(isConfirmation('Sim'),true);
 const p=takePending(f.thread);assert.ok(p.label.includes(proposal.objetivo));const out=await p.run(p.args);assert.equal(out.ok,true);assert.equal(out.background,false);assert.ok(renderConfirmed(p,out));
 const saved=await f.read();for(const k of ['id','calls','tokens','elapsed','history','evidence','progress','readCoverage'])assert.deepEqual(saved[k],f.initial[k],k);assert.equal(saved.mode,'edicao');assert.equal(saved.objective,proposal.objetivo);assert.equal(saved.scopeHistory[0].mode,'revisao');
 const tools=new ToolRegistry();tools.add({name:'listar_arquivos_do_app',parameters:{},run:async()=>({ok:true,alvo_validacao:'owner:demo',arquivos:[]})});tools.add({name:'escrever_arquivo_do_app',parameters:{},run:()=>{throw Error('No real app write');}});tools.add({name:'publicar_sistema',parameters:{},run:()=>{throw Error('No publishing');}});
 let calls=0;const result=await runAppTask({system:'fixture',store:f.store,scope,mode:'edicao',objetivo:'Continue',userRequest:'Continue',tools,provider:{complete:async input=>{calls++;assert.ok(input.system.includes(proposal.objetivo));assert.ok(input.tools.some(x=>x.name==='escrever_arquivo_do_app'));assert.ok(!input.tools.some(x=>x.name==='publicar_sistema'));return {stop:'end',text:'Rodada sintética sem alterações.',usage:{in:1,out:1}};}}});assert.ok(calls>0,JSON.stringify(result));assert.equal((await f.read()).id,f.initial.id);
});
test('wrong legacy hint is rejected before confirmation, raw model ID cannot authorize mutation',async t=>{
 const f=await fixture(t);const before=await fs.readFile(f.file,'utf8');assert.match(await f.gated.run({...proposal,tarefa_id:'wrong'}),/NÃO registrei/);assert.equal(takePending(f.thread),undefined);
 assert.equal((await f.control.run({...proposal,tarefa_id:f.initial.id})).ok,false);assert.equal(await fs.readFile(f.file,'utf8'),before);
});
for(const reason of ['replacement','scope','acl','owner','pending','modelCall','compactionResume','completed'])test(`state changed after proposal: ${reason} blocks execution without checkpoint writes`,async t=>{
 const f=await fixture(t);await f.gated.run({...proposal,tarefa_id:storageId});const p=takePending(f.thread);assert.ok(p);
 if(reason==='replacement')await f.change({id:crypto.randomUUID()});
 if(reason==='scope')await f.change({objective:'Different approved goal'});
 if(reason==='acl')f.setAccess(false);
 if(reason==='owner')f.setAccess({ok:true,alvo_validacao:'different-owner'});
 if(['pending','modelCall','compactionResume'].includes(reason))await f.change({[reason]:{mutating:true,state:'uncertain'}});
 if(reason==='completed')await f.change({status:'completed'});
 const before=await fs.readFile(f.file,'utf8');assert.equal((await p.run(p.args)).ok,false);assert.equal(await fs.readFile(f.file,'utf8'),before);
});
test('bound arguments cannot be replaced; confirmation is single-use even with concurrent replay',async t=>{
 const f=await fixture(t);const args={...proposal};const waiting=f.gated.run(args);args.objetivo='MUTATED';await waiting;const p=takePending(f.thread);p.args.objetivo='FORGED';
 const results=await Promise.all([p.run({...proposal,objetivo:'ATTACK'}),p.run(p.args)]);assert.equal(results.filter(x=>x.ok).length,1);const saved=await f.read();assert.equal(saved.objective,proposal.objetivo);assert.equal(saved.scopeHistory.length,1);assert.equal(saved.journal.length,1);
});
test('failed trusted preparation never falls through to raw run or pending card',async()=>{
 let calls=0;const thread=crypto.randomUUID();const gated=gateTool({name:'gerenciar_tarefa_de_app',description:'fixture',parameters:{},prepareConfirmation:async()=>{throw Error('Lock unavailable');},run:()=>{calls++;}},thread);
 assert.match(await gated.run(proposal),/NÃO registrei/);assert.equal(takePending(thread),undefined);assert.equal(calls,0);
});
test('concurrent preparation cannot replace the proposal that won the thread gate',async()=>{
 const thread=crypto.randomUUID();let release,started;const ready=new Promise(r=>started=r),hold=new Promise(r=>release=r);let count=0;
 const gate=gateTool({name:'gerenciar_tarefa_de_app',description:'fixture',parameters:{},prepareConfirmation:async args=>{if(++count===1){started();await hold;}return {run:async()=>args.objetivo};},run:()=>{throw Error('Raw run forbidden');}},thread);
 const first=gate.run({...proposal,objetivo:'first'});await ready;await gate.run({...proposal,objetivo:'second'});release();assert.match(await first,/Nenhuma proposta foi substituída/);const p=takePending(thread);assert.equal(await p.run(),'second');
});
test('unbound legacy gate still requests human confirmation and executes only after it',async()=>{
 let calls=0;const thread=crypto.randomUUID();const gate=gateTool({name:'gmail_send',description:'fixture',parameters:{},run:async()=>{calls++;return {ok:true};}},thread);
 await gate.run({to:'synthetic@example.invalid',assunto:'fixture',corpo:'fixture'});assert.equal(calls,0);const p=takePending(thread);assert.ok(p);await p.run(p.args);assert.equal(calls,1);
});
