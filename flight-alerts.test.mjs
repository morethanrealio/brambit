import { createScheduledDelivery } from './web/scheduled-delivery.mjs';
// Isolated dry-run: fake providers, DB and delivery. Never start server.
import { marca } from './web/marca.mjs';
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {createHash} from 'node:crypto';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
const {flightPriceCents,percentageDrop}=await import('./web/flight-alert-policy.mjs');
const {normalizeFlightMonitor,flightAlertQueryKey,executeFlightMonitor}=await import('./web/flight-monitor.mjs');
let count=0;const eq=(a,b)=>{assert.deepEqual(a,b);count++;},ok=a=>{assert.ok(a);count++;},bad=fn=>{assert.throws(fn);count++;};
const now='2026-09-11T12:00:00Z',tz='America/Sao_Paulo';
const q={origem:'AAA',destino:'BBB',data_ida:'2027-04-13',data_volta:'2027-04-28',adultos:2,criancas:2,classe:'economica',paradas:'qualquer',companhias:['AD']};
const route=(query=q,price=100000)=>({query,reference:{kind:'fixed',priceCents:price,queryKey:flightAlertQueryKey(query),priceBasis:'provider_price',currency:'BRL'}});
const cfg=(routes=[route()])=>({version:2,routes,dropBps:1500});
const quote=(price=849.99,extra={})=>({price,currency:'BRL',observedAt:now,fromCache:false,stale:false,freshRequested:true,link:'https://www.google.com/travel/flights?fixture=1',...extra});
for(const [v,want] of [[1,100],[1.23,123],[0.01,1],[1e8,1e10],[1.001,null],[0,null],[-1,null],[NaN,null],[Infinity,null],['100',null],[null,null],[5e-324,null]])eq(flightPriceCents(v),want);
for(const [price,expected] of [[85001,false],[85000,false],[84999,true],[100000,false],[120000,false],[1,true]])eq(percentageDrop(price,100000,1500).triggered,expected);
for(const n of [0,-1,NaN,Infinity,1.5,10000000001])bad(()=>percentageDrop(n,100000,1500));
for(const n of [0,10000,1500.1,'1500'])bad(()=>percentageDrop(90000,100000,n));
for(const reference of [100,101,100000,445700,1e10]){
 for(const price of [1,Math.round(reference*.85),Math.round(reference*.85)-1,reference,reference+1]){
  if(price>1e10||price<=0)continue;
  eq(percentageDrop(price,reference,1500).triggered,(BigInt(reference)-BigInt(price))*10000n>BigInt(reference)*1500n);
 }
}
for(const raw of [{...cfg(),unknown:true},{...cfg(),dropBps:15.5},{...cfg(),routes:[]},{...cfg(),routes:Array(4).fill(route())},cfg([route(),route()]),cfg([{...route(),reference:{...route().reference,queryKey:'mismatch'}}]),cfg([{...route(),reference:{...route().reference,priceBasis:'family_total'}}]),cfg([{...route(),reference:{...route().reference,currency:'USD'}}]),cfg([{...route(),reference:{...route().reference,priceCents:'100000'}}])])bad(()=>normalizeFlightMonitor(raw));
const canonical=normalizeFlightMonitor(cfg());eq(canonical.routes[0].query.companhias,['AD']);
for(const field of ['origem','destino','data_ida','data_volta','adultos','criancas','classe','paradas','companhias']){
 const values={origem:'CCC',destino:'DDD',data_ida:'2027-04-14',data_volta:'2027-04-29',adultos:3,criancas:1,classe:'executiva',paradas:'direto',companhias:['G3']};
 const changed={...q,[field]:values[field]};ok(flightAlertQueryKey(changed)!==flightAlertQueryKey(q));bad(()=>normalizeFlightMonitor(cfg([{...route(),query:changed}])));
}
function harness(config=cfg(),quotes=[quote()],extra={}){
 const calls=[];let i=0;
 const deps={now:()=>now,readPrevious:async r=>{calls.push(['read',r]);return null;},record:async r=>calls.push(['record',r]),search:async(query,options)=>{calls.push(['search',query,options]);return quotes[i++];},...extra};
 return {calls,run:()=>executeFlightMonitor({config,userId:'mock-user',routineId:'mock-routine',tz,now},deps)};
}
for(const price of [850,850.01,849.99,826,700,1200]){
 const h=harness(cfg(),[quote(price)]),r=await h.run();eq(r.deliver,price<850);eq(h.calls.filter(x=>x[0]==='search').length,1);eq(h.calls.filter(x=>x[0]==='record').length,1);
 eq(h.calls.find(x=>x[0]==='search')[2],{fresh:true});eq(h.calls.find(x=>x[0]==='record')[1].userId,'mock-user');ok(r.text.includes('referência fixa'));ok(r.templateText.length<=900);ok(!/[\r\n\t]/.test(r.templateText));
}
// Only fully checked non-op suppresses delivery, partial failure never means no deals.
for(const value of [null,quote(100,{stale:true}),quote(100,{fromCache:true}),quote(100,{freshRequested:false}),quote(100,{observedAt:'bad'}),quote(100,{observedAt:'2026-09-11T11:59:00Z'}),quote(100,{observedAt:'2026-09-10T12:00:00Z'}),quote(100,{observedAt:'2026-09-11T12:00:01Z'}),quote(100,{currency:'USD'}),quote(100.001)]){
 const h=harness(cfg(),[value]);const r=await h.run();eq(r.deliver,true);ok(r.text.includes('sem cotação nova válida'));eq(h.calls.filter(x=>x[0]==='record').length,0);ok(!r.text.includes('ALERTA acionado'));
}
{
 const h=harness(cfg([route(),route({...q,origem:'CCC'})]),[],{readPrevious:async()=>{throw Error('MOCK TABLE ABSENT');}});const r=await h.run();ok(r.text.includes('histórico indisponível'));eq(h.calls,[]);
}
{
 const old={...q,data_ida:'2026-04-13',data_volta:'2026-04-28'},h=harness(cfg([route(old)]));const r=await h.run();ok(r.text.includes('no passado'));eq(h.calls,[]);
}
{
 const h=harness(cfg(),[quote()],{record:async()=>{throw Error('MOCK WRITE FAILURE');}});const r=await h.run();ok(r.text.includes('falha ao guardar'));eq(h.calls.filter(x=>x[0]==='search').length,1);eq(r.deliver,true);
}
{
 const routes=[route(),route({...q,origem:'CCC'}),route({...q,origem:'DDD'})];
 const h=harness(cfg(routes),[quote(850),quote(800),null]);const r=await h.run();eq(r.deliver,true);ok(r.text.includes('CCC'));ok(r.text.includes('sem cotação'));eq(h.calls.filter(x=>x[0]==='read').length,3);eq(h.calls.filter(x=>x[0]==='record').length,2);
 ok(h.calls.slice(0,3).every(x=>x[0]==='read'));ok(r.templateText.length<=900);
}
{
 const r=route();r.reference.kind='previous_day';delete r.reference.priceCents;
 for(const prev of [null,{query_key:r.reference.queryKey,price:1000,currency:'BRL',observation_day:'2026-09-10',observed_at:'2026-09-10T12:00:00Z'}, {query_key:'wrong',price:1000,currency:'BRL',observation_day:'2026-09-10',observed_at:'2026-09-10T12:00:00Z'}]){
  const h=harness(cfg([r]),[quote()],{readPrevious:async()=>prev});const result=await h.run();eq(result.text.includes('ALERTA acionado'),prev?.query_key===r.reference.queryKey);eq(result.text.includes('sem referência comparável'),prev?.query_key!==r.reference.queryKey);
 }
}
// Actual flight tool in VM: fresh bypasses local fallback AND SerpApi cache.
const source=readFileSync('./web/voos.mjs','utf8').replace(/import \{ createHash \} from 'node:crypto';/,'').replace(/import \{[\s\S]*?\} from '\.\/db.mjs';/,'').replace("import { marca } from './marca.mjs';",'').replaceAll('export ','');
let http=[],cacheReads=0,cacheWrites=0,mode='good',observed;
const ctx=vm.createContext({marca,createHash,Date,process:{env:{SERPAPI_KEY:'MOCK_ONLY'}},URLSearchParams,AbortSignal,Intl,Number,String,Set,
 getFlightCache:async()=>{cacheReads++;return {payload:{best_flights:[{price:1}]},stale:false,fetchedAt:now,ageMin:0};},
 putFlightCache:async()=>cacheWrites++,recordFlightPrice:async()=>{},flightPriceStats:async()=>null,setTimeout:f=>f(),
 fetch:async(u)=>{const url=new URL(u);eq(url.hostname,'serpapi.com');eq(url.searchParams.get('api_key'),'MOCK_ONLY');http.push(url);return {ok:true,json:async()=>mode==='fail'?{error:'MOCK_FAILURE'}:{best_flights:[{price:800,flights:[{airline:'MOCK',flight_number:'AD 123'}]}],search_parameters:{currency:'BRL'},search_metadata:{created_at:now}}};},
});
vm.runInContext(source+';globalThis.tools=voosTools;',ctx);
const fresh=ctx.tools('u','a',{fresh:true,onObservation:r=>observed=r})[0];await fresh.run(q);
eq(cacheReads,0);eq(http.length,1);eq(http[0].searchParams.get('no_cache'),'true');eq(http[0].searchParams.get('include_airlines'),'AD');eq(http[0].searchParams.get('stops'),null);eq(observed.freshRequested,true);eq(observed.observedAt,now);
mode='fail';observed=null;await fresh.run(q);eq(observed,null);eq(cacheReads,0);eq(http.length,2);
await fresh.run({...q,companhias:['AD&no_cache=false']});eq(http.length,2);
// Production envelope survives runner to delivery; no user/tool text can set flag.
const server=readFileSync('./web/server.mjs','utf8');
const extract=name=>{const a=server.indexOf('async function '+name+'('),b=server.indexOf('\n}\n',a)+2;assert.ok(a>=0&&b>a);return server.slice(a,b);};
let deliveries=0;const {deliverRoutine:deliver}=createScheduledDelivery({sendEmail:denied,
 waEnabled:()=>true,getWhatsAppLinkForUser:async()=>({wa_phone:'synthetic'}),
 sendWhatsAppProactive:async()=>{deliveries++;return {wamid:'synthetic-'+deliveries};},whatsappProse:denied,persistProactiveToThread:async()=>{}});
