import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');const {appendThreadMessage,mergeThreadHistory}=await import('./web/thread-history.mjs');
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;},ok=(v,m)=>{assert.ok(v,m);checks++;};const db=new PGlite();
await db.exec(`CREATE SCHEMA mtr_harness;CREATE TABLE mtr_harness.threads(id text primary key,agent_id text,user_id text,history jsonb DEFAULT '[]',summary text,title text,updated_at timestamptz DEFAULT now());CREATE TABLE mtr_harness.messages(id bigserial primary key,agent_id text,thread_id text,role text,content text,attachments jsonb,ts timestamptz DEFAULT now());`);
let tail=Promise.resolve(),failInsert=false,failUpdate=false;const pool={query:(...a)=>db.query(...a),connect:async()=>{const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return {release,query:async(q,p)=>{if(q.startsWith('SELECT'))ok(q.includes('FOR UPDATE'));if(failInsert&&q.includes('INSERT INTO'))throw Error('fixture insert failure');if(failUpdate&&q.startsWith('UPDATE'))throw Error('fixture update failure');return db.query(q,p);}};}};
const src=fs.readFileSync('web/db.mjs','utf8'),server=fs.readFileSync('web/server.mjs','utf8');const clean=x=>String(x??'').replace(/\0/g,'');const cleanDeep=x=>JSON.parse(JSON.stringify(x));
function fn(name,deps){const a=src.indexOf('export async function '+name+'('),b=src.indexOf('\n}',a)+2;ok(a>=0&&b>a);return Function(...Object.keys(deps),src.slice(a,b).replace('export ','')+';return '+name)(...Object.values(deps));}
const save=fn('saveThreadTurn',{pool,S:'mtr_harness',clean,cleanDeep,mergeThreadHistory});
const append=fn('appendAssistantToThread',{pool,S:'mtr_harness',clean,appendThreadMessage});
const create=async(id)=>db.query('INSERT INTO mtr_harness.threads(id,agent_id,user_id) VALUES($1,$2,$3)',[id,'agent','owner']);const hist=async(id)=>(await db.query('SELECT history FROM mtr_harness.threads WHERE id=$1',[id])).rows[0].history;const msgs=async(id)=>(await db.query('SELECT role,content FROM mtr_harness.messages WHERE thread_id=$1 ORDER BY id',[id])).rows;
try {
 await create('a');await Promise.all(Array.from({length:10},(_,i)=>append({threadId:'a',userId:'owner',text:'async'+i})));eq((await hist('a')).length,10);eq(await hist('a'),await msgs('a'));
 eq(await append({threadId:'a',userId:'stranger',text:'stolen'}),false);eq((await hist('a')).length,10);
 const prior=await hist('a');failInsert=true;await assert.rejects(()=>append({threadId:'a',userId:'owner',text:'rollback'}));checks++;failInsert=false;eq(await hist('a'),prior);eq((await msgs('a')).length,10);
 failUpdate=true;await assert.rejects(()=>append({threadId:'a',userId:'owner',text:'rollback2'}));checks++;failUpdate=false;eq(await hist('a'),prior);
 // A late async message arriving while the model works survives turn finalization.
 await create('b');const base=await hist('b');await append({threadId:'b',userId:'owner',text:'late video'});
 const completion=[{role:'user',content:'request'},{role:'assistant',content:'reply'}];
 await save('b','agent',{baseHistory:base,history:completion,summary:'s',userMsg:'request',assistantMsg:'reply'});
 eq(await hist('b'),[...completion,{role:'assistant',content:'late video'}]);eq((await msgs('b')).length,3);
 const b=await hist('b');failInsert=true;await assert.rejects(()=>save('b','agent',{baseHistory:b,history:[...b,...completion],summary:'new',userMsg:'x',assistantMsg:'y'}));checks++;failInsert=false;eq(await hist('b'),b);eq((await msgs('b')).length,3);
 // Conflicting mutation is rejected rather than overwriting or replaying tools.
 await assert.rejects(()=>save('b','agent',{baseHistory:[{role:'user',content:'different'}],history:completion,userMsg:'x',assistantMsg:'y'}),/CONFLICT/);checks++;eq(await hist('b'),b);
 await assert.rejects(()=>save('b','wrong-agent',{baseHistory:b,history:completion,userMsg:'x',assistantMsg:'y'}),/NOT_FOUND/);checks++;
 await assert.rejects(()=>save('b','agent',{history:completion,userMsg:'x',assistantMsg:'y'}));checks++;eq(await hist('b'),b);
 // All save branches commit, including existing inbound row and interjections.
 for(const mode of ['existing','extras','simple']){
  await create(mode);let userMsgId;if(mode==='existing')userMsgId=(await db.query("INSERT INTO mtr_harness.messages(agent_id,thread_id,role,content) VALUES('agent',$1,'user','raw') RETURNING id",[mode])).rows[0].id;
  await save(mode,'agent',{baseHistory:[],history:completion,title:'newtitle',summary:'s',userMsg:'request',assistantMsg:'reply',userMsgId,interjecoes:mode==='simple'?[]:['extra']});
  eq((await msgs(mode)).map(x=>x.content),mode==='simple'?['request','reply']:['request','extra','reply']);eq(await hist(mode),completion);
 }
 const opening=fn('persistAgentOpening',{getOrCreateThreadByTitle:async()=>({id:'a'}),appendAssistantToThread:append});eq(await opening({agentId:'agent',userId:'owner',title:'fixture',text:'opening'}),'a');eq((await hist('a')).at(-1).content,'opening');eq((await msgs('a')).at(-1).content,'opening');
 // Todo ponto de gravação do turno passa o baseHistory (sem ele o merge não detecta conflito). Não é mais contagem fixa: surgem chamadas novas.
 const saveCalls=[...server.matchAll(/saveThreadTurn\(thread\.id,\s*agent\.id,\s*\{\s*([A-Za-z]+)/g)];ok(saveCalls.length>=8);ok(saveCalls.every(m=>m[1]==='baseHistory'),'toda chamada de saveThreadTurn passa baseHistory');eq((server.match(/saveThreadTurn\(/g)||[]).length,saveCalls.length);ok(server.includes('const baseHistory = structuredClone(thread.history || []);'));
 eq(mergeThreadHistory([{a:1,b:2}],[{b:2,a:1},{role:'assistant',content:'append'}],[{role:'assistant',content:'compact'}]),[{role:'assistant',content:'compact'},{role:'assistant',content:'append'}]);
 assert.throws(()=>mergeThreadHistory([], [{role:'user',content:'other turn'}], []),/CONFLICT/);checks++;
 // Existing FIFO wrapper still serializes, reloads fresh history, and recovers failure.
 const a=server.indexOf('const _threadTurnChains = new Map();'),bidx=server.indexOf('// ── Housekeeping',a);
 const lock=Function(server.slice(a,bidx)+';return withThreadLock')();let release;const gate=new Promise(r=>release=r),order=[];
 const first=lock('same',async()=>{order.push(1);await gate;order.push(2);});const second=lock('same',async()=>order.push(3));await lock('other',async()=>order.push(4));eq(order,[1,4]);release();await Promise.all([first,second]);eq(order,[1,4,2,3]);await assert.rejects(()=>lock('same',async()=>{throw Error('fake')}));checks++;eq(await lock('same',async()=>7),7);
 console.log(`PASS ${checks}: actual DB append/turn transactions, rollback, ownership, concurrent arrivals and existing FIFO; local PGlite, no real I/O`);
} finally {await db.close();}
