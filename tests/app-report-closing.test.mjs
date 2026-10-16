import assert from 'node:assert/strict';
import test from 'node:test';
import {closeAppReport} from '../web/app-report-closing.mjs';
import {validateAppReport,reportAudit,APP_REPORT_PARAMETERS} from '../web/app-report-validation.mjs';
import {runAppTask} from '../web/app-task-runner.mjs';
import {ToolRegistry} from '../core-proto/core.mjs';
const ref={arquivo:'a.js',hash:'hash',inicio:0,fim:10,total_chars:10};
const good={assunto:'Declaração',avaliacao:'sem_problema_observado',observacao:'Declaração presente no trecho.',evidencias:['ref']};
const report=itens=>({stop:'tool',usage:{model:'synthetic',in:100,out:100},toolCalls:[{id:'r',name:'registrar_parecer_do_app',args:{itens}}]});
function fixture(){
 const task={objective:'Revisar a.js',history:[],report:[],readSamples:[]},evidence=new Map([['ref',ref]]),inputs=[];
 return {task,evidence,inputs,params:{task,evidence,coverage:[],tools:[{name:'registrar_parecer_do_app',parameters:APP_REPORT_PARAMETERS},{name:'publicar_sistema'}],persist:async()=>{},checkAccess:async()=>true,
 complete:async input=>{inputs.push(input);return report([good]);},accept:async(response,phase)=>{
  const args=response.toolCalls?.[0]?.args,validation=validateAppReport(args,evidence);
  task.reportAudits=[reportAudit({args,validation,phase,at:0})];task.reportOutcome={status:validation.accepted.length?(validation.diagnostics.length?'partial':'accepted'):'rejected',diagnostics:validation.diagnostics};
  task.report.push(...validation.accepted);return task.reportOutcome;
 }}};
}
test('invalid field repaired without reads, valid items retained, only report tool exposed',async()=>{
 const f=fixture();let calls=0;
 f.params.complete=async input=>{f.inputs.push(input);calls++;assert.deepEqual(input.tools.map(x=>x.name),['registrar_parecer_do_app']);return calls===1?report([good,{...good,assunto:'Outro',evidencias:['invalid']}]):report([{...good,assunto:'Outro'}]);};
 const out=await closeAppReport(f.params);assert.equal(out.accepted,true);assert.equal(calls,2);assert.equal(f.task.report.length,2);assert.equal(f.task.phase,'delivering');
 assert.match(f.inputs[1].messages[1].content,/unknown_evidence/);
});
test('three attempts maximum, no rereads or renewal exposed',async()=>{
 const f=fixture();let calls=0;f.params.complete=async()=>{calls++;return report([{...good,evidencias:['invalid']}]);};
 const out=await closeAppReport(f.params);assert.equal(calls,3);assert.equal(out.reason,'report_rejected');assert.equal(f.task.phase,'paused');
});
test('new input, changed ACL or revision after response prevents report registration',async()=>{
 for(const reason of ['new_user_input','access_denied','draft_changed']){
  const f=fixture();let checks=0;
  if(reason==='new_user_input')f.params.shouldPause=async()=>++checks===2;
  else f.params.checkAccess=async()=>++checks===2?reason:true;
  const out=await closeAppReport(f.params);assert.equal(out.reason,reason);assert.equal(f.task.report.length,0);
 }
});
test('credit denial does not dispatch and does not become validation failure',async()=>{
 const f=fixture();f.params.canCall=()=>false;const out=await closeAppReport(f.params);
 assert.equal(f.inputs.length,0);assert.equal(out.reason,'admission_pending');assert.equal(f.task.reportOutcome,undefined);
});
test('persist failure before dispatch does not call model',async()=>{
 const f=fixture();f.params.persist=async()=>{throw Error('save failed');};await assert.rejects(()=>closeAppReport(f.params));assert.equal(f.inputs.length,0);
});
test('legacy diagnostics permit repair without needing the lost candidate',async()=>{
 const f=fixture();f.task.reportOutcome={status:'rejected',diagnostics:[{field:'report',code:'legacy_reason_unavailable'}]};f.task.reportAttemptCall=59;
 const out=await closeAppReport(f.params);assert.equal(out.accepted,true);assert.match(f.inputs[0].messages[1].content,/legacy_reason_unavailable/);assert.equal(f.task.reportAttemptCall,59);
});
test('integrated runner: empty end goes directly to structured report, no text salvage',async()=>{
 let record={id:'task',targetIdentity:'owner:app',mode:'revisao',objective:'Revisar a.js',status:'paused',history:[],calls:2,tokens:200,elapsed:1,journal:[],evidence:[['ref',ref]],report:[],signatures:[],progress:[],pending:null};
 const store={withTask:async(scope,fn)=>fn({id:scope,record:structuredClone(record),save:async r=>{record=structuredClone(r);}})};
 const tools=new ToolRegistry();tools.add({name:'listar_arquivos_do_app',run:async()=>({ok:true,alvo_validacao:'owner:app',arquivos:[{caminho:'a.js',hash:'hash'},{caminho:'b.js',hash:'other'}]})});
 let calls=0;const out=await runAppTask({store,scope:'synthetic',objetivo:'continue',tools,system:'test',provider:{name:'test',complete:async input=>{calls++;if(calls===1)return {stop:'end',text:'',usage:{in:100,out:1}};assert.equal(input.tools.length,1);assert.equal(input.tools[0].name,'registrar_parecer_do_app');return report([good]);}}});
 assert.equal(calls,2);assert.equal(out.app_build.parecer.length,1);assert.equal(out.app_build.motivo_exploracao,'empty_end');assert.equal(record.calls,4);
});
function savedRunner({reviewFiles=null,extraFile=true,nextPhase=null}={}){
 let record={id:'task',targetIdentity:'owner:app',mode:'revisao',reviewFiles,nextPhase,objective:'Revisão autorizada',status:'paused',history:[],calls:59,tokens:500000,elapsed:1,journal:[],evidence:[['ref',ref]],report:[],signatures:[],progress:[],pending:null};
 const store={withTask:async(scope,fn)=>fn({id:scope,record:structuredClone(record),save:async r=>{record=structuredClone(r);}})};
 const tools=new ToolRegistry();tools.add({name:'listar_arquivos_do_app',run:async()=>({ok:true,alvo_validacao:'owner:app',arquivos:[{caminho:'a.js',hash:'hash'},...(extraFile?[{caminho:'b.js',hash:'other'}]:[])]})});
 return {get record(){return record;},params:{store,scope:'synthetic',objetivo:'continue',tools,system:'test'}};
}
test('one assessment cannot complete a two-file review; partial result survives',async()=>{
 const f=savedRunner();let calls=0;
 const out=await runAppTask({...f.params,provider:{name:'test',complete:async()=>++calls===1?report([good]):{stop:'end',text:'Finalizei.',usage:{in:10,out:2}}}});
 assert.equal(out.app_build.motivo,'review_partial');assert.deepEqual(out.app_build.pendencias_revisao,['b.js']);assert.equal(f.record.status,'paused');assert.equal(f.record.nextPhase,'exploring');assert.equal(out.app_build.parecer.length,1);
});
test('explicit file-limited review does not require unrelated app files',async()=>{
 const f=savedRunner({reviewFiles:['a.js']});let calls=0;
 const out=await runAppTask({...f.params,provider:{name:'test',complete:async()=>++calls===1?report([good]):{stop:'end',text:'Finalizei.',usage:{in:10,out:2}}}});
 assert.equal(out.app_build.motivo,'completed');assert.deepEqual(out.app_build.pendencias_revisao,[]);assert.equal(f.record.status,'completed');
});
test('saved repair phase skips exploration and preserves task identity and consumption',async()=>{
 const f=savedRunner({extraFile:false,nextPhase:'repairing'});let calls=0;
 const out=await runAppTask({...f.params,provider:{name:'test',complete:async input=>{calls++;assert.match(input.system,/FECHANDO/);assert.deepEqual(input.tools.map(t=>t.name),['registrar_parecer_do_app']);return report([good]);}}});
 assert.equal(calls,1);assert.equal(f.record.id,'task');assert.equal(f.record.calls,60);assert.equal(f.record.tokens,500200);assert.equal(out.app_build.parecer.length,1);assert.equal(out.app_build.motivo,'completed');
});
test('past elapsed time is retained as a metric, not a permanent task death',async()=>{
 const f=savedRunner({extraFile:false,nextPhase:'repairing'});f.record.elapsed=16*60*1000;
 let calls=0;const out=await runAppTask({...f.params,now:()=>1000,provider:{name:'test',complete:async()=>{calls++;return report([good]);}}});
 assert.equal(calls,1);assert.equal(f.record.elapsed,16*60*1000);assert.equal(out.app_build.motivo,'completed');
});
test('current execution time window pauses truthfully without pretending credits ended',async()=>{
 const f=savedRunner({extraFile:false});let calls=0,clock=0;
 const out=await runAppTask({...f.params,limits:{ms:1},now:()=>clock++,provider:{name:'test',complete:async()=>{calls++;return report([good]);}}});
 assert.equal(calls,0);assert.equal(out.app_build.motivo,'execution_window');assert.equal(f.record.status,'paused');
});

