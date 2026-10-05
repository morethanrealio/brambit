import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import net from 'node:net';import tls from 'node:tls';
import {createAppTaskStore} from './web/app-task-store.mjs';import {runAppTask} from './web/app-task-runner.mjs';import {fixture,step,read,options} from './test-support/coding/context-fixture.mjs';
net.Socket.prototype.connect=()=>{throw Error('External network forbidden')};tls.connect=()=>{throw Error('External network forbidden')};globalThis.fetch=()=>{throw Error('External network forbidden')};
test('encrypted filesystem + flock: pause after eviction, recreate controller, recover pages and complete edit',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'coding-context-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const key=crypto.randomBytes(32);
 const seal=text=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),b=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64')};
 const open=text=>{const b=Buffer.from(text,'base64'),d=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString()};
 const makeStore=()=>createAppTaskStore({root,seal,open});const f=fixture();let n=0;
 const first=await runAppTask(options(f,makeStore(),{complete:async()=>{n++;return step(n===1?[read(f,'server.js',0),read(f,'server.js',6000)]:[read(f,'game.js',0),read(f,'game.js',6000),read(f,'game.js',12000)],n)}},{limits:{contextChars:12000},shouldPause:async()=>n>=2}));
 assert.equal(first.app_build.motivo,'new_user_input');const old=await makeStore().read('fixture');assert.ok(Object.keys(old.contextArtifacts).length>=2);
 for(const dir of await fs.readdir(root)){const raw=await fs.readFile(path.join(root,dir,'checkpoint.enc'),'utf8').catch(()=> '');assert.ok(!raw.includes('SERVER_CODE_'));}
 n=0;const result=await runAppTask(options(f,makeStore(),{complete:async()=>{n++;return n<=3?step([read(f,'server.js',(n-1)*3000,3000)],n):n===4?step([{name:'editar_arquivo_do_app',args:{caminho:'server.js'}}],n):n===5?step([{name:'validar_rascunho_do_app',args:{}}],n):{stop:'end',text:'Done, static validation only'};}},{executionId:'resume',limits:{contextChars:12000}}));
 assert.equal(result.app_build.motivo,'completed');assert.equal(f.writes,1);assert.equal(f.reads,5);const current=await makeStore().read('fixture');assert.equal(current.calls,old.calls+6);assert.equal(current.contextStats.cacheHits,3);
});
