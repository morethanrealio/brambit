// Assistant avatar photos at Vidu (avatar-photos.mjs, avatar-store.mjs): a
// registration that comes back old or never gets ready is done again, and a
// provider photo two avatars share (Vidu registers by content) leaves Vidu only
// when no avatar holds it anymore. No network; the store part runs on a
// disposable local PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxFixture,uuid} from '../test-support/wa-inbox-fixture.mjs';
import {postgresSkipReason} from '../test-support/local-postgres.mjs';
import {registerReadyPhoto,RENEW_AFTER} from '../web/avatar-photos.mjs';
import {avatarSchema,createAvatarStore} from '../web/avatar-store.mjs';

// A fake Vidu: `answers` are what each registration returns, then each read.
function fakeVidu(answers){
 const calls=[];let clock=1e12;
 const api={
  registerPhoto:async()=>{calls.push('register');return answers.shift();},
  readPhoto:async(v,id)=>{calls.push(`read ${id}`);return answers.shift();},
  deletePhoto:async(v,id)=>{calls.push(`delete ${id}`);},
 };
 return {calls,api,now:()=>clock,sleep:async ms=>{clock+=ms;}};
}
const at=ms=>new Date(1e12-ms).toISOString();

test('a registration that returns an old photo or never gets ready is deleted and done again',async()=>{
 const v=fakeVidu([
  {id:'1',status:'success',createdAt:at(RENEW_AFTER+1)}, // same content registered long ago
  {id:'2',status:'created',createdAt:at(0)},{id:'2',status:'created',createdAt:at(0)}, // stuck
  {id:'3',status:'created',createdAt:at(0)},{id:'3',status:'success',createdAt:at(0)},
 ]);
 const done=await registerReadyPhoto({vidu:{},image:'x',name:'n',api:v.api,now:v.now,sleep:v.sleep,deadline:500,step:1000});
 assert.deepEqual(done,{id:'3',createdAt:at(0),discarded:['1','2']});
 assert.deepEqual(v.calls,['register','delete 1','register','read 2','delete 2','register','read 3']);
});

test('a photo Vidu rejects is deleted and not retried; three stuck tries give up',async()=>{
 const rejected=fakeVidu([{id:'1',status:'created',createdAt:at(0)},{id:'1',status:'failed',createdAt:at(0)}]);
 await assert.rejects(registerReadyPhoto({vidu:{},image:'x',name:'n',api:rejected.api,now:rejected.now,sleep:rejected.sleep}),{code:'photo_rejected'});
 assert.deepEqual(rejected.calls,['register','read 1','delete 1']);
 const stuck=fakeVidu(Array.from({length:6},(_,i)=>({id:String(i>>1),status:'created',createdAt:at(0)})));
 await assert.rejects(registerReadyPhoto({vidu:{},image:'x',name:'n',api:stuck.api,now:stuck.now,sleep:stuck.sleep,deadline:500,step:1000}),{code:'photo_not_ready'});
 assert.equal(stuck.calls.filter(c=>c.startsWith('delete')).length,3);
});

test('a provider photo two avatars share stays at Vidu until neither holds it',{timeout:40000,skip:postgresSkipReason()},async t=>{
 const f=await inboxFixture();t.after(()=>f.close());
 await f.pool.query('ALTER TABLE mtr_harness.agents ADD COLUMN archived_at timestamptz');await f.pool.query('INSERT INTO mtr_harness.agents(id) VALUES($1)',[uuid(13)]);
 await avatarSchema({pool:f.pool,S:'mtr_harness'});
 const store=createAvatarStore({pool:f.pool,S:'mtr_harness'});
 const photo={buffer:Buffer.from('same face'),mime:'image/jpeg',sha256:'a'.repeat(64)};
 const other={buffer:Buffer.from('other face'),mime:'image/jpeg',sha256:'b'.repeat(64)};
 await store.save({agentId:uuid(11),userId:uuid(1),photo,consent:'self',voice:'Kore'});
 await store.save({agentId:uuid(12),userId:uuid(2),photo,consent:'authorized',voice:'Puck'});
 await store.save({agentId:uuid(13),userId:uuid(1),photo:other,consent:'fictional',voice:'Kore'});
 assert.equal(await store.markReady(photo.sha256,{id:'old',createdAt:at(0)}),2);
 assert.equal(await store.markReady(other.sha256,{id:'mine',createdAt:at(0)}),1);
 // Renewing gives a new id to every row that held the discarded one.
 assert.equal(await store.markReady(photo.sha256,{id:'new',createdAt:at(0),discarded:['old']}),2);
 assert.deepEqual(await store.ownPhotos(uuid(1)),['mine']);
 // Replacing the photo hands back the old provider photo, still held by the other user's avatar.
 const replaced=await store.save({agentId:uuid(11),userId:uuid(1),photo:other,consent:'self',voice:'Kore'});
 assert.equal(replaced.released,'new');
 assert.equal(await store.held('new'),true);
 assert.equal(await store.remove(uuid(12),uuid(2)),'new');
 assert.equal(await store.held('new'),false);
});
