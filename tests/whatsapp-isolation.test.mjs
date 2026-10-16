import test from 'node:test';
import assert from 'node:assert/strict';
import {inboxFixture,uuid} from '../test-support/wa-inbox-fixture.mjs';
import {postgresSkipReason} from '../test-support/local-postgres.mjs';
import {createWhatsAppHandler} from '../web/whatsapp.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<500;i++){if(await fn())return;await wait(10);}throw Error('Expected state did not arrive');}
Object.assign(process.env,{WA_PHONE_NUMBER_ID:'synthetic-phone',WA_TOKEN:'synthetic',WA_DEBOUNCE_MS:'100',WA_TURN_HEARTBEAT_MS:'0',WA_INTERJECT:'1',CANAL_REENVIO_MS:'0,0'});
const payload=messages=>({entry:[{changes:[{value:{metadata:{phone_number_id:'synthetic-phone'},messages}}]}]});
const message=(n,text,extra={})=>({id:'integration-'+n,from:'5511000000000',type:'text',text:{body:text},...extra});

test('WhatsApp real inbox and handler isolate pending work, restart safely and refuse changed recipients',{timeout:40000,skip:postgresSkipReason()},async t=>{
 const f=await inboxFixture();const handlers=[],gates=[];t.after(async()=>{for(const g of gates)g.resolve();for(const h of handlers)await h.stop();await f.close();});
 const original=globalThis.fetch;let sent=[],sendFailure=false,active=uuid(11),owner=uuid(1);t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,options)=>{
  assert(String(url).startsWith('https://graph.facebook.com/'),'unexpected network');
  const body=JSON.parse(options?.body||'{}');
  if(body.type==='text'){if(sendFailure)throw Error('synthetic response lost');sent.push(body.text.body);return {ok:true,json:async()=>({messages:[{id:'out-'+sent.length}]})};}
  return {ok:true,json:async()=>({success:true})};
 };
 const agents=[{id:uuid(11),name:'Alpha'},{id:uuid(12),name:'Beta'}];
 const db={getWhatsAppLink:async()=>({enabled:true,user_id:owner,active_agent_id:active}),listAgents:async()=>agents,setWhatsAppActiveAgent:async(_,id)=>{active=id;},touchWaInbound:async()=>{},saveWaMsgRef:async()=>{},getWaMsgRef:async()=>null};
 const make=(store,run)=>{const h=createWhatsAppHandler({inbox:store,db,loadAgent:async(id,user)=>user===uuid(1)?agents.find(a=>a.id===id):null,runConversation:run});handlers.push(h);return h;};
 const allDone=async()=>!(await f.pool.query("SELECT 1 FROM mtr_harness.whatsapp_inbox WHERE state NOT IN ('completed','ignored','uncertain')")).rows.length;
 async function accept(h,...msgs){await h.accept(payload(msgs));await h.process(payload(msgs));}
 await t.test('pending A citation survives an agent switch while B is buffered, without crossing identity',async()=>{
  const entered=deferred(),release=deferred();gates.push(release);const turns=[];
  const h=make(f.store,async(agent,user,text,images,files,extra)=>{
   turns.push({agent:agent.id,user,text,target:extra.confirmationTarget,input:extra.confirmationInputId});
   if(text==='A slow'){entered.resolve();await release.promise;assert.equal(await extra.pollNewUserMsg(),null);}
   return {text:'reply '+text};
  });await h.start();await accept(h,message(1,'A slow'));await entered.promise;
  await accept(h,message(2,'A remainder',{context:{id:'card-A'}}),message(3,'@Beta B new'));
  await until(async()=>Number((await f.pool.query("SELECT count(*)::int n FROM mtr_harness.whatsapp_inbox WHERE state='buffered'")).rows[0].n)===2);
  release.resolve();await until(allDone);
  const a=turns.find(r=>r.text==='A remainder'),b=turns.find(r=>r.text==='B new');assert(a&&b);assert.equal(a.agent,uuid(11));assert.equal(b.agent,uuid(12));assert.deepEqual(a.target,{channel:'whatsapp',messageId:'card-A'});assert.equal(a.input,'whatsapp:integration-2');
  assert.equal(turns.length,3);await h.stop();
 });
 await t.test('received and prepared media survive shutdown; recovery retains original agent and bytes',async()=>{
  active=uuid(12);const s=f.make();await s.acquire();await s.accept(payload([message(4,'saved media'),message(5,'received while offline')]),'synthetic-phone');const item=await s.claim();
  await s.prepare(item.id,{from:item.message.from,userId:uuid(1),agentId:uuid(11),inputId:item.message.id,text:'saved media',images:[{mimeType:'image/png',data:'AQID'}],files:[{name:'fixture.pdf',mime:'application/pdf',data:'BAUG'}]});await s.release();
  const recovered=[];const h=make(f.make(),async(agent,user,text,images,files)=>{recovered.push({agent:agent.id,text,images,files});return {text:'recovered '+text};});await h.start();await until(allDone);
  const media=recovered.find(r=>r.text==='saved media');assert.equal(media.agent,uuid(11));assert.equal(media.images[0].data,'AQID');assert.deepEqual([...media.files[0].buffer],[4,5,6]);assert.equal(recovered.find(r=>r.text==='received while offline').agent,uuid(12));await h.stop();
 });
 await t.test('recovered media exceeding a batch limit is split without discarding attachments',async()=>{
  const s=f.make();await s.acquire();
  for(let i=0;i<12;i++){
   const m=message(100+i,'image '+i);await s.accept(payload([m]),'synthetic-phone');const item=await s.claim();
   await s.prepare(item.id,{from:m.from,userId:uuid(1),agentId:uuid(11),inputId:m.id,text:m.text.body,images:[{mimeType:'image/png',data:Buffer.from([i]).toString('base64')}],files:null});
  }
  await s.release();const seen=[],sizes=[];
  const h=make(f.make(),async(agent,user,text,images)=>{sizes.push(images.length);seen.push(...images.map(im=>Buffer.from(im.data,'base64')[0]));return {text:'media processed'};});await h.start();await until(allDone);
  assert.deepEqual(seen,Array.from({length:12},(_,i)=>i));assert(sizes.every(n=>n<=10));await h.stop();
 });
 await t.test('interrupted execution is flagged and never replayed; stale worker cannot deliver after recovery',async()=>{
  const entered=deferred(),release=deferred();gates.push(release);let runs=0;
  const old=f.make(),h=make(old,async()=>{runs++;entered.resolve();await release.promise;return {text:'must not resend'};});await h.start();await accept(h,message(6,'crash window'));await entered.promise;
  await old.release();const next=f.make();await next.acquire();release.resolve();await h.stop();
  const row=(await f.pool.query("SELECT state FROM mtr_harness.whatsapp_inbox WHERE wamid='integration-6'")).rows[0];assert.equal(row.state,'uncertain');assert.equal(runs,1);assert(!sent.includes('must not resend'));assert.equal(await next.claim(),null);await next.release();
 });
 await t.test('interjection is marked running before consumed and settles with the original turn once',async()=>{
  active=uuid(11);const entered=deferred(),release=deferred();gates.push(release);let polled,runs=0;
  const h=make(f.make(),async(agent,user,text,images,files,extra)=>{runs++;entered.resolve();await release.promise;polled=await extra.pollNewUserMsg();const states=(await f.pool.query("SELECT state FROM mtr_harness.whatsapp_inbox WHERE wamid IN ('integration-7','integration-8')")).rows;assert(states.every(r=>r.state==='running'));return {text:'single reply'};});await h.start();await accept(h,message(7,'start'));await entered.promise;await accept(h,message(8,'additional text'));
  await until(async()=>(await f.pool.query("SELECT state FROM mtr_harness.whatsapp_inbox WHERE wamid='integration-8'")).rows[0]?.state==='buffered');release.resolve();await until(allDone);assert.deepEqual(polled,{text:'additional text'});assert.equal(runs,1);await h.stop();
 });
 await t.test('known recipient reassignment prevents sending the old account response',async()=>{
  const entered=deferred(),release=deferred();gates.push(release);
  const h=make(f.make(),async()=>{entered.resolve();await release.promise;return {text:'private old account reply'};});await h.start();await accept(h,message(9,'old account'));await entered.promise;owner=uuid(2);release.resolve();await until(allDone);assert(!sent.includes('private old account reply'));assert.equal((await f.pool.query("SELECT reason FROM mtr_harness.whatsapp_inbox WHERE wamid='integration-9'")).rows[0].reason,'recipient_changed');await h.stop();owner=uuid(1);
 });
 await t.test('received input cannot migrate to a different account while waiting offline',async()=>{
  const s=f.make();await s.accept(payload([message(11,'private queued input')]),'synthetic-phone');owner=uuid(2);
  let runs=0;const h=make(s,async()=>{runs++;return {text:'must not run'};});await h.start();await until(allDone);
  const row=(await f.pool.query("SELECT state,reason FROM mtr_harness.whatsapp_inbox WHERE wamid='integration-11'")).rows[0];
  assert.equal(row.state,'ignored');assert.equal(row.reason,'recipient_changed');assert.equal(runs,0);await h.stop();owner=uuid(1);
 });
 await t.test('a lost response from the delivery API stays uncertain across retry without rerunning the turn',async()=>{
  let runs=0;sendFailure=true;const h=make(f.make(),async()=>{runs++;return {text:'uncertain transport'};});await h.start();await accept(h,message(10,'delivery failure'));await until(allDone);
  assert.equal((await f.pool.query("SELECT state FROM mtr_harness.whatsapp_inbox WHERE wamid='integration-10'")).rows[0].state,'uncertain');await accept(h,message(10,'delivery failure'));await wait(120);assert.equal(runs,1);sendFailure=false;await h.stop();
 });
});
