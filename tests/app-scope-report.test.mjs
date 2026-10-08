import {makeConstruirAppTool} from '../web/coding-subagent.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {validateAppReport,reportDiagnosticHelp} from '../web/app-report-validation.mjs';
import {runAppTask,makeAppTaskControlTool} from '../web/app-task-runner.mjs';
import {reviewRequestNeedsClarification} from '../web/app-task-scope.mjs';
import {appTaskReceipt as detailedReceipt} from '../web/app-review-receipt.mjs';
const appTaskReceipt=(build,lang)=>detailedReceipt(build,lang,{technicalDetails:true});
import {gateTool,takePending,isConfirmation,setThreadLanguage,renderConfirmed} from '../web/confirm.mjs';
import {ToolRegistry} from '../core-proto/core.mjs';
const ev={arquivo:'server.js',hash:'h',inicio:0,fim:1,total_chars:1};const evidence=new Map([['r',ev]]);
const item={assunto:'Rotas',avaliacao:'sem_problema_observado',observacao:'No lobby aparecem GET a api/sala/<codigo> e POST a api/sala/<codigo>/pronto.',evidencias:['r']};
test('literal real rejected candidate now accepted and rendered as harmless route text',()=>{
 const v=validateAppReport({itens:[item]},evidence);assert.equal(v.accepted.length,1);assert.deepEqual(v.diagnostics,[]);assert.match(v.accepted[0].observacao,/api\/sala\/\{codigo\}/);
 const text=appTaskReceipt({version:2,modo:'revisao',estado:'interrompido',parecer:v.accepted});assert.ok(text.includes('api/sala/{codigo}'));assert.ok(!text.includes('<codigo>'));
});
test('HTML, links, fake actions and invented evidence remain rejected',()=>{
 for(const text of ['<script>alert(1)</script>','<img src=x onerror=alert(1)>','https://evil.invalid','publiquei o app','testei e funciona','executed the test','x\ny','`codigo`','api/sala/<codigo onclick=x>'])assert.equal(validateAppReport({itens:[{...item,observacao:text}]},evidence).accepted.length,0,text);
 assert.equal(validateAppReport({itens:[{...item,evidencias:['fake']}]},evidence).accepted.length,0);
 assert.ok(reportDiagnosticHelp([{code:'unsafe_statement'}])[0].includes('/{codigo}'));
});
function fixture(){let record={id:'task-1',targetIdentity:'owner:app',mode:'revisao',objective:'Somente revisar, não editar',reviewFiles:null,status:'paused',phase:'paused',nextPhase:'repairing',history:[],calls:17,tokens:175107,elapsed:1500,journal:[],evidence:[['r',ev]],readCoverage:[],report:[],signatures:[],progress:[],pending:null};let saves=0,calls=0;const store={withTask:async(k,fn)=>fn({id:k,record:structuredClone(record),save:async x=>{record=structuredClone(x);saves++;}})};const tools=new ToolRegistry();tools.add({name:'listar_arquivos_do_app',parameters:{},run:async()=>({ok:true,alvo_validacao:'owner:app',arquivos:[{caminho:'server.js',hash:'h'}]})});const provider={complete:async()=>{calls++;return {stop:'end',text:'parcial',usage:{in:1,out:1}};}};return {store,tools,provider,get record(){return record;},get saves(){return saves;},get calls(){return calls;},set(x){record=x;}};}
const args={app:'app',acao:'atualizar_escopo',tarefa_id:'task-1',modo:'edicao',objetivo:'Concluir alterações e testar o rascunho; não publicar.'};
test('actual new request cannot silently resume the saved read-only review; no model or checkpoint mutation',async()=>{
 const f=fixture();const before=structuredClone(f.record);const out=await runAppTask({...f,scope:'s',objetivo:'Revisão antiga',mode:'revisao',userRequest:'Conclua as alterações e execute os testes disponíveis.'});assert.equal(out.app_build.motivo,'scope_clarification');assert.equal(out.tarefa_id,'task-1');assert.equal(f.calls,0);assert.equal(f.saves,0);assert.deepEqual(f.record,before);
});
test('mode change and explicit file-scope change require clarification, no silent widening',async()=>{
 for(const extra of [{mode:'edicao'},{mode:'revisao',reviewFiles:['other.js']}]){const f=fixture();const out=await runAppTask({...f,scope:'s',objetivo:'novo',...extra});assert.ok(['mode_conflict','scope_clarification'].includes(out.app_build.motivo));assert.equal(f.calls,0);assert.equal(f.saves,0);}
});
test('PT/EN/ES detector is a clarification brake, not permission inference',()=>{
 for(const x of ['Conclua as alterações e execute os testes','Please edit the app','Run the tests','Modifica el juego','Ejecuta las pruebas'])assert.equal(reviewRequestNeedsClarification(x),true,x);
 for(const x of ['Continue a revisão','Não edite nem execute o app.','Do not edit or run tests.','Sin modificar el código.'])assert.equal(reviewRequestNeedsClarification(x),false,x);
});
test('real parent gate waits for human confirmation; change preserves identity, evidence, progress and spent credit',async()=>{
 for(const lang of ['pt-BR','en','es']){
 const f=fixture();const key='scope-test-'+lang;setThreadLanguage(key,lang);const tool=makeAppTaskControlTool({store:f.store,sessionKey:'s',authorize:async()=>({ok:true,alvo_validacao:'owner:app'})});const gated=gateTool(tool,key);const before=structuredClone(f.record);await gated.run(args);assert.equal(f.saves,0);const pending=takePending(key);assert.ok(pending);assert.ok(!pending.label.includes('120'));assert.ok(pending.label.includes('Concluir'));assert.equal(isConfirmation('pode'),true);const res=await pending.run(pending.args);assert.equal(res.ok,true);assert.equal(f.record.mode,'edicao');assert.equal(f.record.objective,args.objetivo);assert.equal(f.record.id,before.id);assert.equal(f.record.calls,before.calls);assert.equal(f.record.tokens,before.tokens);assert.deepEqual(f.record.evidence,before.evidence);assert.equal(f.record.nextPhase,null);assert.equal(f.calls,0);const text=renderConfirmed(pending,res);assert.ok(!text.includes('Orçamento adicional'));assert.ok(!text.includes('budget authorized'));
 }
});
test('ACL loss, changed owner/task and uncertain calls deny confirmed scope mutation',async()=>{
 for(const reason of ['acl','owner','id','pending','modelCall','compactionResume']){
  const f=fixture();if(['pending','modelCall','compactionResume'].includes(reason)){const r=structuredClone(f.record);r[reason]={state:'uncertain',mutating:true};f.set(r);}
  const tool=makeAppTaskControlTool({store:f.store,sessionKey:'s',authorize:async()=>reason==='acl'?false:{ok:true,alvo_validacao:reason==='owner'?'another':'owner:app'}});
  const before=structuredClone(f.record);const out=await tool.run({...args,tarefa_id:reason==='id'?'stale':args.tarefa_id});assert.equal(out.ok,false,reason);assert.equal(f.saves,0);assert.deepEqual(f.record,before);
 }
});
test('latest same-mode objective reaches repair provider instead of old frozen objective',async()=>{
 const f=fixture();let seen;const out=await runAppTask({...f,scope:'s',mode:'revisao',objetivo:'Confira as rotas atuais, sem editar.',userRequest:'Confira as rotas atuais, sem editar.',provider:{complete:async input=>{seen=JSON.stringify(input);return {stop:'tool',toolCalls:[{id:'ok',name:'registrar_parecer_do_app',args:{itens:[item]}}],usage:{in:1,out:1}}}}});assert.ok(seen.includes('Confira as rotas atuais'));assert.equal(f.record.objective,'Somente revisar, não editar');assert.equal(f.record.currentInstruction,'Confira as rotas atuais, sem editar.');assert.ok(out.app_build.parecer.length);
});
test('invalid scope never creates a confirmation card; expired/different thread cannot consume it',async()=>{
 const f=fixture();const tool=makeAppTaskControlTool({store:f.store,sessionKey:'s',authorize:async()=>true});const gated=gateTool(tool,'invalid-scope');
 await gated.run({...args,objetivo:'x'.repeat(2001)});assert.equal(takePending('invalid-scope'),undefined);assert.equal(f.saves,0);
 await gated.run(args);assert.equal(takePending('another-thread'),undefined);const pending=takePending('invalid-scope');assert.ok(pending);assert.equal(f.saves,0); // discarded proposal is NOT execution
});
test('provider receives harmless rendering plus diagnosis on mixed partial report, no invented evidence',()=>{
 const v=validateAppReport({itens:[item,{...item,observacao:'<script>x</script>'},{...item,evidencias:['bad']}]},evidence);assert.equal(v.accepted.length,1);assert.ok(v.diagnostics.some(x=>x.code==='unsafe_statement'));assert.ok(v.diagnostics.some(x=>x.code==='unknown_evidence'));
});