await deliver({channel:'whatsapp'},{type:'flight-monitor-v1',text:'Audit no-op',templateText:'Audit no-op',deliver:false});eq(deliveries,0);
await deliver({channel:'whatsapp'},{type:'flight-monitor-v1',text:'Alerta',templateText:'Alerta',deliver:true});eq(deliveries,1);
let output={text:'Audit no-op',templateText:'Audit no-op',deliver:false};
const runner=new Function('getAgentOwned','getOrCreateThreadByTitle','runConversationInThread','normalizeFlightMonitor',extract('runRoutine')+';return runRoutine;')(async()=>({id:'a'}),async()=>({id:'t'}),async()=>output,normalizeFlightMonitor);
const envelope=await runner({agent_id:'a',user_id:'u',config:{flight_monitor:cfg()}});eq(envelope.deliver,false);await deliver({channel:'whatsapp'},envelope);eq(deliveries,1);
ok(server.includes('search:async (query, {fresh=false}={})'));

// Cents boundary is not a rounded 15% decision; templates retain amounts.
{
 const boundary=await harness(cfg(),[quote(849.99)]).run();ok(boundary.text.includes('15,0010%'));ok(boundary.text.includes('Comparação sem arredondar'));
 const high=await harness(cfg(),[quote(1200)]).run();ok(high.text.includes('alta de'));ok(!high.text.includes('-20'));
 for(const price of [0.01,1e8]){
  const routes=['AAA','CCC','DDD'].map(origem=>route({...q,origem},price===0.01?1e10:1));
  const r=await harness(cfg(routes),Array(3).fill(quote(price)),{record:async()=>{throw Error('mock');}}).run();
  ok(r.templateText.length<=900);ok(r.templateText.includes('ref. fixa'));ok(!/[\r\n\t]/.test(r.templateText));
 }
 const r=route();r.reference.kind='previous_day';delete r.reference.priceCents;
 for(const prev of [
  {query_key:r.reference.queryKey,currency:'BRL',price:1000,observation_day:'2026-09-10',observed_at:'bad'},
  {query_key:r.reference.queryKey,currency:'BRL',price:1000.001,observation_day:'2026-09-10',observed_at:'2026-09-10T12:00:00Z'},
  {query_key:r.reference.queryKey,currency:'BRL',price:1000,observation_day:'2026-09-09',observed_at:'2026-09-09T12:00:00Z'}]) {
   const result=await harness(cfg([r]),[quote()],{readPrevious:async()=>prev}).run();ok(result.text.includes('sem referência comparável'));ok(!result.text.includes('ALERTA acionado'));
 }
}
// Real typed branch -> real flight tool -> real scheduler -> delivery. Fake I/O.
const NativeDate=Date;let clock=NativeDate.parse(now);
class FakeDate extends NativeDate {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
globalThis.Date=FakeDate;
const cacheKeys=[],pipelineHttp=[],saved=[],records=[];let apiPrice=850,sourceTime=now,networkMode='good';
const vctx=vm.createContext({marca,Date:FakeDate,createHash,process:{env:{SERPAPI_KEY:'MOCK_ONLY'}},URLSearchParams,AbortSignal,Intl,Number,String,Set,
 getFlightCache:async key=>{cacheKeys.push(key);return null;},putFlightCache:async key=>cacheKeys.push(key),recordFlightPrice:async()=>{},flightPriceStats:async()=>null,setTimeout:f=>f(),
 fetch:async url=>{pipelineHttp.push(new URL(url));if(networkMode==='timeout')throw Error('MOCK_TIMEOUT');return {ok:networkMode!=='http-error',status:500,json:async()=>({best_flights:[{price:apiPrice,flights:[{airline:'MOCK',flight_number:'AD 123'}]}],search_parameters:{currency:'BRL'},search_metadata:{created_at:sourceTime}})};},
});
vm.runInContext(source+';globalThis.tools=voosTools;',vctx);
const branchStart=server.indexOf("  if (kind === 'routine' && opts.flightMonitor");
const branch=server.slice(branchStart,server.indexOf('  // Confirmation guard: if a write action',branchStart));
const bctx=vm.createContext({kind:'routine',opts:{flightMonitor:cfg(),routineId:'mock-routine',routineTimezone:tz},
 userId:'mock-user',agent:{id:'mock-agent'},thread:{id:'mock-thread',history:[],summary:''},message:'mock-prompt',userTz:tz,
 executeFlightMonitor,voosTools:vctx.tools,randomUUID:()=> 'mock-turn',previousFlightObservation:async()=>null,
 recordFlightObservation:async r=>records.push(r),recordUsages:async()=>{},saveThreadTurn:async(id,aid,r)=>saved.push(r)});
const run=()=>vm.runInContext(`(async()=>{const baseHistory=JSON.parse(JSON.stringify(thread.history||[]));${branch}})()`,bctx);
const normal=await run();eq(normal.deliver,false);eq(saved.at(-1).assistantMsg,normal.text);eq(records.length,1);eq(pipelineHttp.at(-1).searchParams.get('no_cache'),'true');
apiPrice=849.99;const alert=await run();eq(alert.deliver,undefined);ok(alert.templateText.includes('849,99'));ok(alert.templateText.includes('1.000,00'));
for(const stamp of [undefined,'2026-09-10T12:00:00Z','bad']) {sourceTime=stamp;const n=records.length,r=await run();ok(r.text.includes('sem cotação nova válida'));eq(records.length,n);eq(r.deliver,undefined);}
sourceTime=now;
for(const mode of ['timeout','http-error']){networkMode=mode;const n=pipelineHttp.length,r=await run();eq(pipelineHttp.length,n+1);ok(r.text.includes('sem cotação nova válida'));}
networkMode='good';
// Airline filters canonicalize both search and cache; digit-first IATA supported.
cacheKeys.length=0;const ft=vctx.tools('u','a',{fresh:true})[0];
await ft.run({...q,companhias:['AD','2Z','AD']});const keyA=cacheKeys.at(-1);eq(pipelineHttp.at(-1).searchParams.get('include_airlines'),'2Z,AD');
await ft.run({...q,companhias:['2Z','AD']});eq(cacheKeys.at(-1),keyA);
await ft.run({...q,companhias:['AD']});ok(cacheKeys.at(-1)!==keyA);
const oldSet=globalThis.setInterval,oldClear=globalThis.clearInterval;
globalThis.setInterval=()=>({unref(){}});globalThis.clearInterval=()=>{};
const {startScheduler}=await import('./web/scheduler.mjs');
const schedRoutine={id:'mock-routine',hour:9,days:'daily',tz,enabled:true,last_run_day:'',channel:'whatsapp'};
let schedulerCalls=0;const beforeDelivery=deliveries;
const sch=startScheduler({listDueRoutines:async()=>[schedRoutine],markRoutineRun:async(id,day)=>{schedRoutine.last_run_day=day;},runRoutine:async()=>{schedulerCalls++;return {type:'flight-monitor-v1',...normal};},deliver});
for(let i=0;i<40;i++)await Promise.resolve();await sch.tick();eq(schedulerCalls,1);eq(deliveries,beforeDelivery);
clock+=86400000;await sch.tick();eq(schedulerCalls,2);eq(deliveries,beforeDelivery);
sch.stop();globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear;globalThis.Date=NativeDate;
console.log(`OK: ${count} verificações de alertas tipados; zero I/O real, zero configuração/migração/entrega de cliente.`);
