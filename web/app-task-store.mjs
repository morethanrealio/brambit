import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
// Kernel-owned lock, released even when the server dies. The static child exits
// when its parent's pipe closes; no user text becomes a command or argv fragment.
export async function acquireTaskLock(file) {
  const h=await fs.open(file,'a',0o600);await h.close();
  const child=spawn('flock',['--exclusive','--nonblock','--',file,process.execPath,'-e',"process.stdout.write('LOCKED\\n');process.stdin.resume();"],{stdio:['pipe','pipe','pipe']});
  // Mesmo motivo do appshost (achado #23): fechar/destruir o stdin de um filho
  // que já morreu emite EPIPE assíncrono, e stream sem listener de 'error' joga a
  // exceção e mata o processo. Aqui o desfecho vem do 'exit' do filho.
  child.stdin.on('error',()=>{});
  let released=false;
  const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',()=>resolve(-1));});
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(new Error('Task lock startup timed out'));},5000);
      let text='';const done=fn=>{clearTimeout(timer);fn();};
      child.once('error',()=>done(()=>reject(new Error('Task lock unavailable'))));
      child.once('exit',code=>done(()=>reject(Object.assign(new Error('Outra execução possui a tarefa ou o lock está indisponível.'),{code:code===1?'TASK_LOCK_BUSY':'TASK_LOCK_UNAVAILABLE'}))));
      child.stdout.on('data',part=>{text+=part;if(text.includes('LOCKED\n'))done(resolve);});
    });
  }catch(e){child.stdin.destroy();child.kill();await exited;throw e;}
  return async()=>{if(released)return;released=true;child.stdin.end();await exited;};
}
// Private encrypted task checkpoints. Single-host store; a live lock is never stolen.
// The owner/agent/thread/app scope is also inside authenticated ciphertext.
export function createAppTaskStore({root,seal,open,acquire=acquireTaskLock,maxBytes=8_000_000}) {
  if(!path.isAbsolute(root)||typeof seal!=='function'||typeof open!=='function')throw new Error('Task store requires private absolute root and encryption.');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>256_000_000)throw Error('Invalid checkpoint size bound');
  const maxEncryptedBytes=Math.ceil(maxBytes*1.5);
  const decode=async(file,expectedScope=null)=>{
    const raw=await fs.readFile(file,'utf8');if(Buffer.byteLength(raw)>maxEncryptedBytes)throw Error('Checkpoint exceeds bound');
    const value=JSON.parse(await open(raw));
    if(value.version!==1||typeof value.scope!=='string'||(expectedScope!==null&&value.scope!==expectedScope))throw Error('Invalid checkpoint identity');
    if(createHash('sha256').update(value.scope).digest('hex')!==path.basename(path.dirname(file)))throw Error('Invalid checkpoint location');
    return value;
  };
  return {
    // Atomic rename makes a read-only status snapshot safe without waiting for
    // the long-running worker lock. It is not authority to perform an operation.
    async read(scope){
      const id=createHash('sha256').update(scope).digest('hex');
      try{return (await decode(path.join(root,id,'checkpoint.enc'),scope)).record;}catch(e){if(e.code==='ENOENT')return null;throw e;}
    },
    async entries(){
      let dirs;try{dirs=await fs.readdir(root,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
      const entries=[];
      for(const dir of dirs)if(dir.isDirectory()&&/^[a-f0-9]{64}$/.test(dir.name)){
        try{entries.push(await decode(path.join(root,dir.name,'checkpoint.enc')));}catch(e){if(e.code!=='ENOENT')throw e;}
      }
      return entries;
    },
    async withTask(scope,run) {
    if(typeof scope!=='string'||!scope||scope.length>1000)throw new Error('Invalid task scope');
    const id=createHash('sha256').update(scope).digest('hex');
    await fs.mkdir(root,{recursive:true,mode:0o700});
    const dir=path.join(root,id),lock=path.join(dir,'task.lock'),file=path.join(dir,'checkpoint.enc');
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const nonce=randomUUID();
    const release=await acquire(lock);
    try {
      let record=null;
      try {const raw=await fs.readFile(file,'utf8');if(Buffer.byteLength(raw)>maxEncryptedBytes)throw new Error('Checkpoint exceeds bound');
        const value=JSON.parse(await open(raw));if(value.scope!==scope||value.version!==1)throw new Error('Invalid checkpoint identity');record=value.record;
      } catch(e){if(e.code!=='ENOENT')throw e;}
      const save=async value=>{
        const text=JSON.stringify({version:1,scope,record:value});if(Buffer.byteLength(text,'utf8')>maxBytes)throw new Error('Checkpoint exceeds bound');
        const encrypted=await seal(text);if(Buffer.byteLength(encrypted,'utf8')>maxEncryptedBytes)throw new Error('Encrypted checkpoint exceeds bound');
        const tmp=path.join(dir,nonce+'.tmp');const h=await fs.open(tmp,'wx',0o600);
        try {
          try {await h.writeFile(encrypted);await h.sync();}finally{await h.close();}
          await fs.rename(tmp,file);
        }catch(error){await fs.unlink(tmp).catch(()=>{});throw error;}
        const d=await fs.open(dir,'r');try{await d.sync();}finally{await d.close();}
      };
      return await run({record,save,id});
    } finally {await release();}
  }};
}
