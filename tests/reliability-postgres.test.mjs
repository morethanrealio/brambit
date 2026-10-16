// Real, disposable PostgreSQL. Never accepts a connection URL or inherited DB credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createReminderExecutionStore } from '../web/reminder-execution-store.mjs';
import { createConfirmationStore } from '../web/confirmation-store.mjs';
import { createChecklistStore } from '../web/checklists.mjs';
const bin = process.env.TEST_POSTGRES_BIN;
// Skips with an explicit reason when local binaries are absent (never a remote DB).
import { postgresSkipReason } from '../test-support/local-postgres.mjs';
const run = (name,args) => execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:20000,
  env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'}});
test('independent PostgreSQL connections serialize approvals, sends, finish and callbacks', { skip: postgresSkipReason() }, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reliability-pg-'));
  let started=false, pools=[];
  t.after(async()=>{await Promise.all(pools.map(p=>p.end()));if(started)run('pg_ctl',['-D',path.join(root,'data'),'-m','immediate','-w','stop']);await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'socket'));
  run('initdb',['-D',path.join(root,'data'),'-U','synthetic','--auth=trust','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'pg.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${root}/socket'`,'-w','start']);started=true;
  pools=Array.from({length:2},()=>new pg.Pool({host:path.join(root,'socket'),user:'synthetic',database:'postgres',password:'',port:5432,max:4,statement_timeout:5000}));
  const db=pools[0];assert.equal((await db.query('SELECT inet_server_addr() AS addr')).rows[0].addr,null);
  await db.query(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY,deleted_at timestamptz);
    CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY,user_id uuid,archived_at timestamptz);
    CREATE TABLE mtr_harness.threads(id uuid PRIMARY KEY,user_id uuid,agent_id uuid);
    CREATE TABLE mtr_harness.reminders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,agent_id uuid,message text,
      run_at timestamptz,channel text,status text DEFAULT 'pending',created_at timestamptz DEFAULT now(),sent_at timestamptz,repeat_every_min integer,repeat_until timestamptz);`);
  const scope={userId:randomUUID(),agentId:randomUUID(),threadId:randomUUID()};
  await db.query('INSERT INTO mtr_harness.users(id) VALUES ($1)',[scope.userId]);
  await db.query('INSERT INTO mtr_harness.agents(id,user_id) VALUES ($1,$2)',[scope.agentId,scope.userId]);
  await db.query('INSERT INTO mtr_harness.threads VALUES ($1,$2,$3)',[scope.threadId,scope.userId,scope.agentId]);
  const reminders=pools.map(p=>createReminderExecutionStore(p));
  const approvals=pools.map(p=>createConfirmationStore(p,{seal:x=>Buffer.from(x).toString('base64'),open:x=>Buffer.from(x,'base64').toString()}));
  // Encoding here is a SQL-only synthetic fixture; encrypted-at-rest tested separately.
  await reminders[0].ensureSchema();await reminders[1].ensureSchema();await approvals[0].ensureSchema();
  await t.test('concurrent checklist creation and updates keep one list and refuse stale versions',async()=>{
    const lists=pools.map(p=>createChecklistStore(p));await lists[0].init();
    const created=await Promise.all(Array.from({length:12},(_,i)=>lists[i%2].create(scope.userId,'Mercado sintético')));
    assert.equal(new Set(created.map(r=>r.lista.id)).size,1);
    const id=created[0].lista.id;
    const writes=await Promise.all(Array.from({length:12},(_,i)=>lists[i%2].edit(scope.userId,{lista:id,versao:0,requestKey:'change-'+i,operacoes:[{tipo:'adicionar',nome:'Item '+i}]})));
    assert.equal(writes.filter(r=>r.ok).length,1);assert.equal(writes.filter(r=>r.code==='CONFLICT').length,11);
    assert.equal((await lists[1].list(scope.userId,id)).lista.total,1);
  });
  await t.test('twelve identical proposals and twelve concurrent decisions cause one claim',async()=>{
    const payload={name:'gmail_send',args:{to:'fixture@example.invalid',subject:'Synthetic',body:'Synthetic'},context:{},label:'Synthetic'};
    const rows=await Promise.all(Array.from({length:12},(_,i)=>approvals[i%2].propose(scope,payload)));
    assert.equal(new Set(rows.map(r=>r.id)).size,1);
    const row=rows[0];await approvals[0].present(scope,[row.id]);
    const claims=await Promise.all(Array.from({length:12},(_,i)=>approvals[i%2].claim(scope,row.id,row.fingerprint,'same-input')));
    assert.equal(claims.filter(Boolean).length,1);
  });
  await t.test('concurrent claim plus finish/callback/cancel cannot duplicate or lose confirmed delivery',async()=>{
    const made=await reminders[0].create({...scope,message:'Synthetic',runAt:new Date(Date.now()-10000),channel:'whatsapp'});
    const r=(await db.query('SELECT * FROM mtr_harness.reminders WHERE id=$1',[made.id])).rows[0];
    const claims=await Promise.all(Array.from({length:12},(_,i)=>reminders[i%2].claim(r)));
    assert.equal(claims.filter(Boolean).length,1);const claim=claims.find(Boolean);
    await reminders[0].begin(claim);
    const tracking=reminders[0].deliveryTracking(claim);await tracking.start({total:1,recipient:'5511000000000'});
    const opaque=await tracking.beforePart(0);
    const callback={id:'wamid-synthetic',status:'read',recipient_id:'5511000000000',biz_opaque_callback_data:opaque};
    await Promise.all([
      tracking.accepted(0,'wamid-synthetic'),
      reminders[0].finish(claim,{status:'uncertain'}),
      reminders[1].recordDeliveryStatus(callback),
      reminders[1].recordDeliveryStatus({...callback,status:'sent'}),
      reminders[1].cancel(r.id,scope.userId),
    ]);
    const result=(await reminders[0].listOccurrences(scope.userId,r.id))[0];
    assert.equal(result.status,'accepted');assert.equal(result.delivery_state,'read');assert.equal(result.attempt_count,1);
    assert.equal(await reminders[1].claim(r),null);
  });
});
