import { createScheduledDelivery } from './web/scheduled-delivery.mjs';
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const {createCurationStore,deliverCurationEdition}=await import('./web/curation-store.mjs');
const {normalizeCurationConfig,curationPrompt,curationRepairPrompt,finalizeCuration,preferCurationRepair}=await import('./web/curation-runtime.mjs');
const {normalizeFlightMonitor}=await import('./web/flight-monitor.mjs');
const {sendCurationChannel}=await import('./web/curation-delivery.mjs');
const {randomUUID}=await import('node:crypto');
let count=0;const eq=(a,b)=>{assert.deepEqual(a,b);count++;},ok=a=>{assert.ok(a);count++;},reject=async f=>{await assert.rejects(f);count++;};
const pg=new PGlite();const uuid=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
await pg.exec('CREATE SCHEMA mtr_harness;CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);CREATE TABLE mtr_harness.routines(id uuid PRIMARY KEY,user_id uuid REFERENCES mtr_harness.users,config jsonb DEFAULT jsonb_build_object());');
for(const id of [1,2])await pg.query('INSERT INTO mtr_harness.users VALUES($1)',[uuid(id)]);
for(const [r,u] of [[11,1],[12,1],[21,2]])await pg.query('INSERT INTO mtr_harness.routines(id,user_id) VALUES($1,$2)',[uuid(r),uuid(u)]);
let queries=0;const pool={query:async(s,p)=>{queries++;return pg.query(s,p);},connect:async()=>({query:(s,p)=>pool.query(s,p),release(){}})};
const store=createCurationStore(pool),scope={userId:uuid(1),routineId:uuid(11)};
await reject(()=>store.history(scope)); // table absent: not empty history
await pg.exec(readFileSync('migrations/20260911-curation-deliveries.sql','utf8'));
eq(await store.history(scope),[]);
await reject(()=>store.history({...scope,userId:uuid(2)}));
const url=n=>`https://example.invalid/article/${n}`;
const edition=(n=101,extra={})=>({type:'curation-v1',...scope,editionId:uuid(n),channel:'email',text:'Synthetic report '+n,urls:[url(n)],...extra});
let sends=0,persists=0;const receipt={ok:true,id:'synthetic-provider-id'};
const send=async()=>{sends++;return receipt;};const persist=async()=>{persists++;};
// Full generated text alone changes nothing.
const e=edition();eq(await store.history(scope),[]);eq(sends,0);
await deliverCurationEdition(e,{store,send,persist});eq(sends,1);eq(persists,1);
let history=await store.history(scope);eq(history.length,1);eq(history[0].url,url(101));eq(history[0].confirmed,true);
await reject(()=>deliverCurationEdition(e,{store,send,persist}));eq(sends,1);
await reject(()=>deliverCurationEdition(edition(102,{urls:[url(101)+'?utm_source=other']}),{store,send}));eq(sends,1);
// Same URL is allowed in different user/routine scope.
await deliverCurationEdition(edition(103,{routineId:uuid(12),urls:[url(101)]}),{store,send});eq(sends,2);eq((await store.history({...scope,routineId:uuid(12)})).length,1);
await deliverCurationEdition(edition(104,{userId:uuid(2),routineId:uuid(21),urls:[url(101)]}),{store,send});eq(sends,3);
await reject(()=>store.reserve(edition(105,{userId:uuid(2)})));eq(sends,3);
// Transaction rolls back on primary key collision, preserving next reservation.
await reject(()=>store.reserve(edition(101,{urls:[url(999)]})));
await store.reserve(edition(106));await reject(()=>store.history(scope));
await reject(()=>store.reserve(edition(107)));await reject(()=>store.confirm(edition(106),{skipped:true}));
await store.confirm(edition(106),receipt);eq((await store.history(scope)).length,2);
// Failed send -> uncertainty, no confirmed article, blocks repeat and spending.
const failed=edition(108);const before=sends;
await reject(()=>deliverCurationEdition(failed,{store,send:async()=>{sends++;throw Error('synthetic timeout');}}));eq(sends,before+1);
eq((await pg.query('SELECT status FROM mtr_harness.curation_deliveries WHERE id=$1',[failed.editionId])).rows[0].status,'uncertain');
await reject(()=>store.history(scope));await reject(()=>deliverCurationEdition(edition(109),{store,send}));eq(sends,before+1);
// Successful provider then failed storage leaves reserved and does NOT resend.
const e2=edition(110,{routineId:uuid(12)});const n=sends;
await reject(()=>deliverCurationEdition(e2,{store:{...store,confirm:async()=>{throw Error('synthetic DB down');}},send}));eq(sends,n+1);await reject(()=>store.history({...scope,routineId:uuid(12)}));
for(const v of [null,{skipped:true},{ok:true},{ok:false,id:'x'}]){
 const fake={reserve:async()=>{},confirm:denied,uncertain:async()=>{}};await reject(()=>deliverCurationEdition(edition(),{store:fake,send:async()=>v}));
}
const cfg={version:1,sections:[{id:'market',label:'Mercado',min:1,max:2},{id:'cases',label:'Cases',min:1,max:2},{id:'papers',label:'Papers',min:2,max:2}]};
const article=(n,section)=>({url:url(n),section,title:'Article '+n,author:'Synthetic',date:'2026-09-10',summary:['one','two','three'],why:'Relevant'});
const items=[article(1,'market'),article(2,'cases'),article(3,'papers'),article(4,'papers')];
const checks=cfg.sections.map(s=>({section:s.id,status:'complete',detail:'Synthetic source lookup completed'}));
const manifest=JSON.stringify({items,checks});let probes=0;
const checkLinks=async s=>{probes++;return {checados:s.split('\n').length,quebrados:[],indefinidos:[],naoChecados:[]};};
const finalize=(text=manifest,extra={},deps={checkLinks})=>finalizeCuration({text,config:cfg,...scope,history:[],now:'2026-09-11T15:00:00Z',...extra},deps);
let result=await finalize();eq(result.urls.length,4);eq(result.coverageSatisfied,true);eq(result.executionStatus,'completed');ok(result.text.includes('## Mercado'));ok(!result.text.startsWith('{'));
result=await finalize(manifest,{history:[{...scope,url:url(3),confirmed:true}]});eq(result.urls.length,3);eq(result.coverageSatisfied,false);eq(result.audit.acceptedBySection.find(s=>s.section==='papers').accepted,1);ok(!result.text.includes('Faltam'));ok(!result.text.includes(url(3)));
result=await finalize(manifest,{partial:true});eq(result.coverageSatisfied,false);eq(result.executionStatus,'partial');eq(result.audit.executionHadToolLimit,true);ok(!result.text.includes('execução teve falha'));
for(const badText of ['not json','{}',JSON.stringify({items:[{...items[0],url:'http://127.0.0.1/a'}],checks}),JSON.stringify({items:[{...items[0],url:'https://example.invalid/'}],checks}),JSON.stringify({items:[{...items[0],summary:['https://evil.invalid/a','two','three']}],checks}),JSON.stringify({items:[{...items[0],date:'2026-02-30'}],checks})]){
 const n=probes,r=await finalize(badText);eq(r.urls,[]);eq(r.coverageSatisfied,false);eq(probes,n);
}
for(const url of ['https://127.0.0.1/a','https://10.0.0.1/a','https://169.254.169.254/latest','https://[::1]/a','https://service.internal/a','https://localhost/a','https://user:password@example.invalid/a','https://example.invalid:8080/a','https://example.invalid/a?X-Amz-Signature=x']){
 const n=probes,r=await finalize(JSON.stringify({items:[{...items[0],url}],checks}));eq(r.urls,[]);eq(probes,n);
}
result=await finalize(manifest,{}, {checkLinks:async()=>({checados:3,quebrados:[],indefinidos:[],naoChecados:[]})});eq(result.urls,[]);
result=await finalize(manifest,{}, {checkLinks:async()=>({checados:4,quebrados:[url(1)],indefinidos:[url(3)],naoChecados:[]})});eq(result.urls,[url(2),url(4)]);eq(result.coverageSatisfied,false);ok(!result.text.includes(url(1)));
result=await finalize(JSON.stringify({items,checks:[]}));eq(result.coverageSatisfied,false);ok(result.audit.acceptedBySection.every(s=>s.searchStatus==='missing'));ok(!result.text.includes('não confirmada'));
result=await finalize(JSON.stringify({items,checks:[...checks,checks[0]]}));eq(result.urls.length,4);eq(result.coverageSatisfied,false);eq(result.executionStatus,'partial');ok(result.diagnostic.includes('estrutura inválida'));
ok(curationPrompt(cfg,[]).includes('SOMENTE um objeto JSON'));ok(curationPrompt(cfg,[]).includes('NUNCA responda [ROTINA_SEM_NOVIDADES]'));ok(curationPrompt(cfg,[{url:url(1)}]).includes(url(1)));
ok(curationRepairPrompt(cfg).includes('Sem fazer novas buscas'));ok(curationRepairPrompt(cfg).includes('NUNCA responda [ROTINA_SEM_NOVIDADES]'));
result=await finalize('[ROTINA_SEM_NOVIDADES]');eq(result.urls,[]);eq(result.executionStatus,'failed');eq(result.failureCode,'unexpected_no_news_signal');eq(result.repairable,true);ok(result.text.includes('exige um relatório mesmo sem itens'));
result=await finalize('not json');eq(result.executionStatus,'failed');eq(result.failureCode,'invalid_manifest');eq(result.repairable,true);
result=await finalize(JSON.stringify({items:[],checks}));eq(result.executionStatus,'partial');eq(result.repairable,false);ok(/nenhum conteúdo novo qualificado/i.test(result.text));ok(!result.text.includes('Faltam'));
// Production functions extracted, real runtime/store module, fake transport only.
const server=readFileSync('web/server.mjs','utf8');
const extract=name=>{const start=server.indexOf('async function '+name+'('),end=server.indexOf('\n}\n',start)+2;assert.ok(start>=0&&end>start);return server.slice(start,end);};
const routine={id:uuid(21),user_id:uuid(2),agent_id:uuid(31),channel:'email',email:'synthetic@example.invalid',title:'Curadoria',config:{curation:cfg}};
let opts;
const runner=new Function('getAgentOwned','getOrCreateThreadByTitle','runConversationInThread','normalizeFlightMonitor','normalizeCurationConfig','randomUUID',extract('runRoutine')+';return runRoutine;')(
 async()=>({id:uuid(31)}),async()=>({id:uuid(41)}),async(a,t,u,msg,o)=>{opts=o;const report=await finalize(manifest);return {text:report.text,curation:report};},normalizeFlightMonitor,normalizeCurationConfig,()=>uuid(201));
