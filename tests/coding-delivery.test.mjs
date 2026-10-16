import test from 'node:test';import assert from 'node:assert/strict';
import {appendThreadMessage} from '../web/thread-history.mjs';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
test('delivery receipt and history commit atomically, deduplicate after restart, and enforce owner',async()=>{
 const db=new PGlite();await db.exec(`CREATE SCHEMA fixture;
 CREATE TABLE fixture.threads(id text primary key,agent_id text,user_id text,history jsonb default '[]',updated_at timestamptz default now());
 CREATE TABLE fixture.messages(id bigserial primary key,thread_id text,agent_id text,role text,content text,attachments jsonb);
 CREATE TABLE fixture.thread_delivery_receipts(thread_id text references fixture.threads(id),delivery_key text,primary key(thread_id,delivery_key));
 INSERT INTO fixture.threads(id,agent_id,user_id) VALUES('thread','agent','owner');`);
 let fail=false,tail=Promise.resolve();const pool={connect:async()=>{const previous=tail;let release;tail=new Promise(r=>release=r);await previous;return {release,query:async(q,p)=>{if(fail&&q.includes('INSERT INTO fixture.messages'))throw Error('synthetic failure');return db.query(q,p);}};}};
 const input={threadId:'thread',userId:'owner',text:'Result',clean:x=>x,deliveryKey:'coding-job:one'};
 try {
   fail=true;await assert.rejects(()=>appendThreadMessage(pool,'fixture',input));fail=false;
   assert.equal((await db.query('SELECT * FROM fixture.thread_delivery_receipts')).rows.length,0);
   await Promise.all([appendThreadMessage(pool,'fixture',input),appendThreadMessage(pool,'fixture',input)]);
   assert.equal((await db.query('SELECT * FROM fixture.messages')).rows.length,1);
   assert.equal((await db.query('SELECT history FROM fixture.threads')).rows[0].history.length,1);
   assert.equal(await appendThreadMessage(pool,'fixture',{...input,userId:'alien',deliveryKey:'coding-job:two'}),false);
   assert.equal((await db.query('SELECT * FROM fixture.thread_delivery_receipts')).rows.length,1);
 }finally{await db.close();}
});
