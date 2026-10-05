// Preloaded ONLY in the disposable application process. All external I/O is
// blocked there. A dedicated worker accepts one fixed model API, streams its
// response, and cannot be used as an arbitrary HTTP proxy.
import net from 'node:net';
import tls from 'node:tls';
import cp from 'node:child_process';
import workers from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
const endpoint='https://api.together.xyz/v1/chat/completions';
const denied=()=>{const error=Error('SANDBOX_EXTERNAL_IO_BLOCKED');console.error(error.stack);throw error;};
if(!workers.isMainThread){
 const active=new Map();
 workers.parentPort.on('message',async m=>{
  if(m.abort){active.get(m.id)?.abort();return;}
  if(m.url!==endpoint||m.method!=='POST'){workers.parentPort.postMessage({id:m.id,error:'SANDBOX_EXTERNAL_IO_BLOCKED'});return;}
  const controller=new AbortController();active.set(m.id,controller);
  try{
   const r=await fetch(endpoint,{method:'POST',headers:m.headers,body:m.body,redirect:'error',signal:controller.signal});
   workers.parentPort.postMessage({id:m.id,status:r.status,headers:[...r.headers]});
   for await(const chunk of r.body)workers.parentPort.postMessage({id:m.id,chunk});
   workers.parentPort.postMessage({id:m.id,end:true});
  }catch{workers.parentPort.postMessage({id:m.id,error:'SANDBOX_MODEL_REQUEST_FAILED'});}
  finally{active.delete(m.id);}
 });
}else{
 const socket=process.env.DISCOVERY_SANDBOX_SOCKET;
 if(!socket||!path.isAbsolute(socket)||!socket.includes('brambs-discovery-sandbox-'))throw Error('Owned sandbox socket required');
 const broker=new workers.Worker(new URL(import.meta.url),{execArgv:[]});broker.unref();
 const pending=new Map();let seq=0;
 broker.on('message',m=>{const p=pending.get(m.id);if(!p)return;
  if(m.error){p.reject(Error(m.error));p.stream?.error(Error(m.error));p.done();}
  else if(m.status){p.resolve(new Response(new ReadableStream({start(c){p.stream=c;},cancel(){broker.postMessage({id:m.id,abort:true});p.done();}}),{status:m.status,headers:m.headers}));}
  else if(m.chunk)p.stream.enqueue(m.chunk);
  else if(m.end){p.stream.close();p.done();}
 });
 broker.on('error',()=>{for(const p of [...pending.values()]){p.reject(Error('SANDBOX_MODEL_BROKER_FAILED'));p.stream?.error(Error('SANDBOX_MODEL_BROKER_FAILED'));p.done();}});
 globalThis.fetch=(url,opts={})=>{
  if(String(url)!==endpoint||opts.method!=='POST')return denied();
  if(opts.signal?.aborted)return Promise.reject(opts.signal.reason);
  const id=++seq;
  return new Promise((resolve,reject)=>{
   const abort=()=>{broker.postMessage({id,abort:true});const p=pending.get(id);p?.reject(Error('Sandbox request aborted'));p?.stream?.error(Error('Sandbox request aborted'));p?.done();};
   const done=()=>{pending.delete(id);opts.signal?.removeEventListener('abort',abort);};
   pending.set(id,{resolve,reject,done});opts.signal?.addEventListener('abort',abort,{once:true});
   broker.postMessage({id,url:String(url),method:opts.method,headers:[...new Headers(opts.headers)],body:opts.body});
  });
 };
 const connect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){let o=args[0];if(Array.isArray(o))o=o[0];const p=typeof o==='string'?o:o?.path;if(p===path.join(socket,'.s.PGSQL.5432'))return connect.apply(this,args);return denied();};
 tls.connect=denied;
 const spawn=cp.spawn;
 const stores=['APP_TASK_STORE_DIR','CODING_JOB_STORE_DIR','CREDIT_CALL_STORE_DIR'].map(k=>process.env[k]).filter(Boolean);
 const lockProgram="process.stdout.write('LOCKED\\n');process.stdin.resume();";
 cp.spawn=(file,args,options)=>{
  // The real credit/checkpoint store uses a static flock helper. Permit only
  // that exact program and a hash-named lock under this sandbox's private root.
  const lock=args?.[3];
  const owned=typeof lock==='string'&&stores.some(root=>/^(?:[a-f0-9]{64}\/){1,2}task\.lock$/.test(path.relative(root,lock)));
  if(file==='flock'&&args?.length===7&&args[0]==='--exclusive'&&args[1]==='--nonblock'&&args[2]==='--'&&owned&&args[4]===process.execPath&&args[5]==='-e'&&args[6]===lockProgram&&JSON.stringify(options?.stdio)==='["pipe","pipe","pipe"]')return spawn(file,args,{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH}});
  return denied();
 };
 for(const name of ['spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=denied;
 workers.Worker=class{constructor(){denied();}};
 syncBuiltinESMExports();
}