const packed=await runner(routine);eq(packed.type,'curation-v1');eq(packed.userId,uuid(2));eq(packed.routineId,uuid(21));eq(packed.urls.length,4);eq(packed.contentStatus,'complete');eq(opts.routineId,routine.id);eq(opts.curationConfig.version,1);
eq((await runner({...routine,channel:'whatsapp'})).channel,'whatsapp');await reject(()=>runner({...routine,config:{curation:{}}}));
const {deliverRoutine:delivery}=createScheduledDelivery({curationStore:store,deliverCurationEdition,sendCurationChannel,
 sendEmail:async()=>{sends++;return receipt;},persistProactiveToThread:persist});
await pg.query('UPDATE mtr_harness.routines SET config=$1 WHERE id=$2',[JSON.stringify(routine.config),routine.id]);
const s0=sends;await delivery(routine,packed);eq(sends,s0+1);eq((await store.history({userId:uuid(2),routineId:uuid(21)})).length,5);
await reject(()=>delivery({...routine,user_id:uuid(1)},packed));eq(sends,s0+1);
const {deliverRoutine:email}=createScheduledDelivery({sendEmail:async()=>receipt,persistProactiveToThread:async()=>{}});eq(await email(routine,'body'),{...receipt,channel:'email',status:'accepted'});
// Exact post-model branch emits guarded renderer, not raw JSON.
const a=server.indexOf('  let curationResult = null;'),b=server.indexOf('  // Rede de segurança:',a);
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const turn=new AsyncFunction('text','curationHistory','opts','userId','routineCheck','searchCoverage','finalizeCuration','conferirLinks','curationEvidence',server.slice(a,b)+';return {text,curationResult};');
const fixedFinalize=(args,deps)=>finalizeCuration({...args,now:'2026-09-11T15:00:00Z'},deps);
const branch=await turn(manifest,[],{curationConfig:cfg,routineId:uuid(21)},uuid(2),{failed:false},{hasPartial:()=>false},fixedFinalize,checkLinks);ok(branch.text.includes('Mercado'));eq(branch.curationResult.urls.length,4);
// The actual server branch forwards per-execution readings into validation.
const {createCurationEvidence}=await import('./web/curation-evidence.mjs');
const observed=createCurationEvidence();
const quotations=['Verifiable synthetic observation.','Another factual synthetic finding.','Observed result with documented limitations.'];
const observedItems=items.map(i=>({...i,summary:quotations,sourceQuotes:quotations,dateQuote:'Published September 10, 2026'}));
for(const i of observedItems)observed.observe({name:'abrir_link',args:{url:i.url}},`Conteúdo de ${i.url}:\n\n${i.title}\n${i.dateQuote}\n${quotations.join('\n')}`);
const evidenceBranch=await turn(JSON.stringify({items:observedItems,checks}),[],{curationConfig:cfg,routineId:uuid(21)},uuid(2),{failed:false},{hasPartial:()=>false},fixedFinalize,checkLinks,observed);
eq(evidenceBranch.curationResult.urls.length,4);eq(evidenceBranch.curationResult.audit.observedWebSources,4);
const mismatch=await turn(JSON.stringify({items:[{...observedItems[0],date:'2026-09-09'},...observedItems.slice(1)],checks}),[],{curationConfig:cfg,routineId:uuid(21)},uuid(2),{failed:false},{hasPartial:()=>false},fixedFinalize,checkLinks,observed);
eq(mismatch.curationResult.urls.length,3);ok(mismatch.curationResult.diagnostic.includes('date_not_supported'));
let repairs=0;const retryUsages=[];const retryLogs=[];
const retryTurn=new AsyncFunction('text','curationHistory','opts','userId','routineCheck','searchCoverage','finalizeCuration','conferirLinks','runAgent','ToolRegistry','curationRepairPrompt','provider','systemFor','agent','mediaLibrary','subdomain','activeProject','appsManual','userLang','ACTION_EVIDENCE_POLICY','messages','usages','console','curationEvidence','preferCurationRepair',server.slice(a,b)+';return {text,curationResult};');
const retried=await retryTurn('[ROTINA_SEM_NOVIDADES]',[],{curationConfig:cfg,routineId:uuid(21)},uuid(2),{failed:false},{hasPartial:()=>false},fixedFinalize,checkLinks,async()=>{repairs++;return {text:manifest,usages:[{model:'synthetic-repair'}]};},class {},curationRepairPrompt,{},()=>'',{},[],null,null,false,'pt-BR','',[],retryUsages,{warn:s=>retryLogs.push(s),log:s=>retryLogs.push(s)},undefined,preferCurationRepair);
eq(repairs,1);eq(retryUsages.length,1);eq(retried.curationResult.executionStatus,'completed');eq(retried.curationResult.repairable,false);ok(retryLogs.some(s=>s.includes('repair=attempt')));ok(retryLogs.some(s=>s.includes('repair=completed')));
// Preflight fails before model/search; source position below credit gate.
ok(server.indexOf('let curationHistory = null')>server.indexOf('if (credit.over)'));
ok(!readFileSync('web/db.mjs','utf8').includes('CREATE TABLE mtr_harness.curation_deliveries'));
ok(readFileSync('web/scheduler.mjs','utf8').includes("text?.type === 'curation-v1'"));
// Datas futuras/antigas são filtradas antes da contagem; sem inventar substitutos.
for(const date of ['2026-09-12','2025-09-10']){const r=await finalize(JSON.stringify({items:[{...items[0],date},...items.slice(1)],checks}));eq(r.coverageSatisfied,false);eq(r.urls.includes(url(1)),false);eq(r.audit.discarded.windowSectionOrExclusion,1);ok(!r.text.includes('janela de publicação'));}
// Scheduler real preserva envelope, sem chamar canal real.
const savedInterval=globalThis.setInterval,savedClear=globalThis.clearInterval,NativeDate=Date;
class FixedDate extends NativeDate {constructor(...a){super(...(a.length?a:['2026-09-11T08:00:00Z']));}static now(){return NativeDate.parse('2026-09-11T08:00:00Z');}}
globalThis.Date=FixedDate;
globalThis.setInterval=()=>({unref(){}});globalThis.clearInterval=()=>{};
const {startScheduler}=await import('./web/scheduler.mjs');let deliveries=0;
const scheduled={...routine,hour:8,days:'daily',tz:'UTC',enabled:true,last_run_day:''};
const scheduler=startScheduler({listDueRoutines:async()=>[scheduled],markRoutineRun:async(id,day)=>{scheduled.last_run_day=day;},runRoutine:async()=>packed,deliver:async(r,e)=>{eq(e.type,'curation-v1');eq(e.urls.length,4);deliveries++;}});
for(let i=0;i<40;i++)await Promise.resolve();await scheduler.tick();eq(deliveries,1);scheduler.stop();globalThis.setInterval=savedInterval;globalThis.clearInterval=savedClear;globalThis.Date=NativeDate;
// Preflight real: storage indisponível bloqueia antes de busca/modelo.
const preA=server.indexOf('  let curationHistory = null;'),preB=server.indexOf('  // Monitor tipado aprovado:',preA);let stored=0;
const preflight=new AsyncFunction('kind','opts','userId','curationStore','normalizeCurationConfig','thread','agent','message','saveThreadTurn','createCurationEvidence','const baseHistory=structuredClone(thread.history||[]);'+server.slice(preA,preB));
const stopped=await preflight('routine',{curationConfig:cfg,routineId:uuid(21)},uuid(2),{history:async()=>{throw Error('offline');}},normalizeCurationConfig,{id:uuid(41),history:[]},{id:uuid(31)},'synthetic',async()=>stored++,createCurationEvidence);eq(stored,1);eq(stopped.curation.urls,[]);eq(stopped.curation.executionStatus,'failed');ok(stopped.text.includes('Não iniciei novas buscas'));
ok(server.includes("preview: ['flight-monitor-v1','curation-v1'].includes(text?.type) ? text.text : text"));
ok(server.includes('text = curationResult ? text : searchCoverage.finish(text, userLang,'));
ok(server.includes('audit:curationResult.audit'));
const exclusionConfig={...cfg,excludeUrls:[url(1)+'?utm_source=old']};
const excluded=await finalizeCuration({text:manifest,config:exclusionConfig,...scope,history:[],now:'2026-09-11T15:00:00Z'},{checkLinks});eq(excluded.urls.includes(url(1)),false);eq(excluded.coverageSatisfied,false);eq(excluded.audit.discarded.windowSectionOrExclusion,1);ok(!excluded.text.includes('exclusão manual'));
eq(normalizeCurationConfig(exclusionConfig).excludeUrls,[url(1)]);ok(curationPrompt(exclusionConfig,[]).includes('não provam entrega'));
await pg.close();console.log(`OK: ${count} verificações de curadoria integrada; SQL PostgreSQL local, runner/render/entrega reais isolados; zero I/O real.`);
