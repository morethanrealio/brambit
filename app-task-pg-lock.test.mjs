// Postgres-based lock for coding tasks (the server uses this one, not flock,
// which only exists on Linux). Guarantees: two runs of the same task never enter
// together, and the lock releases on its own when the connection holding it dies.
// Disposable local PostgreSQL; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {inboxFixture} from './test-support/wa-inbox-fixture.mjs';
import {postgresSkipReason} from './test-support/local-postgres.mjs';
import {createAppTaskStore,pgTaskLock} from './web/app-task-store.mjs';

test('trava pelo Postgres: exclusiva por tarefa e solta quando a conexão morre',{timeout:40000,skip:postgresSkipReason()},async t=>{
 const f=await inboxFixture();t.after(()=>f.close());
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pg-lock-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {host,port,user,database}=f.pool.options;
 const store=createAppTaskStore({root,seal:s=>s,open:s=>s,acquire:pgTaskLock({host,port,user,database,password:''})});
 let entered,done;const inside=new Promise(r=>entered=r),hold=new Promise(r=>done=r);
 const first=store.withTask('u:a:t:x',async()=>{entered();await hold;});await inside;
 await assert.rejects(store.withTask('u:a:t:x',async()=>{throw Error('não podia entrar');}),{code:'TASK_LOCK_BUSY'});
 await store.withTask('u:a:t:outra',async()=>{});
 // Server that dies while holding the lock: Postgres drops the session and the lock goes away.
 const sessions=async()=>(await f.pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory'")).rows.map(r=>r.pid);
 for(const pid of await sessions())await f.pool.query('SELECT pg_terminate_backend($1)',[pid]);
 for(let i=0;i<100&&(await sessions()).length;i++)await new Promise(r=>setTimeout(r,20));
 await store.withTask('u:a:t:x',async({record})=>assert.equal(record,null));
 done();await first;
 assert.deepEqual(await sessions(),[]);
});
