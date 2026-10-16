import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {createWaInbox} from '../web/whatsapp-inbox.mjs';
import {encryptSecret,decryptSecret} from '../web/vault.mjs';

export const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export async function inboxFixture(){
 const bin=process.env.TEST_POSTGRES_BIN;if(!bin||!path.isAbsolute(bin))throw Error('TEST_POSTGRES_BIN must name explicit local PostgreSQL binaries');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'wa-inbox-test-')),data=path.join(root,'data'),socket=path.join(root,'socket');await fs.mkdir(socket);
 const cmd=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C',HOME:root}});
 let started=false,pool;
 try{
  cmd('initdb',['-D',data,'-U','synthetic','--auth=trust','--no-locale','--encoding=UTF8']);cmd('pg_ctl',['-D',data,'-l',path.join(root,'pg.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}'`,'-w','start']);started=true;
  pool=new pg.Pool({host:socket,user:'synthetic',database:'postgres',password:'',port:5432,max:8});
  await pool.query('CREATE SCHEMA mtr_harness; CREATE TABLE mtr_harness.users(id uuid primary key); CREATE TABLE mtr_harness.agents(id uuid primary key); CREATE TABLE mtr_harness.whatsapp_seen(wamid text primary key,created_at timestamptz default now());');
  await pool.query('INSERT INTO mtr_harness.users VALUES($1),($2);',[uuid(1),uuid(2)]);await pool.query('INSERT INTO mtr_harness.agents VALUES($1),($2)',[uuid(11),uuid(12)]);
  process.env.VAULT_KEY=Buffer.alloc(32,19).toString('base64');
  const stores=[];const make=()=>{const s=createWaInbox(pool,{seal:encryptSecret,open:decryptSecret,lookupRecipient:async()=>({enabled:true,user_id:uuid(1)})});stores.push(s);return s;};const store=make();await store.init();
  return {pool,store,make,async close(){for(const s of stores)await s.release();await pool.end();cmd('pg_ctl',['-D',data,'-m','immediate','-w','stop']);await fs.rm(root,{recursive:true,force:true});}};
 }catch(e){if(pool)await pool.end();if(started)cmd('pg_ctl',['-D',data,'-m','immediate','-w','stop']);await fs.rm(root,{recursive:true,force:true});throw e;}
}
