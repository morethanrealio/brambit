import test from 'node:test';
import assert from 'node:assert/strict';
import {createCodingJobs,codingJobScope} from '../web/coding-jobs.mjs';

function fixture(){
  const rows=new Map(),effects=[];let tail=Promise.resolve();
  const copy=x=>x===undefined?undefined:structuredClone(x);
  const store={read:async key=>copy(rows.get(key)),entries:async()=>[...rows].map(([scope,record])=>({scope,record:copy(record)})),
    async withTask(key,run){let release;const prior=tail;tail=new Promise(r=>release=r);await prior;
      try{return await run({record:copy(rows.get(key)),save:async value=>{rows.set(key,copy(value));}});}finally{release();}}};
  const fresh=()=>createCodingJobs({store,execute:async job=>{effects.push(job.requestId);return {coding_task:{state:'completed'},text:'Synthetic result'};},deliver:async()=>{}});
  const scope={userId:'synthetic-user',agentId:'synthetic-agent',threadId:'synthetic-thread'},key=codingJobScope(scope);
  const input={kind:'basic',args:{app:'synthetic',objetivo:'Synthetic edit'},policy:'synthetic'};
  return {store,effects,fresh,scope,key,input};
}

test('a recovered approval cannot enqueue again after another job replaces the current record',async()=>{
  const f=fixture();const jobs=f.fresh();
  await jobs.submit(f.scope,f.input,'confirmation:A');await jobs.drive(f.key);
  await jobs.submit(f.scope,f.input,'normal:B');await jobs.drive(f.key);
  const replay=await f.fresh().submit(f.scope,f.input,'confirmation:A');
  assert.equal(replay.ok,true);assert.equal(replay.already_submitted,true);
  await f.fresh().drive(f.key);assert.deepEqual(f.effects,['confirmation:A','normal:B']);
  assert.equal((await f.store.read(f.key)).queuedInputs.length,0);
});

test('follow-up rotation preserves approval deduplication and canceled queued requests stay consumed',async()=>{
  const f=fixture();const jobs=f.fresh();
  await jobs.submit(f.scope,f.input,'normal:first');await jobs.submit(f.scope,f.input,'confirmation:follow');
  await jobs.submit(f.scope,f.input,'normal:last');await jobs.drive(f.key);await jobs.drive(f.key);
  assert.equal((await f.fresh().submit(f.scope,f.input,'confirmation:follow')).already_submitted,true);
  await jobs.submit(f.scope,f.input,'confirmation:canceled');await jobs.cancel(f.scope);await jobs.drive(f.key);
  await jobs.submit(f.scope,f.input,'normal:new');
  assert.equal((await f.fresh().submit(f.scope,f.input,'confirmation:canceled')).already_submitted,true);
  assert.deepEqual(f.effects,['normal:first','confirmation:follow']);
});
