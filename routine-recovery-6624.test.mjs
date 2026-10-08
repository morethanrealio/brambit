// Regression from the 2026-09-14 14:04–14:10 incident. Everything offline.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractCurationManifest,finalizeCuration} from './web/curation-runtime.mjs';
import {actionResult,createActionJournal} from './web/action-evidence.mjs';
import {startScheduler} from './web/scheduler.mjs';

let n=0;const ok=(v,m)=>{assert.ok(v,m);n++;},eq=(a,b)=>{assert.deepEqual(a,b);n++;};
const manifest={items:[
 {section:'market',url:'https://example.invalid/market/1',title:'Mercado',author:'Fonte',date:'2026-09-14',summary:['um','dois','três'],why:'Importa'},
 {section:'cases',url:'https://example.invalid/case/1',title:'Case',author:'Fonte',date:'2026-09-14',summary:['um','dois','três'],why:'Importa'},
 {section:'papers',url:'https://example.invalid/paper/1',title:'Paper 1',author:'Fonte',date:'2026-09-14',summary:['um','dois','três'],why:'Importa'},
 {section:'papers',url:'https://example.invalid/paper/2',title:'Paper 2',author:'Fonte',date:'2026-09-14',summary:['um','dois','três'],why:'Importa'},
],checks:['market','cases','papers'].map(section=>({section,status:'complete',detail:'pesquisa concluída'}))};
const json=JSON.stringify(manifest);
for(const wrapped of [json,'```json\n'+json+'\n```','<think>raciocínio interno</think>\nAqui está o JSON:\n'+json+'\nFim.',`prefácio\n${JSON.stringify({...manifest,note:'chave com } e \\" aspas'})}\n`]){
 eq(extractCurationManifest(wrapped).items.length,4);
}
const cfg={version:1,sections:[{id:'market',label:'Mercado',min:1,max:2,maxAgeDays:30},{id:'cases',label:'Cases',min:1,max:2,maxAgeDays:30},{id:'papers',label:'Papers',min:2,max:2,maxAgeDays:7}]};
const finalized=await finalizeCuration({text:'Resposta:\n'+json+'\n— fim',config:cfg,userId:'u',routineId:'r',history:[],now:'2026-09-14T17:00:00Z'},{checkLinks:async urls=>({checados:urls.split('\n').length,quebrados:[],indefinidos:[],naoChecados:[]})});
eq(finalized.executionStatus,'completed');eq(finalized.urls.length,4);

// Missing auxiliary fields don't erase an entire valid edit. Empty author
// falls back to the verified hostname; empty detail is valid for check complete.
const sparse={...manifest,items:manifest.items.map((item,index)=>index?item:{...item,author:null}),checks:manifest.checks.map(c=>({...c,detail:''}))};
const sparseFinal=await finalizeCuration({text:JSON.stringify(sparse),config:cfg,userId:'u',routineId:'r',history:[],now:'2026-09-14T17:00:00Z'},{checkLinks:async urls=>({checados:urls.split('\n').length,quebrados:[],indefinidos:[],naoChecados:[]})});
eq(sparseFinal.executionStatus,'completed');eq(sparseFinal.urls.length,4);ok(sparseFinal.text.includes('Autor/Fonte: example.invalid'));

// A malformed candidate is omitted in isolation; the valid ones remain in the
// report, which comes out partial and auditable instead of turning into a failure e-mail.
const mixed={...manifest,items:[...manifest.items,{...manifest.items[0],url:'https://example.invalid/bad',title:''}]};
const mixedFinal=await finalizeCuration({text:JSON.stringify(mixed),config:cfg,userId:'u',routineId:'r',history:[],now:'2026-09-14T17:00:00Z'},{checkLinks:async urls=>({checados:urls.split('\n').length,quebrados:[],indefinidos:[],naoChecados:[]})});
eq(mixedFinal.executionStatus,'partial');eq(mixedFinal.urls.length,4);eq(mixedFinal.audit.discarded.invalidFields,1);ok(!mixedFinal.text.includes('omitido(s) por campos inválidos'));ok(mixedFinal.diagnostic.includes('título inválido'));

const missingWhy={...manifest,items:manifest.items.map((item,index)=>index?item:{...item,why:null})};
const whyFinal=await finalizeCuration({text:JSON.stringify(missingWhy),config:cfg,userId:'u',routineId:'r',history:[],now:'2026-09-14T17:00:00Z'},{checkLinks:async urls=>({checados:urls.split('\n').length,quebrados:[],indefinidos:[],naoChecados:[]})});
eq(whyFinal.executionStatus,'partial');eq(whyFinal.urls.length,4);eq(whyFinal.audit.discarded.missingWhy,1);ok(!whyFinal.text.includes('Não informado nesta edição.'));

