import test from 'node:test';import assert from 'node:assert/strict';
import crypto from 'node:crypto';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';import tls from 'node:tls';
const {runAppTask,makeAppTaskControlTool}=await import(process.env.APP_EDIT_TEST_RUNNER||'./web/app-task-runner.mjs');
import {ExecutionCreditError} from './web/execution-error.mjs';
import {createAppTaskStore} from './web/app-task-store.mjs';
import {searchAppCode} from './web/app-code-search.mjs';
import {validateDraft,draftRevision} from './web/app-draft-validation.mjs';
import {appTaskReceipt} from './web/app-review-receipt.mjs';
import {ToolRegistry} from './core-proto/core.mjs';
import {gateTool,takePending} from './web/confirm.mjs';
net.Socket.prototype.connect=()=>{throw Error('Network forbidden');};tls.connect=()=>{throw Error('Network forbidden');};globalThis.fetch=()=>{throw Error('Network forbidden');};
const b64=s=>Buffer.from(s).toString('base64'),hash=s=>crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const end={stop:'end',text:'Todos os testes passaram e publiquei!',usage:{in:3,out:2}};
const call=(name,args,id)=>({id,name,args});const batch=(...toolCalls)=>({stop:'tool',toolCalls,usage:{in:3,out:2}});
const query=(texto,id)=>call('buscar_codigo_do_app',{caminho:'public/index.html',texto},id);
const initialHTML='<html>\n<div id="alpha">A</div>\n<div id="beta">B</div>\n<div id="gamma">C</div>\n</html>';
const scope=JSON.stringify(['session','demo','']);
async function fixture(t,{mode='edicao',encrypted=false}={}){
 let record={id:crypto.randomUUID(),targetIdentity:'owner:demo',mode,objective:'Corrigir o HTML e validar, sem publicar.',status:'paused',history:[],calls:19,tokens:204739,elapsed:1500,journal:[],evidence:[],report:[{assunto:'OLD STATIC REVIEW',avaliacao:'nao_verificado',observacao:'old',evidencias:[]}],reportOutcome:{status:'accepted',accepted:1},signatures:[],progress:[],pending:null,reviewFiles:null,readCoverage:[{arquivo:'public/index.html',hash:hash(initialHTML),intervalos:[[0,initialHTML.length]],total_chars:initialHTML.length}]};
 let store={withTask:async(k,fn)=>fn({id:hash(k),record:structuredClone(record),save:async r=>{record=structuredClone(r);}})};
 if(encrypted){const root=await fs.mkdtemp(path.join(os.tmpdir(),'edit-flow-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const key=crypto.randomBytes(32);const seal=s=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,Buffer.concat([c.update(s),c.final()]),c.getAuthTag()]).toString('base64');};const open=s=>{const b=Buffer.from(s,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString();};store=createAppTaskStore({root,seal,open});await store.withTask(scope,async({save})=>save(record));}
 const read=()=>store.withTask(scope,async({record})=>record),patch=x=>store.withTask(scope,async({record,save})=>save({...record,...x}));
 const files={'public/index.html':b64(initialHTML)};let reads=0,writes=0,validations=0,acl=true;
 const tools=new ToolRegistry();tools.add({name:'listar_arquivos_do_app',parameters:{},run:async()=>({ok:acl,alvo_validacao:'owner:demo',revisao:draftRevision(files),arquivos:Object.entries(files).map(([caminho,b])=>({caminho,hash:hash(Buffer.from(b,'base64'))}))})});
 tools.add({name:'buscar_codigo_do_app',parameters:{},run:async args=>{reads++;return searchAppCode(files,args);}});
 tools.add({name:'escrever_arquivo_do_app',parameters:{},run:async args=>{assert.equal(args.caminho,'public/index.html');writes++;files[args.caminho]=b64(args.conteudo);return {ok:true,arquivo:args.caminho,hash:hash(args.conteudo),alvo_validacao:'owner:demo',revisao:draftRevision(files)};}});
 tools.add({name:'validar_rascunho_do_app',parameters:{},run:async()=>{validations++;return {...validateDraft(files),alvo_validacao:'owner:demo'};}});
 tools.add({name:'publicar_sistema',parameters:{},run:()=>{throw Error('Publication forbidden');}});
 return {store,read,patch,files,tools,get reads(){return reads;},get writes(){return writes;},get validations(){return validations;},deny(){acl=false;},run:(provider,extra={})=>runAppTask({store,scope,mode:'edicao',objetivo:'Continue',userRequest:'Continue',system:'synthetic',tools,provider,...extra})};
}
function sequenced(results){let n=0;return {get calls(){return n;},complete:async input=>{assert.ok(!input.tools.some(x=>x.name==='publicar_sistema'));return results[n++]||end;}};}
const write=(id='w')=>call('escrever_arquivo_do_app',{caminho:'public/index.html',conteudo:initialHTML.replace('>A<','>Fixed<')},id);
const validate=(id='v')=>call('validar_rascunho_do_app',{},id);
test('encrypted checkpoint: old full review → bound confirmation → 3 distinct searches → actual fixture edit/static validation',async t=>{
 const f=await fixture(t,{mode:'revisao',encrypted:true});const before=await f.read();const thread=crypto.randomUUID();const control=makeAppTaskControlTool({store:f.store,sessionKey:'session',authorize:async()=>({ok:true,alvo_validacao:'owner:demo'})});await gateTool(control,thread).run({app:'demo',acao:'atualizar_escopo',modo:'edicao',objetivo:before.objective});const p=takePending(thread);assert.equal((await p.run(p.args)).ok,true);
 const provider=sequenced([batch(query('alpha','a'),query('beta','b'),query('gamma','c'),write(),validate()),end]);const out=await f.run(provider);assert.equal(out.app_build.motivo_exploracao,'completed');assert.equal(out.app_build.motivo,'completed');assert.equal(out.app_build.validacao,'aprovado');assert.equal(f.reads,3);assert.equal(f.writes,1);assert.equal(f.validations,1);assert.equal(provider.calls,2);assert.ok(Buffer.from(f.files['public/index.html'],'base64').toString().includes('Fixed'));
 const saved=await f.read();assert.equal(saved.id,before.id);assert.equal(saved.calls,before.calls+2);assert.equal(saved.tokens,before.tokens+10);assert.deepEqual(out.app_build.parecer,[]);assert.equal(saved.journal.filter(x=>x.kind==='app_report').length,0);
 for(const lang of ['pt-BR','en','es']){const text=appTaskReceipt(out.app_build,lang,{technicalDetails:true});assert.ok(text.includes('public/index.html'));assert.ok(!text.includes('OLD STATIC REVIEW'));assert.ok(!text.includes('Todos os testes passaram'));}
});
test('already-editing legacy checkpoint needs no new mode change and does not spend on old static report',async t=>{
 const f=await fixture(t);const out=await f.run(sequenced([batch(query('alpha','a'),query('beta','b'),query('gamma','c'),write(),validate()),end]));assert.equal(out.ok,true);assert.equal(f.writes,1);assert.deepEqual(out.app_build.parecer,[]);assert.equal(out.app_build.parecer_resultado,undefined);
});
test('small fresh selector reads count as progress, not the review threshold of 128 chars',async t=>{
 const f=await fixture(t);await f.run(sequenced([batch(query('alpha','a'),query('beta','b'),query('gamma','c')),end]));assert.equal(f.reads,3);const saved=await f.read();assert.equal(saved.editReadState.consecutive,0);assert.equal(saved.status,'paused');assert.equal(saved.lastResult.app_build.motivo,'edit_validation_pending');
});
test('different query aliases over identical bytes do not bypass true repetition guard',async t=>{
 const f=await fixture(t);const provider=sequenced([batch(query('alpha','a'),query('id="alpha"','b'),query('alpha">','c'),query('"alpha"','d'),write())]);const out=await f.run(provider);assert.equal(out.app_build.motivo,'read_coverage_loop');assert.equal(f.writes,0);assert.equal(provider.calls,1);assert.equal((await f.read()).editReadState.consecutive,3);assert.equal((await f.read()).journal.filter(x=>x.kind==='app_report').length,0);
});
test('Continue does not reset editing progress/counters or mint any credit budget',async t=>{
 const f=await fixture(t);await f.run(sequenced([batch(query('alpha','a'),query('id="alpha"','b')),end]));const old=await f.read();assert.equal(old.editReadState.consecutive,1);const out=await f.run(sequenced([batch(query('alpha">','c'),query('"alpha"','d'),write())]));assert.equal(out.app_build.motivo,'read_coverage_loop');assert.equal(f.writes,0);const now=await f.read();assert.equal(now.id,old.id);assert.ok(now.calls>old.calls);assert.ok(now.tokens>old.tokens);
});
test('changed draft revision allows necessary reinspection without discarding lifetime evidence/usage',async t=>{
 const f=await fixture(t);await f.run(sequenced([batch(query('alpha','a'),query('id="alpha"','b')),end]));const old=await f.read();f.files['public/index.html']=b64(initialHTML+'\n<!-- changed externally -->');const out=await f.run(sequenced([batch(query('alpha','c'),query('beta','d'),query('gamma','e'),validate()),end]));assert.equal(out.ok,true);assert.equal((await f.read()).editReadState.consecutive,0);assert.equal((await f.read()).id,old.id);
});
test('review still enforces historical coverage and can register static assessments',async t=>{
 const f=await fixture(t,{mode:'revisao'});let n=0;const out=await f.run({complete:async input=>{n++;if(n===1){assert.ok(input.tools.some(x=>x.name==='registrar_parecer_do_app'));return batch(query('alpha','a'),query('beta','b'),query('gamma','c'));}return end;}},{mode:'revisao'});assert.equal(out.app_build.motivo_exploracao,'read_coverage_loop');assert.equal(f.writes,0);
});
test('editing prompt/tools do not request a static report as implementation',async t=>{
 const f=await fixture(t);await f.run({complete:async input=>{assert.ok(input.system.includes('Implemente o objetivo autorizado'));assert.ok(input.system.includes('não boot/runtime'));assert.ok(!input.tools.some(x=>x.name==='registrar_parecer_do_app'));assert.ok(input.tools.some(x=>x.name==='escrever_arquivo_do_app'));return end;}});assert.equal(f.writes,0);assert.equal((await f.read()).status,'paused');
});
test('failed/absent validation never completes editing or trusts the model success claim',async t=>{
 const f=await fixture(t);f.tools.map.get('validar_rascunho_do_app').run=async()=>({ok:true,validacao:'reprovado',revisao:draftRevision(f.files),alvo_validacao:'owner:demo',lint_erros:[{tipo:'syntax',arquivo:'public/index.html'}]});const out=await f.run(sequenced([batch(write(),validate()),end]));assert.equal(out.app_build.motivo,'edit_validation_pending');assert.equal(out.app_build.validacao,'reprovado');assert.equal((await f.read()).status,'paused');assert.ok(appTaskReceipt(out.app_build,'pt-BR',{technicalDetails:true}).includes('syntax'));assert.ok(!appTaskReceipt(out.app_build,'pt-BR',{technicalDetails:true}).includes('Todos os testes passaram'));
});
test('access revoked and uncertain effects remain fail-closed',async t=>{
 const f=await fixture(t);await f.patch({pending:{mutating:true,name:'escrever_arquivo_do_app'}});let calls=0;const out=await f.run({complete:async()=>{calls++;return end;}});assert.equal(out.app_build.motivo,'uncertain_action');assert.equal(calls,0);f.deny();assert.equal((await f.run({complete:async()=>{calls++;return end;}})).app_build.motivo,'access_denied');assert.equal(calls,0);
});
test('legacy pending report response is settled/consumed once, never replayed as editing tools',async t=>{
 const f=await fixture(t);await f.patch({modelCall:{id:'saved-call',kind:'app_report',input:{system:'saved report',messages:[],tools:[]},state:'observed',response:{stop:'tool',toolCalls:[write('must-not-run')],usage:{in:7,out:2}},accounted:false,metricsApplied:false,consumedTools:[]}});let usage=0;const provider=sequenced([batch(validate()),end]);const out=await f.run(provider,{onUsage:async u=>{if(u.executionCallId==='saved-call')usage++;}});assert.equal(out.ok,true);assert.equal(usage,1);assert.equal(f.writes,0);assert.equal(provider.calls,2);assert.equal((await f.read()).calls,22);assert.equal((await f.read()).modelCall,null);
});
test('unknown legacy report dispatch is not replayed or overwritten',async t=>{
 const f=await fixture(t);await f.patch({modelCall:{id:'unknown',kind:'app_report',input:{system:'old',messages:[],tools:[]},state:'dispatched',response:null,accounted:false,metricsApplied:false,consumedTools:[]}});let calls=0;const out=await f.run({complete:async()=>{calls++;return end;}});assert.equal(calls,0);assert.equal((await f.read()).modelCall.id,'unknown');assert.equal(out.ok,false);
});
test('credit denial after a saved edit keeps task/files/usage and never buys a static report',async t=>{
 const f=await fixture(t);let attempts=0;const out=await f.run({complete:async()=>{if(++attempts===1)return batch(query('alpha','a'),query('beta','b'),query('gamma','c'),write());throw new ExecutionCreditError('account_credit_exhausted');}});assert.equal(out.app_build.motivo,'account_credit_exhausted');assert.equal(f.writes,1);assert.equal(f.validations,0);assert.equal(attempts,2);const saved=await f.read();assert.equal(saved.calls,20);assert.equal(saved.tokens,204744);assert.equal(saved.status,'paused');assert.equal(saved.modelCall,null);assert.ok(appTaskReceipt(out.app_build,'pt-BR',{technicalDetails:true}).includes('public/index.html'));assert.ok(appTaskReceipt(out.app_build,'pt-BR',{technicalDetails:true}).includes('saldo'));
});
test('recovered compaction grants fresh code context, not fresh financial credit',async t=>{
 const f=await fixture(t);await f.run(sequenced([batch(query('alpha','a'),query('id="alpha"','b')),end]));const before=await f.read();await f.patch({compactionResume:{tail:[]},modelCall:{id:'compact-saved',kind:'compact',input:{system:'summary',messages:[],tools:[]},state:'observed',response:{stop:'end',text:'Resumo factual sem código.',usage:{in:7,out:2}},accounted:false,metricsApplied:false,consumedTools:[]}});const provider=sequenced([batch(query('alpha','c'),query('beta','d'),query('gamma','e'),validate()),end]);const out=await f.run(provider);assert.equal(out.ok,true);assert.equal(provider.calls,2);const saved=await f.read();assert.equal(saved.calls,before.calls+3);assert.equal(saved.tokens,before.tokens+19);assert.equal(saved.editReadState.consecutive,0);
});
