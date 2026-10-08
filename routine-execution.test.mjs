import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRoutineExecutor,createRoutineExecutionStore,routineExecutionInfo,routineExecutionText} from './web/routine-execution.mjs';import {startScheduler,localParts,isDue,ROUTINE_LATE_GRACE_MIN} from './web/scheduler.mjs';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();let checks=0;const ok=v=>{assert.ok(v);checks++;};
await db.exec(`CREATE SCHEMA mtr_harness;CREATE TABLE mtr_harness.routines(id text PRIMARY KEY,user_id text,config jsonb DEFAULT '{}',enabled bool DEFAULT true,last_run_day text,next_run timestamptz);INSERT INTO mtr_harness.routines(id,user_id,config) VALUES ('r','u','{"curation":{"version":2},"other":42}'),('s','v','{}');`);
const pool={query:(...a)=>db.query(...a)},store=createRoutineExecutionStore(pool),executor=createRoutineExecutor(store);const r={id:'r',user_id:'u'};const state=async()=>(await db.query("SELECT config FROM mtr_harness.routines WHERE id='r'")).rows[0].config;
let calls=0;const run=async()=>{calls++;return 'fixture report';},deliver=async()=>{calls++;return {status:'accepted'};};
const first=await executor.execute(r,{slot:'day:1',run,deliver});ok(first.status==='completed');ok(calls===2);ok((await state()).execution.status==='completed');ok((await state()).execution.phase==='finished');ok((await state()).execution.content.status==='complete');ok((await state()).execution.delivery.status==='accepted');ok((await state()).other===42&& (await state()).curation.version===2);
await assert.rejects(()=>executor.execute(r,{slot:'day:1',run,deliver}),{code:'ROUTINE_BUSY'});checks++;ok(calls===2);
await assert.rejects(()=>executor.execute({...r,user_id:'v'},{slot:'wrong-owner',run,deliver}),{code:'ROUTINE_BUSY'});checks++;
await assert.rejects(()=>executor.execute(r,{slot:'day:2',run:async()=>{throw Error('secret provider traceback');},deliver}));checks++;ok((await state()).execution.status==='failed');ok((await state()).execution.content.status==='unknown');ok((await state()).execution.delivery.status==='not_attempted');ok(!JSON.stringify(await state()).includes('secret'));
await assert.rejects(()=>executor.execute(r,{slot:'day:3',run,deliver:async()=>{throw Error('timeout');}}));checks++;ok((await state()).execution.status==='uncertain');ok((await state()).execution.content.status==='complete');ok((await state()).execution.delivery.status==='uncertain');
const empty=await executor.execute(r,{slot:'day:4',run:async()=>'',deliver:()=>{throw Error('must not send');}});ok(empty.status==='no_output');ok((await state()).execution.content.status==='no_output');ok((await state()).execution.delivery.status==='not_attempted');
const partial=await executor.execute(r,{slot:'day:4-partial',run:async()=>({type:'curation-v1',text:'partial report',contentStatus:'partial'}),deliver});ok(partial.status==='partial');ok((await state()).execution.content.status==='partial');ok((await state()).execution.delivery.status==='accepted');
const failedContent=await executor.execute(r,{slot:'day:4-failed',run:async()=>({type:'curation-v1',text:'failure notice',contentStatus:'failed'}),deliver});ok(failedContent.status==='failed');ok((await state()).execution.content.status==='failed');ok((await state()).execution.delivery.status==='accepted');
const legacyTyped=await executor.execute(r,{slot:'day:4-execution-status',run:async()=>({type:'curation-v1',text:'partial legacy report',executionStatus:'partial'}),deliver});ok(legacyTyped.contentStatus==='partial');ok((await state()).execution.content.status==='partial');ok((await state()).execution.delivery.status==='accepted');
await executor.execute(r,{slot:'day:4-notice',run,deliver:async()=>({status:'accepted',channel:'email',id:'fixture',notification:{channel:'whatsapp',status:'uncertain',error:'private text must not persist'}})});
assert.deepEqual((await state()).execution.delivery.notification,{channel:'whatsapp',status:'uncertain'});checks++;ok(!JSON.stringify(await state()).includes('private text'));ok(routineExecutionText({config:await state()}).includes('Aviso adicional no canal whatsapp: não confirmado'));
let release,entered;const started=new Promise(resolve=>entered=resolve);const waiting=new Promise(resolve=>release=resolve);
const inFlight=executor.execute(r,{slot:'day:5',run:async()=>{entered();return waiting;},deliver});await started;ok(executor.activeCount===1);
await assert.rejects(()=>executor.execute(r,{slot:'manual:2',run,deliver}),{code:'ROUTINE_BUSY'});checks++;release('done');await inFlight;ok(executor.activeCount===0);
// Simulated SIGKILL: durable claim remains running; expired lease becomes interrupted, no rerun.
ok(await store.claim(r,'day:6','dead-worker'));await db.exec("UPDATE mtr_harness.routines SET config=jsonb_set(config,'{execution,leaseUntil}','\"2000-01-01T00:00:00Z\"') WHERE id='r'");await executor.recover();ok((await state()).execution.status==='interrupted');ok(!await store.claim(r,'day:6','retry'));ok(!await store.finish(r,'dead-worker','completed'));
// Fresh heartbeat prevents false interruption; failed lease ownership blocks delivery.
ok(await store.claim(r,'day:7','alive'));await store.phase(r,'alive','generating');await executor.recover();ok((await state()).execution.status==='running');await store.finish(r,'alive','completed');
let release2,entered2;const start2=new Promise(resolve=>entered2=resolve),wait2=new Promise(resolve=>release2=resolve);const exec2=createRoutineExecutor(store);let sends=0;
const p=exec2.execute(r,{slot:'day:8',run:async()=>{entered2();return wait2;},deliver:async()=>{sends++;}});await start2;await exec2.interrupt();release2('after shutdown');await assert.rejects(()=>p);checks++;ok(sends===0);ok((await state()).execution.status==='interrupted');
await assert.rejects(()=>exec2.execute(r,{slot:'afterclose',run,deliver}),{code:'ROUTINE_BUSY'});checks++;
ok(routineExecutionInfo({config:{execution:{status:'running',leaseUntil:'2000-01-01',token:'private'}}}).status==='interrupted');
ok(!JSON.stringify(routineExecutionInfo({config:{execution:{status:'failed',token:'private'}}})).includes('private'));
const legacy={config:{execution:{status:'failed',phase:'delivering'}}};ok(routineExecutionInfo(legacy).content.status==='failed');ok(routineExecutionInfo(legacy).delivery.status==='unknown');ok(!routineExecutionText(legacy).includes('Entrega: falhou'));
await assert.rejects(()=>executor.execute(r,{slot:'bad-result',run:async()=>({unexpected:true}),deliver}));checks++;ok((await state()).execution.status==='failed');
// Scheduler uses durable executor before marking, drains in-flight work, starts no next routine on stop.
const current=localParts('UTC');let flow=[],unblock,entered3;const wait3=new Promise(resolve=>unblock=resolve),start3=new Promise(resolve=>entered3=resolve);
const deps={listDueRoutines:async()=>[{id:'s',user_id:'v',enabled:true,repeat_every_min:1,next_run:new Date(Date.now()-5000).toISOString(),tz:'UTC',title:'Synthetic'}],markRoutineNext:async()=>flow.push('mark'),markRoutineRun:async()=>flow.push('mark'),recoverRoutineExecutions:executor.recover,executeRoutine:executor.execute,runRoutine:async()=>{flow.push('run');entered3();return wait3;},deliver:async()=>{flow.push('deliver');return {status:'accepted',id:'synthetic-receipt'};}};
await db.query("UPDATE mtr_harness.routines SET next_run=$1 WHERE id='s'",[(await deps.listDueRoutines())[0].next_run]);
const pending=(await db.query("SELECT next_run FROM mtr_harness.routines WHERE id='s'")).rows[0].next_run;const origList=deps.listDueRoutines;deps.listDueRoutines=async()=>[(await origList())[0]].map(x=>({...x,next_run:pending}));
const scheduler=startScheduler(deps,{intervalMs:100000});const tick=scheduler.tick();await start3;let drained=false;const stopping=scheduler.stop().then(()=>drained=true);await Promise.resolve();ok(!drained);unblock('ok');await tick;await stopping;ok(drained);ok(flow.join(',')==='mark,run,deliver');await scheduler.tick();ok(flow.length===3);
await db.query("UPDATE mtr_harness.routines SET last_run_day='already' WHERE id='r'");ok(!await store.claim(r,'day:already','stale-scheduler'));
// Queue/restart delay: recovers on the same day within the grace period, but doesn't fire
// an old routine indefinitely. The tick's clock is captured only once:
// a slow first routine doesn't make the second one ineligible mid-batch.
const dueBase={enabled:true,hour:8,days:'weekdays',tz:'America/Sao_Paulo',last_run_day:'2026-09-11'};
ok(ROUTINE_LATE_GRACE_MIN===180);ok(isDue(dueBase,new Date('2026-09-14T12:30:00Z')));ok(!isDue(dueBase,new Date('2026-09-14T14:01:00Z')));
let clock=new Date('2026-09-14T11:05:00Z'),clockReads=0,fair=[];
const fairRoutines=[{...dueBase,id:'fair-1',title:'First'},{...dueBase,id:'fair-2',title:'Second'}];
const fairScheduler=startScheduler({
 listDueRoutines:async()=>fairRoutines,
 markRoutineRun:async(id,day)=>{fair.push(`mark:${id}:${day}`);},
 runRoutine:async r=>{fair.push(`run:${r.id}`);if(r.id==='fair-1')clock=new Date('2026-09-14T15:30:00Z');return 'ok';},
 deliver:async r=>{fair.push(`deliver:${r.id}`);},
},{intervalMs:100000,now:()=>{clockReads++;return clock;}});
await fairScheduler.tick();await fairScheduler.stop();ok(clockReads===1);ok(fair.filter(x=>x.startsWith('run:')).join(',')==='run:fair-1,run:fair-2');
// WhatsApp ingress has joined the drain since 053a9071; all six components
// must settle before clean exit, including the scheduler's active routines.
const server=readFileSync('web/server.mjs','utf8');ok(server.includes('const whatsappDrained=waHandler.stop()'));ok(server.includes('Promise.all([httpDrained,routinesDrained,financialDrained,discoveryDrained,codingDrained,whatsappDrained])'));ok(server.includes('routineExecutor.interrupt()'));ok(server.includes('executeRoutine:routineExecutor.execute'));ok(server.includes('async function executeRoutineNow('));ok(server.includes("name: 'executar_rotina_agora'"));
await db.close();console.log(`PASS ${checks} execution checks: actual SQL lease, scope, crash/failure/uncertain/no-output, duplicates, interruption fence, scheduler drain, manual integration`);
