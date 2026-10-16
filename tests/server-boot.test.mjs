import { emptyReport } from '../web/discovery-report.mjs';
import {createInboundDecisionResponder,decisionSnapshot} from '../web/inbound-decision.mjs';
// Real production entrypoint + real disposable PostgreSQL, no customer data/API.
// Explicit local binaries only, Unix socket; no inherited credentials/env files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import http from 'node:http';
import pg from 'pg';
import { createDiscoveryStore } from '../web/discovery-store.mjs';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin=process.env.TEST_POSTGRES_BIN;
// Skips with an explicit reason when local binaries are absent (never production settings).
import {postgresSkipReason} from '../test-support/local-postgres.mjs';
const cmd=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C',HOME:os.tmpdir()}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function get(port,route='/',headers={}){
 return new Promise((resolve,reject)=>{const q=http.get({hostname:'127.0.0.1',port,path:route,headers},r=>{let body='';r.on('data',x=>body+=x);r.on('end',()=>resolve({status:r.statusCode,body}));});q.on('error',reject);q.setTimeout(3000,()=>q.destroy(Error('HTTP test timeout')));});
}
test('real server entrypoint boots three times against owned PostgreSQL; migration, HTTP and clean shutdown',{timeout:120000,skip:postgresSkipReason()},async()=>{
 let child,started=false,db;const root=await fs.mkdtemp(path.join(os.tmpdir(),'brambs-boot-test-'));
 async function stop(){if(!child)return;const p=child;child=null;if(p.exitCode===null){p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),delay(3000)]);if(p.exitCode===null){p.kill('SIGKILL');await new Promise(r=>p.once('exit',r));}}return p.exitCode;}
 try{
  const socket=path.join(root,'socket');await fs.mkdir(socket);
  cmd('initdb',['-D',path.join(root,'data'),'-U','synthetic','--auth=trust','--no-locale','--encoding=UTF8']);
  cmd('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'pg.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c max_connections=24`,'-w','start']);started=true;
  db=new pg.Client({host:socket,port:5432,user:'synthetic',database:'postgres',password:'',connectionTimeoutMillis:5000});await db.connect();
  assert.equal((await db.query('SELECT inet_server_addr() AS addr')).rows[0].addr,null);
  await db.query('CREATE SCHEMA mtr_harness');
  const env={PATH:process.env.PATH,HOME:root,TZ:'UTC',PGHOST:socket,PGPORT:'5432',PGUSER:'synthetic',PGDATABASE:'postgres',PGPASSWORD:'',PORT:'0',HOST:'127.0.0.1',TEST_BOOT_SOCKET:socket,VAULT_KEY:Buffer.alloc(32,7).toString('base64'),APP_TASK_STORE_DIR:path.join(root,'tasks'),CODING_JOB_STORE_DIR:path.join(root,'jobs'),CREDIT_CALL_STORE_DIR:path.join(root,'calls'),DEEPSEEK_FLASH_ENABLED:'0',WA_TOKEN:'synthetic',WA_VERIFY_TOKEN:'synthetic',WA_PHONE_NUMBER_ID:'synthetic-phone',WA_APP_SECRET:'synthetic',WA_TURN_HEARTBEAT_MS:'0'};
  // Negative controls: guard rejects all outbound TCP, TLS, fetch and subprocesses.
  const probe=`import assert from 'node:assert/strict';import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';
   for(const op of [()=>net.connect({host:'127.0.0.1',port:1}),()=>net.connect({host:'example.invalid',port:443}),()=>net.connect('/tmp/not-owned-postgres'),()=>tls.connect({host:'example.invalid',port:443}),()=>fetch('https://example.invalid'),()=>cp.execFileSync('false')])assert.throws(op,/BOOT_TEST_EXTERNAL_IO_BLOCKED/);
   console.log('6 isolation negative controls passed');`;
  const guardResult=execFileSync(process.execPath,['--import',path.join(repo,'test-support/boot-network-guard.mjs'),'--input-type=module','-e',probe],{env,cwd:root,encoding:'utf8',timeout:5000});
  assert.match(guardResult,/6 isolation negative controls passed/);
  // PORT=0 binds an OS-selected free localhost port; observation via listen wrapper.
  const observer=path.join(root,'listen-observer.mjs');await fs.writeFile(observer,`import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){this.once('listening',()=>console.log('BOOT_TEST_PORT='+this.address().port));return listen.apply(this,a);};`);
  for(let pass=0;pass<3;pass++){
   let output='';child=spawn(process.execPath,['--import',path.join(repo,'test-support/boot-network-guard.mjs'),'--import',observer,path.join(repo,'web/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
   child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
   let port;for(let i=0;i<150;i++){await delay(100);port=output.match(/BOOT_TEST_PORT=(\d+)/)?.[1];if(port||child.exitCode!==null)break;}
   assert.ok(port,`entrypoint failed (pass ${pass}):\n${output}`);
   assert.equal(child.exitCode,null,output);
   const page=await get(Number(port));assert.equal(page.status,200);assert.ok(page.body.length>100);
   const login=await get(Number(port),'/login');assert.equal(login.status,200);
   assert.equal((await get(Number(port),'/api/me')).status,401);
   assert.doesNotMatch(output,/ReferenceError|SyntaxError|Failed to initialize the database/);
   assert.equal(await stop(),0,'server must exit cleanly on SIGTERM');console.log(`boot ${pass+1}: production entrypoint + HTTP200 + auth401; synthetic DB only`);
   if(pass===0){
    await db.query(await fs.readFile(path.join(repo,'migrations/2026-09-12-execution-credit.sql'),'utf8'));
    await db.query(await fs.readFile(path.join(repo,'migrations/2026-09-29-execution-credit-org.sql'),'utf8'));
    await db.query(`INSERT INTO mtr_harness.users(id,name,email,password_hash) VALUES
     ('00000000-0000-4000-8000-000000000001','Synthetic one','one@example.invalid','not-a-password'),
     ('00000000-0000-4000-8000-000000000002','Synthetic two','two@example.invalid','not-a-password'),
     ('00000000-0000-4000-8000-000000000003','Synthetic three','three@example.invalid','not-a-password')`);
   }
  }
  // Real PostgreSQL locks/transaction: simultaneous replies must not double-write.
  const decision=(await db.query(`INSERT INTO mtr_harness.agent_convos(from_user,to_user,objetivo,resultado,status)
   VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','Synthetic decision','Tuesday','accepted') RETURNING *`)).rows[0];
  const decisionPool=new pg.Pool({host:socket,port:5432,user:'synthetic',database:'postgres',max:2});
  try{
   const respond=createInboundDecisionResponder(decisionPool),owner='00000000-0000-4000-8000-000000000002';
   const results=await Promise.all([true,false].map(accept=>respond(owner,{id:decision.id,accept,expected:decisionSnapshot(decision)})));
   assert.equal(results.filter(r=>r.ok).length,1);
   assert.equal((await db.query('SELECT count(*)::int n FROM mtr_harness.agent_convo_msgs WHERE convo_id=$1',[decision.id])).rows[0].n,1);
   // Exercise report SQL and competing workers on actual PostgreSQL. Servers
   // are already stopped; adapters/providers are never invoked in this test.
   const journey=createDiscoveryStore(decisionPool,()=>true);
   const agent='00000000-0000-4000-8000-000000000011',thread='00000000-0000-4000-8000-000000000021';
   await db.query(`UPDATE mtr_harness.discovery_settings SET enabled=true;
    INSERT INTO mtr_harness.agents(id,user_id,owner,name) VALUES('${agent}','${owner}','Synthetic two','Synthetic helper');
    INSERT INTO mtr_harness.threads(id,user_id,agent_id,title) VALUES('${thread}','${owner}','${agent}','Synthetic history');
    INSERT INTO mtr_harness.messages(agent_id,thread_id,role,content,ts) VALUES('${agent}','${thread}','user','Quero organizar as compras da semana com uma lista.',now()-interval '1 day');
    INSERT INTO mtr_harness.discovery_participants(user_id,agent_id,status,started_at,ends_at) VALUES('${owner}','${agent}','active',now()-interval '7 days',now()-interval '1 hour');`);
   await journey.maintenance();
   const candidate=(await journey.closing.candidates())[0];
   const claims=await Promise.all([journey.closing.claim(candidate),journey.closing.claim(candidate)]);
   assert.equal(claims.filter(Boolean).length,1);
   const claim=claims.find(Boolean),context=await journey.closing.context(claim);
   assert.equal(context.coverage.messages,1);
   await journey.closing.save(claim,context,JSON.stringify({...emptyReport(),understanding:[{text:'Você pede ajuda para organizar as compras.',basis:'observed',evidence:[{id:context.evidence[0].id,quote:'organizar as compras da semana'}]}]}));
   const ready=(await journey.closing.candidates())[0];
   const sends=await Promise.all([journey.closing.begin(ready,new Date('2099-09-21T15:31:00Z')),journey.closing.begin(ready,new Date('2099-09-21T15:31:00Z'))]);
   assert.equal(sends.filter(Boolean).length,1);
   await journey.closing.finish(sends.find(Boolean),{ok:true,id:'synthetic-only',threadId:thread});
   assert.equal((await journey.closing.owned(owner,agent)).state,'accepted');
   console.log('discovery: real PostgreSQL context + one generation claim + one send claim; no external delivery');
   // Two confirmations of the same early completion contend on the actual
   // participant row. Exactly one may end it and enqueue the on-demand report.
   await db.query('DELETE FROM mtr_harness.discovery_reports WHERE user_id=$1',[owner]);
   await db.query("UPDATE mtr_harness.discovery_participants SET status='active',ends_at=now()+interval '5 days',version=version+1 WHERE user_id=$1",[owner]);
   const before=await journey.get(owner,agent);
   const completions=await Promise.allSettled([journey.complete(owner,agent,{version:before.version}),journey.complete(owner,agent,{version:before.version})]);
   assert.equal(completions.filter(r=>r.status==='fulfilled').length,1);
   assert.equal(completions.filter(r=>r.status==='rejected').length,1);
   assert.equal((await journey.get(owner,agent)).status,'completed');
   const requested=await journey.closing.owned(owner,agent);
   assert.equal(requested.state,'pending');assert.equal(requested.auto_send,false);
   await journey.maintenance();
   assert.equal((await journey.closing.overview()).length,1);
   assert.equal((await db.query("SELECT count(*)::int n FROM mtr_harness.discovery_events WHERE user_id=$1 AND kind='completed_early'",[owner])).rows[0].n,1);
   console.log('discovery: concurrent early completion enqueues exactly one on-demand report');
   await db.query("UPDATE mtr_harness.discovery_reports SET state='failed',attempts=3,reason='invalid_report_evidence' WHERE user_id=$1",[owner]);
   const failed=await journey.closing.owned(owner,agent),expected={id:failed.id,recoveryCount:failed.recovery_count};
   const retried=await Promise.allSettled([1,2].map(()=>journey.closing.retry(owner,agent,expected,{threadId:thread,channel:'telegram'})));
   assert.equal(retried.filter(r=>r.status==='fulfilled').length,1);
   assert.equal(retried.filter(r=>r.status==='rejected').length,1);
   const retryState=await journey.closing.owned(owner,agent);
   assert.equal(retryState.id,requested.id);assert.equal(retryState.recovery_count,1);assert.equal(retryState.delivery_thread_id,thread);
   const retryClaim=await journey.closing.claim((await journey.closing.candidates())[0]);
   await journey.closing.save(retryClaim,await journey.closing.context(retryClaim),JSON.stringify(emptyReport()));
   const retryReady=(await journey.closing.candidates())[0];
   const retrySends=await Promise.all([1,2].map(()=>journey.closing.begin(retryReady)));
   assert.equal(retrySends.filter(Boolean).length,1);
   console.log('discovery: concurrent recovery keeps one report and admits one conversational delivery');
  }finally{await decisionPool.end();}
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mtr_harness.execution_credit_calls')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mtr_harness.users')).rows[0].n,3);
 }finally{await stop();if(db)await db.end();if(started)cmd('pg_ctl',['-D',path.join(root,'data'),'-m','immediate','-w','stop']);await fs.rm(root,{recursive:true,force:true});}
});