// Exact case from the 2026-09-14 simulation: partial checks with 567/658 characters no longer
// invalidate the manifest. Only the auxiliary diagnostic gets truncated; the four
// valid articles remain in the report.
const longChecks={...manifest,checks:manifest.checks.map((c,index)=>index<2?{...c,status:'partial',detail:'limitação '+String(index+1)+' '+('x'.repeat(index?645:554))}:c)};
const longFinal=await finalizeCuration({text:JSON.stringify(longChecks),config:cfg,userId:'u',routineId:'r',history:[],now:'2026-09-14T17:00:00Z'},{checkLinks:async urls=>({checados:urls.split('\n').length,quebrados:[],indefinidos:[],naoChecados:[]})});
eq(longFinal.executionStatus,'partial');eq(longFinal.urls.length,4);ok(!longFinal.diagnostic);eq(longFinal.audit.acceptedBySection[0].searchStatus,'partial');ok(!longFinal.text.includes('somente os itens aceitos pelos filtros determinísticos'));
for(const internal of ['Curadoria parcial','Limitação da pesquisa','Faltam ','candidato(s)','conferência HTTP'])ok(!longFinal.text.includes(internal));
const serverSource=readFileSync('web/server.mjs','utf8');
ok(serverSource.includes('text = curationResult ? text : searchCoverage.finish(text, idiomaResposta,'));
ok(serverSource.includes('audit:curationResult.audit'));

// The real receipt overrides the model's false reinterpretation.
const runJournal=createActionJournal({language:'pt-BR'});
const runOut=actionResult({state:'routine_content_failed',id:'routine-1',target:'email',subject:'Curadoria',delivery:'accepted'},'texto interno');
runJournal.toolResult({name:'executar_rotina_agora',args:{}},runOut);
const renderedRun=runJournal.finish('As duas tentativas falharam na entrega. Ligue o Gmail.');
ok(renderedRun.includes('geração do conteúdo falhou'));
ok(renderedRun.includes('Entrega aceita pela plataforma'));
ok(!renderedRun.includes('Ligue o Gmail'));

const scheduleJournal=createActionJournal({language:'pt-BR'});
scheduleJournal.toolResult({name:'agendar_execucao_rotina',args:{}},actionResult({state:'routine_scheduled',id:'job-1',target:'email',at:'14/09/2026, 14:10',subject:'Curadoria'},'texto interno'));
const renderedSchedule=scheduleJournal.finish('Criei um lembrete para rodar a rotina.');
ok(renderedSchedule.includes('Execução extra da rotina agendada'));
ok(renderedSchedule.includes('cadência normal não foi alterada'));
ok(!renderedSchedule.includes('lembrete'));

// The extra execution queue uses the real executor injected once and does not mark the
// last_run_day of the normal cadence.
let claims=0,executions=0,finishes=0,markedNormal=0;
const job={one_shot_id:'job-1',id:'routine-1',title:'Curadoria',enabled:true,hour:8,days:'[1,4]',tz:'America/Sao_Paulo',last_run_day:'2026-09-14'};
const scheduler=startScheduler({
 recoverRoutineExecutions:async()=>{},listDueRoutines:async()=>[],markRoutineRun:async()=>{markedNormal++;},markRoutineNext:async()=>{},
 recoverRoutineOneShots:async()=>{},listDueRoutineOneShots:async()=>[job],claimRoutineOneShot:async()=>{claims++;return true;},
 executeRoutine:async(r,o)=>{executions++;eq(o.slot,'once:job-1');await o.prepare();return {status:'completed',contentStatus:'complete',delivery:{status:'accepted',channel:'email'}};},
 runRoutine:async()=>'',deliver:async()=>{},finishRoutineOneShot:async(id,status,outcome)=>{finishes++;eq(id,'job-1');eq(status,'completed');eq(outcome.delivery.status,'accepted');},
},{intervalMs:999999});
await scheduler.tick();await scheduler.stop();
eq(claims,1);eq(executions,1);eq(finishes,1);eq(markedNormal,0);

console.log(`PASS ${n}: recuperação da curadoria, recibo determinístico e execução extra real; offline.`);
