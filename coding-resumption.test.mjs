import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodingJobs,codingJobScope,codingControlIntent} from './web/coding-jobs.mjs';
import {codingDeliveryKey} from './web/coding-recovery-policy.mjs';
const identity={userId:'synthetic',agentId:'agent',threadId:'thread'},scope=codingJobScope(identity);
const input={kind:'advanced',args:{objetivo:'Original'},policy:'policy'};
function fixture({reason='account_credit_reserved',creditStatus}={}){
 const records=new Map(),locks=new Map(),deliveries=new Map();let count=0,cancels=0;
 const copy=x=>structuredClone(x);
 const store={read:async key=>copy(records.get(key)||null),entries:async()=>[...records].map(([scope,record])=>({scope,record:copy(record)})),
  withTask:async(key,run)=>{const prior=locks.get(key)||Promise.resolve();let release;locks.set(key,new Promise(r=>release=r));await prior;try{return await run({record:copy(records.get(key)||null),save:async r=>records.set(key,copy(r))});}finally{release();}}};
 const jobs=createCodingJobs({store,creditStatus,cancelTask:async()=>{cancels++;},
  execute:async job=>{count++;return count===1?{coding_task:{state:'paused',reason,calls:7,tokens:100},text:'Pausa sintética.'}
   :{coding_task:{state:'completed',reason:'completed',calls:8,tokens:110},text:job.args.objetivo};},
  deliver:async job=>deliveries.set(codingDeliveryKey(job),job.result.text)});
 return {jobs,store,records,deliveries,get count(){return count;},get cancels(){return cancels;}};
}
test('paused task holds queued objectives until explicit resume and completion',async()=>{
 const f=fixture();await f.jobs.submit(identity,input,'first');await f.jobs.submit(identity,{...input,args:{objetivo:'Next'}},'second');
 await f.jobs.drive(scope);await f.jobs.drive(scope);await f.jobs.tick();
 assert.equal(f.count,1);assert.equal((await f.jobs.status(identity)).programming_job.state,'paused');
 assert.equal((await f.jobs.status(identity)).programming_job.queued,1);
 assert.equal((await f.jobs.metrics()).followupsHeldByPause,1);
 await f.jobs.resume(identity,{policy:'policy',requestId:'resume-1'});await f.jobs.drive(scope);
 assert.equal(f.count,2);assert.equal((await f.jobs.status(identity)).programming_job.state,'queued');
 await f.jobs.drive(scope);assert.equal(f.count,3);assert.equal([...f.deliveries.values()].at(-1),'Next');
});
test('new request while paused is recorded separately rather than replacing progress',async()=>{
 const f=fixture();const initial=await f.jobs.submit(identity,input,'first');await f.jobs.drive(scope);
 const next=await f.jobs.submit(identity,{...input,args:{objetivo:'New objective'}},'second');
 assert.equal(next.programming_job.id,initial.programming_job.id);assert.equal(next.queued_request,true);
 assert.match(next.text,/pausada/);assert.equal(f.count,1);
});
test('duplicate resume decision cannot create a second generation after another pause',async()=>{
 const f=fixture();await f.jobs.submit(identity,input,'first');await f.jobs.drive(scope);
 await Promise.all([f.jobs.resume(identity,{policy:'policy',requestId:'same'}),f.jobs.resume(identity,{policy:'policy',requestId:'same'})]);
 assert.equal((await f.jobs.status(identity)).programming_job.resumeCount,1);
 await f.store.withTask(scope,async({record,save})=>save({...record,state:'paused',delivered:true}));
 assert.equal((await f.jobs.resume(identity,{policy:'policy',requestId:'same'})).replay,true);
 assert.equal((await f.jobs.status(identity)).programming_job.resumeCount,1);
});
test('uncertain effects and policy changes cannot be cleared by asking to resume',async()=>{
 const f=fixture({reason:'uncertain_action'});await f.jobs.submit(identity,input,'first');await f.jobs.drive(scope);
 assert.equal((await f.jobs.resume(identity,{policy:'policy'})).ok,false);assert.equal(f.count,1);
 assert.equal((await f.jobs.status(identity)).programming_job.recovery.canResume,false);
 const g=fixture();await g.jobs.submit(identity,input,'first');await g.jobs.drive(scope);
 assert.equal((await g.jobs.resume(identity,{policy:'different'})).ok,false);
 assert.equal((await g.jobs.status(identity)).programming_job.state,'paused');
});
test('canceling paused work clears its queue, preserves terminal status and invokes checkpoint cancellation once',async()=>{
 const f=fixture();await f.jobs.submit(identity,input,'first');await f.jobs.submit(identity,input,'second');await f.jobs.drive(scope);
 await f.jobs.cancel(identity);await f.jobs.cancel(identity);
 const status=await f.jobs.status(identity);assert.equal(status.programming_job.state,'cancelled');assert.equal(status.programming_job.queued,0);assert.equal(f.cancels,1);
});
test('status distinguishes free balance, reservations and unavailable accounting without executing',async()=>{
 let reads=0;
 const f=fixture({creditStatus:async()=>{reads++;return {remaining:50,held:20,available:30};}});
 await f.jobs.submit(identity,input,'first');const status=await f.jobs.status(identity);
 assert.equal(status.accountCredits.available,30);assert.equal(status.accountCredits.held,20);assert.equal(reads,1);assert.equal(f.count,0);
 const g=fixture({creditStatus:async()=>{throw Error('unavailable');}});await g.jobs.submit(identity,input,'first');
 assert.equal((await g.jobs.status(identity)).accountCredits,null);assert.match((await g.jobs.status(identity)).text,/não indica saldo esgotado/);
});
test('cancellation racing a resume cannot revive paused work or discard recorded consumption',async()=>{
 const f=fixture();await f.jobs.submit(identity,input,'first');await f.jobs.drive(scope);
 await Promise.all([f.jobs.resume(identity,{policy:'policy',requestId:'race'}),f.jobs.cancel(identity)]);
 await f.jobs.drive(scope);
 const result=await f.jobs.status(identity);assert.equal(result.programming_job.state,'cancelled');assert.equal(f.count,1);
 assert.equal(result.programming_job.consumption.calls,7);assert.equal(result.programming_job.consumption.tokens,100);
});
test('cancellation stays durable when a paused worker still holds the job lock',async()=>{
 const f=fixture();await f.jobs.submit(identity,input,'first');await f.jobs.drive(scope);
 const original=f.store.withTask;
 f.store.withTask=async(key,run)=>{if(key===scope)throw Object.assign(Error('busy'),{code:'TASK_LOCK_BUSY'});return original(key,run);};
 assert.match((await f.jobs.cancel(identity)).text,/Recebi o pedido para parar/);
 f.store.withTask=original;
 await f.jobs.tick();
 for(let i=0;i<20&&(await f.jobs.status(identity)).programming_job.state!=='cancelled';i++)await new Promise(r=>setImmediate(r));
 assert.equal((await f.jobs.status(identity)).programming_job.state,'cancelled');assert.equal(f.cancels,1);assert.equal(f.count,1);
});
test('an approved scope continuation can replace a paused job while preserving queued follow-ups',async()=>{
 const f=fixture({reason:'scope_clarification'});await f.jobs.submit(identity,input,'first');await f.jobs.submit(identity,input,'second');await f.jobs.drive(scope);
 const result=await f.jobs.submit(identity,{...input,confirmationId:'approved'},'confirmation:approved');
 assert.equal(result.programming_job.state,'queued');assert.equal(result.programming_job.queued,1);
 assert.equal((await f.store.read(scope)).requestId,'confirmation:approved');
});
test('resume grammar is explicit and does not act on quotations or unrelated text',()=>{
 for(const text of ['retomar programação','retome a tarefa','continue a programação','continuar trabalho'])assert.equal(codingControlIntent(text),'resume');
 for(const text of ['O documento diz “continue”','continue','continue a explicação','pode seguir com outro assunto'])assert.equal(codingControlIntent(text),null);
});
