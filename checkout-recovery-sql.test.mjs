import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createCheckoutRecoveryStore,recoverOrderPix} from './web/checkout-recovery.mjs';
import {encryptSecret,decryptSecret,vaultEnabled} from './web/vault.mjs';
process.env.VAULT_KEY=Buffer.alloc(32,8).toString('base64');
const s={userId:'11111111-1111-4111-8111-111111111111',agentId:'22222222-2222-4222-8222-222222222222',threadId:'33333333-3333-4333-8333-333333333333'};
const wrong={userId:'44444444-4444-4444-8444-444444444444',agentId:'55555555-5555-4555-8555-555555555555',threadId:'66666666-6666-4666-8666-666666666666'};
const make=db=>createCheckoutRecoveryStore(db,{encrypt:encryptSecret,decrypt:decryptSecret,enabled:vaultEnabled});
test('real Postgres SQL via offline PGlite: durability, ownership, FK cleanup, TTL and active accounts',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pix-recovery-sql-'));let db;
 try{
  db=new PGlite(dir);await db.exec(`CREATE SCHEMA mtr_harness;
  CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY,deleted_at timestamptz);
  CREATE TABLE mtr_harness.agents(id uuid PRIMARY KEY,user_id uuid REFERENCES mtr_harness.users(id) ON DELETE CASCADE);
  CREATE TABLE mtr_harness.threads(id uuid PRIMARY KEY,user_id uuid REFERENCES mtr_harness.users(id) ON DELETE CASCADE,agent_id uuid REFERENCES mtr_harness.agents(id) ON DELETE CASCADE,deleted_at timestamptz);`);
  for(const a of [s,wrong]){await db.query('INSERT INTO mtr_harness.users(id) VALUES($1)',[a.userId]);await db.query('INSERT INTO mtr_harness.agents VALUES($1,$2)',[a.agentId,a.userId]);await db.query('INSERT INTO mtr_harness.threads(id,user_id,agent_id) VALUES($1,$2,$3)',[a.threadId,a.userId,a.agentId]);}
  let store=make(db);await store.ensureSchema();await store.ensureSchema();
  const r=await store.reserve(s,{origin:'https://shop.invalid',total:14089});await store.save(s,r,'SQL-ORDER','pix_received',[{paymentAppData:{payload:{code:'PRIVATE_SYNTHETIC_CODE',expiresAt:'2099-01-01'}}}]);
  assert.ok(!(await db.query('SELECT payload_enc FROM mtr_harness.checkout_pix_records')).rows[0].payload_enc.includes('PRIVATE_SYNTHETIC_CODE'));
  await db.close();db=new PGlite(dir);store=make(db); // Real disk persistence, new database/repository instances.
  const loaded=await store.load(s,'SQL-ORDER');assert.equal(loaded.responses[0].paymentAppData.payload.code,'PRIVATE_SYNTHETIC_CODE');assert.equal(loaded.total,14089);
  assert.equal(await store.load(wrong,'SQL-ORDER'),null);assert.equal(await store.load({...s,agentId:wrong.agentId},'SQL-ORDER'),null);
  await assert.rejects(()=>store.reserve({...s,threadId:wrong.threadId},{origin:'https://shop.invalid',total:1}));
  await db.query('UPDATE mtr_harness.threads SET deleted_at=now() WHERE id=$1',[s.threadId]);assert.equal(await store.load(s,'SQL-ORDER'),null);await assert.rejects(()=>store.save(s,r,'SQL-ORDER','pix_received',[]));
  await db.query('UPDATE mtr_harness.threads SET deleted_at=NULL WHERE id=$1',[s.threadId]);
  await db.query('UPDATE mtr_harness.users SET deleted_at=now() WHERE id=$1',[s.userId]);assert.equal(await store.load(s,'SQL-ORDER'),null);await assert.rejects(()=>store.reserve(s,{origin:'https://shop.invalid',total:1}));
  await db.query('UPDATE mtr_harness.users SET deleted_at=NULL WHERE id=$1',[s.userId]);
  await db.query("UPDATE mtr_harness.checkout_pix_records SET expires_at=now()-interval '1 second'");assert.equal(await store.load(s,'SQL-ORDER'),null);await store.purgeExpired();assert.equal((await db.query('SELECT count(*)::int n FROM mtr_harness.checkout_pix_records')).rows[0].n,0);
  const r2=await store.reserve(s,{origin:'https://shop.invalid',total:1});await store.save(s,r2,'SECOND','created');await db.query('DELETE FROM mtr_harness.agents WHERE id=$1',[s.agentId]);assert.equal((await db.query('SELECT count(*)::int n FROM mtr_harness.checkout_pix_records')).rows[0].n,0);
 }finally{if(db)await db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
