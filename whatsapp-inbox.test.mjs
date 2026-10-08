import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxFixture,uuid} from './test-support/wa-inbox-fixture.mjs';
import {postgresSkipReason} from './test-support/local-postgres.mjs';
import {readFileSync} from 'node:fs';
const msg=n=>({id:'synthetic-'+n,from:'5511000000000',type:'text',text:{body:'Private synthetic text '+n}});
const payload=(messages,number='synthetic-phone')=>({entry:[{changes:[{value:{metadata:{phone_number_id:number},messages}}]}]});
const prepared=m=>({from:m.from,inputId:m.id,userId:uuid(1),agentId:uuid(11),text:m.text.body,images:null,files:null});

test('real PostgreSQL: durable admission, exclusive worker, recovery, uncertainty and retention',{timeout:30000,skip:postgresSkipReason()},async t=>{
 const f=await inboxFixture();t.after(()=>f.close());const s=f.store;
 await s.init();
 await t.test('acceptance is atomic, encrypted, deduplicated and respects legacy IDs and destination',async()=>{
  assert.equal((await s.accept(payload([msg(1),msg(2)]),'synthetic-phone')).inserted,2);
  assert.equal((await s.accept(payload([msg(1)]),'synthetic-phone')).inserted,0);
  assert.equal((await s.accept(payload([msg(3)],'another-phone'),'synthetic-phone')).inserted,0);
  await f.pool.query('INSERT INTO mtr_harness.whatsapp_seen(wamid) VALUES($1)',[msg(4).id]);assert.equal((await s.accept(payload([msg(4)]),'synthetic-phone')).inserted,0);
  await assert.rejects(()=>s.accept({entry:[{changes:[{value:{messages:[msg(5)]}}]}]},'synthetic-phone'),e=>e.status===400);
  await assert.rejects(()=>s.accept(payload([msg(5),{...msg(6),from:'invalid'}]),'synthetic-phone'));
  const rows=(await f.pool.query('SELECT * FROM mtr_harness.whatsapp_inbox')).rows;assert.equal(rows.length,2);assert(rows.every(r=>r.message_enc.startsWith('v1:')));assert(!JSON.stringify(rows).includes('Private synthetic'));
  const original=f.pool.connect.bind(f.pool);f.pool.connect=async()=>{const c=await original(),query=c.query.bind(c);c.query=async(sql,args)=>{if(sql.includes('INSERT INTO mtr_harness.whatsapp_seen'))throw Error('synthetic SQL failure');return query(sql,args);};const release=c.release.bind(c);c.release=(...args)=>{c.query=query;return release(...args);};return c;};
  try{await assert.rejects(()=>s.accept(payload([msg(7)]),'synthetic-phone'));}finally{f.pool.connect=original;}
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM mtr_harness.whatsapp_inbox')).rows[0].n,2);
 });
 await s.acquire();
 await t.test('a second worker cannot recover or execute while the first owns the database lock',async()=>{
  await assert.rejects(()=>f.make().acquire(),/ALREADY_ACTIVE/);
  const first=await s.claim();assert.equal(first.message.id,msg(1).id);await s.prepare(first.id,prepared(first.message));await s.begin([first.id]);await s.assertRunning([first.id]);
  const second=await s.claim();await s.prepare(second.id,prepared(second.message));
  await s.release();const next=f.make();await next.acquire();
  const rows=(await f.pool.query('SELECT state,reason FROM mtr_harness.whatsapp_inbox ORDER BY id')).rows;assert.equal(rows[0].state,'uncertain');assert.equal(rows[0].reason,'process_interrupted');assert.equal(rows[1].state,'buffered');
  assert.equal((await next.buffered())[0].prepared.text,msg(2).text.body);assert.deepEqual(await next.buffered('synthetic-phone',[second.id]),[]);assert.equal(await next.claim(),null);
  await assert.rejects(()=>s.begin([second.id]),/ownership/);
  await next.begin([second.id]);await next.complete([second.id]);await next.release();
 });
 await s.acquire();
 await t.test('interrupted preparation and failed settlement stay visible without automatic replay',async()=>{
  await s.accept(payload([msg(8)]),'synthetic-phone');const item=await s.claim();await s.reconcile([]);
  assert.equal((await s.report()).attention.some(r=>String(r.id)===item.id),true);assert.equal(await s.claim(),null);
  assert.equal((await s.accept(payload([msg(8)]),'synthetic-phone')).inserted,0);
  assert(!JSON.stringify(await s.report()).includes('Private synthetic'));
 });
 await t.test('unreadable encrypted input is visible and does not block later messages',async()=>{
  await s.accept(payload([msg(9),msg(10)]),'synthetic-phone');
  await f.pool.query('UPDATE mtr_harness.whatsapp_inbox SET message_enc=$1 WHERE wamid=$2',['invalid-cipher',msg(9).id]);
  assert.equal((await s.claim()).unreadable,true);
  const item=await s.claim();assert.equal(item.message.id,msg(10).id);assert.equal(item.recipient,uuid(1));await s.complete([item.id]);
  assert((await s.report()).attention.some(r=>r.reason==='payload_unreadable'));
 });
 await t.test('terminal payload expires but identity remains; unresolved inputs are retained',async()=>{
  await f.pool.query("UPDATE mtr_harness.whatsapp_inbox SET updated_at=now()-interval '8 days'");await s.prune();
  const rows=(await f.pool.query('SELECT state,message_enc FROM mtr_harness.whatsapp_inbox ORDER BY id')).rows;assert.equal(rows.find(r=>r.state==='completed').message_enc,null);assert(rows.filter(r=>r.state==='uncertain').every(r=>r.message_enc));
  assert.equal((await s.accept(payload([msg(2)]),'synthetic-phone')).inserted,0);
 });
});

test('actual webhook waits for committed admission and returns 503 when persistence fails',async()=>{
 const source=readFileSync('web/server.mjs','utf8'),a=source.indexOf("  if (req.method === 'POST' && url.pathname === '/api/wa/webhook') {"),b=source.indexOf('\n  // ── Slack channel',a);
 let commit,fail=false,auth=true,status=null,processed=0;
 const deps={readRaw:async()=>Buffer.from(JSON.stringify(payload([msg(1)]))),verifySignature:()=>auth,recordReminderDeliveryStatuses:async()=>{},recordReminderDeliveryStatus:()=>{},waEnabled:()=>true,waHandler:{accept:async()=>{if(fail)throw Error('DB unavailable');await new Promise(r=>commit=r);},process:async()=>processed++}};
 const route=Function(...Object.keys(deps),'return async(req,res,url)=>{'+source.slice(a,b)+'}')( ...Object.values(deps));
 const res={writeHead:n=>{status=n;},end(){}},req={method:'POST',headers:{}},url={pathname:'/api/wa/webhook'};
 const pending=route(req,res,url);for(let n=0;n<20&&!commit;n++)await new Promise(r=>setImmediate(r));assert.equal(status,null);assert.equal(processed,0);commit();await pending;assert.equal(status,200);assert.equal(processed,1);
 fail=true;await route(req,res,url);assert.equal(status,503);assert.equal(processed,1);
 auth=false;await route(req,res,url);assert.equal(status,403);assert.equal(processed,1);
});
