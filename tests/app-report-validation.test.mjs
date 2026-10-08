import assert from 'node:assert/strict';
import {APP_REPORT_PARAMETERS,validateAppReport,reportAudit} from '../web/app-report-validation.mjs';
import {runAppTask} from '../web/app-task-runner.mjs';
import {appTaskReceipt as detailedReceipt} from '../web/app-review-receipt.mjs';
const appTaskReceipt=(build,lang)=>detailedReceipt(build,lang,{technicalDetails:true});
import {ToolRegistry} from '../core-proto/core.mjs';
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};const ok=x=>{assert.ok(x);checks++;};
const ref={arquivo:'a.js',hash:'current',inicio:0,fim:10,total_chars:10};const evidence=new Map([['ref',ref]]);
const good={assunto:'Declaração',avaliacao:'sem_problema_observado',observacao:'Declaração presente no trecho consultado.',evidencias:['ref']};
const validate=itens=>validateAppReport({itens},evidence);
eq(validate([good]).accepted.length,1);eq(validate([{...good,avaliacao:'nao_verificado',evidencias:[]}]).accepted.length,1);
eq(APP_REPORT_PARAMETERS.properties.itens.items.properties.evidencias.maxItems,8);
for(const [patch,code] of [[{assunto:''},'text_length'],[{assunto:'a'.repeat(121)},'text_length'],[{observacao:'a'.repeat(401)},'text_length'],[{observacao:1},'text_type'],[{avaliacao:'SECRET'},'assessment_enum'],[{evidencias:[]},'evidence_required'],[{evidencias:['SECRET']},'unknown_evidence'],[{evidencias:[1]},'evidence_type'],[{evidencias:Array(9).fill('ref')},'evidence_count'],[{observacao:'Código íntegro.'},'unsafe_statement'],[{observacao:'https://secret.invalid'},'unsafe_statement'],[{observacao:'publiquei o app'},'unsafe_statement'],[{observacao:'x\ny'},'unsafe_statement']]) {
 const v=validate([good,{...good,...patch}]);eq(v.accepted.length,1);ok(v.diagnostics.some(x=>x.code===code));ok(v.diagnostics.every(x=>x.field.startsWith('itens.1.')));ok(!JSON.stringify(v.diagnostics).includes('SECRET'));
}
for(const itens of [[],Array(13).fill(good),null])eq(validate(itens).diagnostics[0].code,'item_count');
eq(validate([null]).diagnostics[0].code,'item_shape');eq(validate([{...good,evidencias:['ref','ref']}]).accepted[0].evidencias.length,1);
const original=structuredClone(good);validate([good]);eq(good,original);
const audit=reportAudit({args:{itens:[good]},validation:validate([good]),phase:'closing',at:1});eq(audit.candidate.itens[0],good);eq(audit.candidateOmitted,false);
const large=reportAudit({args:{text:'á'.repeat(40000)},validation:validate([]),phase:'closing',at:1});eq(large.candidate,null);eq(large.candidateOmitted,true);
const cycle={};cycle.self=cycle;eq(reportAudit({args:cycle,validation:validate([])}).candidateOmitted,true);
const step=args=>({stop:'tool',toolCalls:[{id:'r',name:'registrar_parecer_do_app',args}],usage:{in:100,out:20}});
const end={stop:'end',text:'Acabou?',usage:{in:100,out:20}};
function fixture({legacy=false,failSave=false}={}) {
 let record={id:'fixture',targetIdentity:'owner:app',mode:'revisao',nextPhase:'consolidating',objective:'Conferir código',status:'paused',history:[],calls:58,tokens:956893,elapsed:100,journal:[],evidence:[['ref',ref]],report:[],signatures:[],progress:[],pending:null};
 if(legacy)Object.assign(record,{calls:59,tokens:967821,reportAttemptCall:59,journal:[{event:'report_close',ok:false}]});
 let failed=false,saves=0;const store={async withTask(k,fn){return fn({id:k,record:structuredClone(record),save:async r=>{if(failSave&&!failed&&r.report?.length){failed=true;throw Error('STORAGE_SECRET');}record=structuredClone(r);saves++;}});}};
 const tools=new ToolRegistry();tools.add({name:'listar_arquivos_do_app',parameters:{},run:async()=>({ok:true,alvo_validacao:'owner:app',arquivos:[{caminho:'a.js',hash:'current'}]})});
 let effects=0;for(const name of ['publicar_sistema','escrever_arquivo_do_app','chamar_sistema'])tools.add({name,parameters:{},run:async()=>{effects++;throw Error('FORBIDDEN');}});
 return {store,tools,get record(){return record;},set record(r){record=r;},get effects(){return effects;},get saves(){return saves;}};
}
async function run(f,response){let calls=0;const out=await runAppTask({store:f.store,scope:'fixture',objetivo:'Finalize sem editar',tools:f.tools,system:'fixture',provider:{name:'fixture',complete:async input=>{calls++;ok(input.system.startsWith('Você está FECHANDO'));eq(input.tools.length,1);eq(input.tools[0].parameters,APP_REPORT_PARAMETERS);if(response instanceof Error)throw response;return response;}}});return {out,calls};}
for(const kind of ['accepted','partial','rejected','wrong_tool','no_tool','two_tools','provider_error','save_error']) {
 const f=fixture({failSave:kind==='save_error'});const secret={...good,assunto:'REJECTED_PRIVATE_CANDIDATE',evidencias:['SECRET_ID']};
 const response=kind==='accepted'||kind==='save_error'?step({itens:[good]}):kind==='partial'?step({itens:[good,secret]}):kind==='rejected'?step({itens:[secret]}):kind==='no_tool'?end:kind==='provider_error'?Error('PROVIDER_SECRET'):kind==='two_tools'?{...end,toolCalls:[...step({itens:[good]}).toolCalls,...step({itens:[good]}).toolCalls]}:{...end,toolCalls:[{id:'x',name:'publicar_sistema',args:{secret:'PRIVATE'}}]};
 // One initial closure plus at most two format repairs; I/O failures are not retried.
 const expectedCalls=['accepted','provider_error','save_error'].includes(kind)?1:3;
 const {out,calls}=await run(f,response);eq(calls,expectedCalls);eq(f.effects,0);eq(out.app_build.orcamento.chamadas,58+(kind==='provider_error'?0:expectedCalls));ok(out.app_build.orcamento.tokens_contabilizados<=1000000);eq(f.record.extraBudget,undefined);
 const expected=kind==='accepted'?'accepted':kind==='partial'?'partial':['save_error','provider_error'].includes(kind)?'unavailable':'rejected';eq(out.app_build.parecer_resultado.status,expected);eq(out.app_build.parecer.length,['accepted','partial'].includes(kind)?1:0);
 eq(out.app_build.motivo,expected==='accepted'?'completed':'report_'+(expected==='partial'?'partial':expected==='rejected'?'rejected':'unavailable'));
 ok(!JSON.stringify(out).includes('REJECTED_PRIVATE_CANDIDATE'));ok(!JSON.stringify(out).includes('SECRET_ID'));ok(!JSON.stringify(out).includes('PROVIDER_SECRET'));ok(!JSON.stringify(out).includes('STORAGE_SECRET'));
 if(['partial','rejected'].includes(kind)){ok(JSON.stringify(f.record.reportAudits).includes('REJECTED_PRIVATE_CANDIDATE'));ok(!JSON.stringify(f.record.journal).includes('REJECTED_PRIVATE_CANDIDATE'));}
 for(const lang of ['pt-BR','en','es']){const text=appTaskReceipt(out.app_build,lang);ok(!text.includes('REJECTED_PRIVATE_CANDIDATE'));if(expected!=='accepted'){ok(!text.includes('confirmar uma nova rodada'));ok(!text.includes('Continuing requires'));ok(!text.includes('Continuar requiere'));}}
}
// The legacy59/967821 checkpoint now closes from saved evidence WITHOUT
// resetting metrics or requesting renewal. The earlier lost candidate is not
// invented: this is a newly metered report, validated under current access.
{
 const f=fixture({legacy:true});const {out,calls}=await run(f,step({itens:[good]}));eq(calls,1);eq(out.app_build.motivo,'completed');eq(out.app_build.orcamento.tokens_contabilizados,967941);eq(out.app_build.orcamento.chamadas,60);eq(out.app_build.parecer_resultado.status,'accepted');eq(f.record.extraBudget,undefined);
}
// A new invalid candidate does not erase previously saved, currently referenced items.
{
 const f=fixture();f.record.report=validate([good]).accepted;const {out}=await run(f,step({itens:[{...good,evidencias:['fake']}]}));eq(out.app_build.parecer.length,1);eq(out.app_build.motivo,'report_rejected');
}
// Repeated audit writes remain bounded; invalid diagnostics never reach raw delivery.
{
 const f=fixture();f.record.reportAudits=Array(3).fill(audit);const {out}=await run(f,step({itens:[{...good,evidencias:['bad']}]}));eq(f.record.reportAudits.length,3);ok(!('reportAudits' in out.app_build));
 const forged={...out.app_build,parecer_resultado:{diagnostics:[{field:'SECRET',code:'SECRET'}]}};ok(!appTaskReceipt(forged).includes('SECRET'));
}
console.log(`PASS ${checks} app report validation checks (offline)`);