test('runner preserves account, quote, reconciliation and provider failure reasons during report closing',async()=>{
 const {ExecutionCreditError}=await import('../web/execution-error.mjs');
 const {appTaskReceipt:detailedReceipt}=await import('../web/app-review-receipt.mjs');
 const appTaskReceipt=(build,lang)=>detailedReceipt(build,lang,{technicalDetails:true});
 for(const [code,reason] of [['account_credit_reserved','account_credit_reserved'],['credit_reservation_unavailable','credit_reservation_unavailable'],['account_credit_exhausted','account_credit_exhausted'],['credit_quote_unavailable','credit_quote_unavailable'],['credit_response_recovery_required','credit_reconciliation_required'],['credit_balance_unavailable','credit_control_unavailable'],['metered_provider_failed','credit_reconciliation_required']]){
  const f=savedRunner({extraFile:false,nextPhase:'repairing'});let calls=0;
  const out=await runAppTask({...f.params,provider:{name:'metered',complete:async()=>{calls++;throw new ExecutionCreditError(code);}}});
  assert.equal(calls,1);assert.equal(out.app_build.motivo,reason);assert.equal(f.record.nextPhase,'repairing');assert.equal(out.app_build.parecer_resultado,undefined);
  if(['account_credit_exhausted','account_credit_reserved','credit_reservation_unavailable','credit_quote_unavailable'].includes(code)){assert.equal(f.record.calls,59);assert.equal(f.record.tokens,500000);}
  for(const lang of ['pt-BR','en','es']){
   const text=appTaskReceipt(out.app_build,lang);assert.ok(text.length>150);assert.ok(!text.includes('undefined'));
   assert.ok(!text.includes('parecer foi recebido, mas recusado'));
  }
 }
});
test('time window during saved report repair keeps its reason and exact next phase',async()=>{
 const f=savedRunner({extraFile:false,nextPhase:'repairing'});f.record.phase='repairing';f.record.reportOutcome={status:'rejected',accepted:0,diagnostics:[{code:'saved_validation'}]};
 let calls=0,clock=0;const out=await runAppTask({...f.params,limits:{ms:1},now:()=>clock++,provider:{name:'test',complete:async()=>{calls++;return report([good]);}}});
 assert.equal(calls,0);assert.equal(out.app_build.motivo,'execution_window');assert.equal(f.record.nextPhase,'repairing');assert.equal(f.record.reportOutcome.diagnostics[0].code,'saved_validation');
});
