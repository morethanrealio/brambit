import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import net from 'node:net';import tls from 'node:tls';
import {createAppTaskStore} from '../web/app-task-store.mjs';
net.Socket.prototype.connect=()=>{throw Error('Network forbidden');};tls.connect=()=>{throw Error('Network forbidden');};globalThis.fetch=()=>{throw Error('Network forbidden');};
// Only child process is the store's static flock holder. No LLM, API, shell or app.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'nani-task-fixture-')),key=crypto.randomBytes(32);
const seal=s=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([c.update(s),c.final()]);return Buffer.concat([iv,c.getAuthTag(),b]).toString('base64');};
const open=s=>{const b=Buffer.from(s,'base64'),c=crypto.createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]).toString();};
let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
try {
 const a=createAppTaskStore({root,seal,open});
 await a.withTask('u:a:t:demo',async({record,save})=>{eq(record,null);await save({status:'paused',history:[{content:'PRIVATE SOURCE'}],calls:12});await save({status:'paused',history:[{content:'PRIVATE SOURCE'}],calls:13});});
 const b=createAppTaskStore({root,seal,open});await b.withTask('u:a:t:demo',async({record})=>{eq(record.calls,13);eq(record.history[0].content,'PRIVATE SOURCE');});
 await b.withTask('other:a:t:demo',async({record})=>eq(record,null));
 let done,entered;const ready=new Promise(r=>entered=r),hold=new Promise(r=>done=r);
 const first=a.withTask('locked',async()=>{entered();await hold;});await ready;
 await assert.rejects(b.withTask('locked',async()=>{throw Error('Must not enter');}));checks++;done();await first;
 await b.withTask('locked',async({record})=>eq(record,null));
 const id=crypto.createHash('sha256').update('u:a:t:demo').digest('hex'),file=path.join(root,id,'checkpoint.enc');
 eq((await fs.readFile(file,'utf8')).includes('PRIVATE SOURCE'),false);eq((await fs.stat(file)).mode&0o777,0o600);
 const original=await fs.readFile(file,'utf8');await fs.writeFile(file,original.slice(0,-5)+'AAAAA');await assert.rejects(b.withTask('u:a:t:demo',async()=>{}));checks++;
 // Abrupt death of an independent fixture process releases the kernel lock;
 // its durable pending effect survives, so the runner can refuse replay.
 const moduleUrl=new URL('../web/app-task-store.mjs',import.meta.url).href;
 const source=`import {createAppTaskStore} from ${JSON.stringify(moduleUrl)};const store=createAppTaskStore({root:${JSON.stringify(root)},seal:s=>Buffer.from(s).toString('base64'),open:s=>Buffer.from(s,'base64').toString()});await store.withTask('crash',async({save})=>{await save({pending:{mutating:true,name:'fixture_write'}});process.stdout.write('READY\\n');await new Promise(()=>{setInterval(()=>{},1000)});});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('fixture timeout')),5000);child.stdout.on('data',x=>{text+=x;if(text.includes('READY')){clearTimeout(timer);resolve();}});child.once('exit',()=>reject(Error('fixture exited early')));});
 const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited;
 const recovered=createAppTaskStore({root,seal:s=>Buffer.from(s).toString('base64'),open:s=>Buffer.from(s,'base64').toString()});
 let value;for(let i=0;i<10;i++){try{value=await recovered.withTask('crash',async({record})=>record);break;}catch{await new Promise(r=>setTimeout(r,50));}}
 eq(value.pending.mutating,true);eq(value.pending.name,'fixture_write');
 await assert.rejects(a.withTask('unicode-bound',async({save})=>save({content:'漢'.repeat(2_700_000)})),/bound/);checks++;
 await a.withTask('unicode-bound',async({record})=>eq(record,null));
 console.log(`PASS ${checks} encrypted filesystem/lock checks (no network)`);
}finally{await fs.rm(root,{recursive:true,force:true});}
