// Sign-up confirmed by e-mail (account pre-hijacking), on a real, disposable PostgreSQL.
// Never accepts a connection URL or inherited DB credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { hashPassword, verifyPassword } from '../web/auth.mjs';
import { createPendingSignupStore, confirmRequest, matchingRequest } from '../web/signup-confirmation.mjs';
import { postgresSkipReason } from '../test-support/local-postgres.mjs';
const bin = process.env.TEST_POSTGRES_BIN;
const run = (name,args) => execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:20000,
  env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C'}});
test('a sign-up with a password only becomes an account through its own link', { skip: postgresSkipReason() }, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'signup-pg-'));
  let started=false, pool;
  t.after(async()=>{await pool?.end();if(started)run('pg_ctl',['-D',path.join(root,'data'),'-m','immediate','-w','stop']);await fs.rm(root,{recursive:true,force:true});});
  await fs.mkdir(path.join(root,'socket'));
  run('initdb',['-D',path.join(root,'data'),'-U','synthetic','--auth=trust','--no-locale','--encoding=UTF8']);
  run('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'pg.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${root}/socket'`,'-w','start']);started=true;
  pool=new pg.Pool({host:path.join(root,'socket'),user:'synthetic',database:'postgres',password:'',port:5432,max:6,statement_timeout:5000});
  await pool.query(`CREATE SCHEMA mtr_harness;
    CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),email text UNIQUE NOT NULL,name text,password_hash text,deleted_at timestamptz);`);
  const store=createPendingSignupStore(pool);await store.ensureSchema();
  // The server's side, reduced to the users table.
  const deps={
    getUserByEmail:async e=>(await pool.query('SELECT * FROM mtr_harness.users WHERE email=$1',[e])).rows[0]||null,
    purgeUser:async u=>pool.query('DELETE FROM mtr_harness.users WHERE id=$1',[u.id]),
    createAccount:async r=>(await pool.query('INSERT INTO mtr_harness.users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING *',[r.email,r.name,r.password_hash])).rows[0],
  };
  const user=async e=>deps.getUserByEmail(e);
  const ask=(email,password,token)=>store.add({email,name:'Synthetic',passwordHash:hashPassword(password),language:'en'},token);

  await t.test('each link creates the account with the password of its own request and discards the others',async()=>{
    await ask('Owner@Example.invalid','attacker-pass','tok-attacker');
    await ask('owner@example.invalid','owner-pass','tok-owner');
    // Login and "send again" only see the request whose password was typed.
    const reqs=await store.forEmail('OWNER@example.invalid');
    assert.equal(reqs.length,2);
    assert.equal(matchingRequest(reqs,'owner-pass',verifyPassword).id,reqs[0].id);
    assert.equal(matchingRequest(reqs,'wrong',verifyPassword),null);
    assert.equal(await user('owner@example.invalid'),null); // no account before confirming
    const done=await confirmRequest(store,'tok-owner',deps);
    assert.equal(done.email,'owner@example.invalid');
    const u=await user('owner@example.invalid');
    assert.ok(verifyPassword('owner-pass',u.password_hash));
    assert.ok(!verifyPassword('attacker-pass',u.password_hash));
    // The same link again, and the attacker's link, no longer do anything.
    assert.equal(await confirmRequest(store,'tok-owner',deps),null);
    assert.equal(await confirmRequest(store,'tok-attacker',deps),null);
    assert.ok(verifyPassword('owner-pass',(await user('owner@example.invalid')).password_hash));
  });

  await t.test('a Google/Apple account (clear) kills the links already sent',async()=>{
    await ask('google@example.invalid','attacker-pass','tok-g');
    await deps.createAccount({email:'google@example.invalid',name:'G',password_hash:null});
    await store.clear('google@example.invalid');
    assert.equal(await confirmRequest(store,'tok-g',deps),null);
    assert.equal((await user('google@example.invalid')).password_hash,null);
  });

  await t.test('an expired link is dead; a new link works and the older one still does if unexpired',async()=>{
    const r=await ask('late@example.invalid','pw','tok-old');
    await pool.query(`UPDATE mtr_harness.pending_signups SET token_expires_at=now()-interval '1 minute' WHERE id=$1`,[r.id]);
    assert.equal((await store.forEmail('late@example.invalid'))[0].link_valid,false);
    assert.equal(await confirmRequest(store,'tok-old',deps),null);
    // consume refused the expired row without deleting it: login can still re-send.
    const again=await store.reissue(r.id,'tok-new');
    const reqs=await store.forEmail('late@example.invalid');
    assert.equal(reqs.length,1);assert.equal(reqs[0].link_valid,true);assert.equal(reqs[0].id,again.id);
    const second=await store.reissue(again.id,'tok-newer');assert.ok(second);
    assert.ok(await confirmRequest(store,'tok-new',deps)); // the first re-sent e-mail still works
    assert.equal(await confirmRequest(store,'tok-newer',deps),null);
  });

  await t.test('a request older than its lifetime cannot be confirmed or re-sent',async()=>{
    const r=await ask('old@example.invalid','pw','tok-week');
    await pool.query(`UPDATE mtr_harness.pending_signups SET created_at=now()-interval '8 days' WHERE id=$1`,[r.id]);
    assert.equal(await store.reissue(r.id,'tok-week2'),null);
    assert.deepEqual(await store.forEmail('old@example.invalid'),[]);
    assert.equal(await confirmRequest(store,'tok-week',deps),null);
  });

  await t.test('a closed account in its 30-day window is purged only on confirmation',async()=>{
    await pool.query(`INSERT INTO mtr_harness.users(email,name,password_hash,deleted_at) VALUES ('closed@example.invalid','C','x',now())`);
    await ask('closed@example.invalid','new-pw','tok-closed');
    assert.ok((await user('closed@example.invalid')).deleted_at); // the request alone touches nothing
    assert.ok(await confirmRequest(store,'tok-closed',deps));
    const u=await user('closed@example.invalid');
    assert.equal(u.deleted_at,null);assert.ok(verifyPassword('new-pw',u.password_hash));
  });

  await t.test('many taps on the e-mail\'s links at once create exactly one account',async()=>{
    for(let i=0;i<6;i++)await ask('race@example.invalid','pw'+i,'tok-race-'+i);
    const tokens=['tok-race-0','tok-race-0','tok-race-1','tok-race-2','tok-race-3','tok-race-4','tok-race-5'];
    const results=await Promise.all(tokens.map(tk=>confirmRequest(store,tk,deps)));
    assert.equal(results.filter(Boolean).length,1);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM mtr_harness.users WHERE email='race@example.invalid'`)).rows[0].n,1);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM mtr_harness.pending_signups WHERE email='race@example.invalid'`)).rows[0].n,0);
  });
});