test('production construir_app adapter forwards the current user message before invoking any coding model',async()=>{
 const f=fixture();const tool=makeConstruirAppTool({buildAppContext:async()=>({tools:f.tools,provider:f.provider}),sessionKey:'owner:agent:thread:app',taskStore:f.store,userRequest:'Conclua as alterações e execute os testes disponíveis.'});
 const out=await tool.run({app:'app',modo:'revisao',objetivo:'Somente revisar o código'});assert.equal(out.app_build.motivo,'scope_clarification');assert.equal(f.calls,0);assert.equal(f.saves,0);
});
test('after confirmed scope update the same task resumes with editing tools, never publication',async()=>{
 const f=fixture();const control=makeAppTaskControlTool({store:f.store,sessionKey:'s',authorize:async()=>({ok:true,alvo_validacao:'owner:app'})});
 const gated=gateTool(control,'edit-resume');await gated.run(args);const pending=takePending('edit-resume');assert.equal((await pending.run(pending.args)).ok,true);
 f.tools.add({name:'escrever_arquivo_do_app',parameters:{},run:async()=>{throw Error('not requested in this test');}});
 f.tools.add({name:'publicar_sistema',parameters:{},run:async()=>{throw Error('publication must never be allowed');}});
 let seen=false;await runAppTask({...f,scope:'s',mode:'edicao',objetivo:'Continue',userRequest:'Continue',system:'fixture',provider:{complete:async input=>{
  seen=true;assert.ok(input.system.includes(args.objetivo));assert.ok(input.tools.some(x=>x.name==='escrever_arquivo_do_app'));assert.ok(!input.tools.some(x=>x.name==='publicar_sistema'));return {stop:'end',text:'Sem alterações nesta rodada.',usage:{in:1,out:1}};
 }}});
 assert.ok(seen);assert.equal(f.record.id,'task-1');assert.ok(f.record.tokens>=175107);assert.equal(f.record.objective,args.objetivo);
});
test('a new read-only restriction also stops a previously authorized editing task',async()=>{
 for(const userRequest of ['Não edite arquivos; apenas revisão.','Read-only review, do not edit.','No edites, solo revision.']){
  const f=fixture();f.set({...f.record,mode:'edicao'});const out=await runAppTask({...f,scope:'s',mode:'edicao',objetivo:'Continue',userRequest});assert.equal(out.app_build.motivo,'scope_clarification');assert.equal(f.calls,0);assert.equal(f.saves,0);
 }
});
