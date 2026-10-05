import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('sandbox denies production DB, connectors, shell and additional workers',()=>{
 const code=`import assert from 'node:assert/strict';import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {Worker} from 'node:worker_threads';
 const probes=[()=>net.connect({host:'127.0.0.1',port:5432}),()=>net.connect({host:'10.0.0.5',port:5432}),()=>net.connect('/tmp/other-postgres'),()=>tls.connect({host:'api.together.xyz',port:443}),()=>fetch('https://api.telegram.org'),()=>fetch('https://api.together.xyz/v1/chat/completions',{method:'GET'}),()=>fetch('https://api.together.xyz.evil.invalid/v1/chat/completions',{method:'POST'}),()=>cp.execFileSync('true'),()=>new Worker('')];
 for(const op of probes)assert.throws(op,/SANDBOX_EXTERNAL_IO_BLOCKED/);console.log(probes.length+' blocked');process.exit(0);`;
 const result=execFileSync(process.execPath,['--import',fileURLToPath(new URL('./network-guard.mjs',import.meta.url)),'--input-type=module','-e',code],{encoding:'utf8',stdio:'pipe',timeout:10000,env:{PATH:process.env.PATH,DISCOVERY_SANDBOX_SOCKET:'/tmp/brambs-discovery-sandbox-probe/socket'}});
 assert.match(result,/9 blocked/);
});
test('only the exact checkpoint lock helper may spawn, including credit nesting',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'brambs-discovery-sandbox-lock-'));
 try{
  const code=`import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import cp from 'node:child_process';
   const root=process.env.CREDIT_CALL_STORE_DIR,dir=path.join(root,'a'.repeat(64),'b'.repeat(64));await fs.mkdir(dir,{recursive:true});
   const args=['--exclusive','--nonblock','--',path.join(dir,'task.lock'),process.execPath,'-e',"process.stdout.write('LOCKED\\\\n');process.stdin.resume();"];
   assert.throws(()=>cp.spawn('flock',[...args.slice(0,-1),'process.exit(0)'],{stdio:['pipe','pipe','pipe']}),/SANDBOX_EXTERNAL_IO_BLOCKED/);
   const p=cp.spawn('flock',args,{stdio:['pipe','pipe','pipe']});let text='';p.stdout.on('data',b=>{text+=b;p.stdin.end();});const exit=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',resolve);});assert.equal(exit,0);assert.equal(text,'LOCKED\\n');process.exit(0);`;
  execFileSync(process.execPath,['--import',fileURLToPath(new URL('./network-guard.mjs',import.meta.url)),'--input-type=module','-e',code],{stdio:'pipe',timeout:10000,env:{PATH:process.env.PATH,CREDIT_CALL_STORE_DIR:root,DISCOVERY_SANDBOX_SOCKET:path.join(root,'socket')}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('sandbox requires an explicit owned socket',()=>{
 assert.throws(()=>execFileSync(process.execPath,['--import',fileURLToPath(new URL('./network-guard.mjs',import.meta.url)),'-e','process.exit(0)'],{env:{PATH:process.env.PATH},stdio:'pipe',timeout:5000}),/Owned sandbox socket required/);
});
