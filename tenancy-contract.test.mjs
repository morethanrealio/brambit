// Contrato de isolamento entre contas do núcleo (C2, passo 11c4): as sondas de
// ops/tenancy-* rodam contra o servidor de verdade, num Postgres descartável e
// com duas contas sintéticas. Pega handler novo ou mexido que aceita id e
// esquece o dono: com a sessão de B, ler ou mudar coisa de A tem que falhar.
// Mesmo isolamento do server-boot.test.mjs: socket Unix próprio, nenhuma rede
// de saída (boot-network-guard), nenhuma credencial herdada.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import pg from 'pg';
import {postgresSkipReason} from './test-support/local-postgres.mjs';
const repo=path.dirname(fileURLToPath(import.meta.url));
const bin=process.env.TEST_POSTGRES_BIN;
const cmd=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C',HOME:os.tmpdir()}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
const SID_A='sintetica-a-'+'a'.repeat(40),SID_B='sintetica-b-'+'b'.repeat(40);

// Pulos esperados: mídia mora no bucket, que não existe sem rede (pelo mesmo
// motivo o arquivo descartável da sonda de escrita não nasce e DELETE /api/files
// fica de fora). Qualquer outro pulo é sonda que deixou de exercitar alguma coisa.
const PULOS={
 'ops/tenancy-test.mjs':['GET /api/media?key|A','GET /api/media?key|B'],
 'ops/tenancy-write-test.mjs':[],
 'ops/tenancy-runner-test.mjs':[],
};
const MINIMO={'ops/tenancy-test.mjs':30,'ops/tenancy-write-test.mjs':29,'ops/tenancy-runner-test.mjs':15};

// Roda a sonda e devolve o relatório JSON que ela imprime no fim (JSON=1).
function sonda(arquivo,base){
 return new Promise((resolve)=>{
  const p=spawn(process.execPath,[path.join(repo,arquivo)],{cwd:repo,env:{PATH:process.env.PATH,BASE:base,SID_A,SID_B,UID_A:A,UID_B:B,JSON:'1'},stdio:['ignore','pipe','pipe']});
  let out='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>out+=b);
  p.on('exit',code=>{const i=out.indexOf('\n{');resolve({code,out,rel:i<0?null:JSON.parse(out.slice(i+1))});});
 });
}

test('sondas de isolamento entre contas passam no servidor real com duas contas sintéticas',{timeout:180000,skip:postgresSkipReason()},async()=>{
 let child,started=false,db;const root=await fs.mkdtemp(path.join(os.tmpdir(),'brambs-boot-test-'));
 try{
  const socket=path.join(root,'socket');await fs.mkdir(socket);
  cmd('initdb',['-D',path.join(root,'data'),'-U','synthetic','--auth=trust','--no-locale','--encoding=UTF8']);
  cmd('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'pg.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c max_connections=24`,'-w','start']);started=true;
  db=new pg.Client({host:socket,port:5432,user:'synthetic',database:'postgres',password:''});await db.connect();
  await db.query('CREATE SCHEMA mtr_harness');
  const env={PATH:process.env.PATH,HOME:root,TZ:'UTC',PGHOST:socket,PGPORT:'5432',PGUSER:'synthetic',PGDATABASE:'postgres',PGPASSWORD:'',PORT:'0',HOST:'127.0.0.1',TEST_BOOT_SOCKET:socket,VAULT_KEY:Buffer.alloc(32,7).toString('base64'),APP_TASK_STORE_DIR:path.join(root,'tasks'),CODING_JOB_STORE_DIR:path.join(root,'jobs'),CREDIT_CALL_STORE_DIR:path.join(root,'calls'),DEEPSEEK_FLASH_ENABLED:'0'};
  const observer=path.join(root,'listen-observer.mjs');await fs.writeFile(observer,`import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){this.once('listening',()=>console.log('BOOT_TEST_PORT='+this.address().port));return listen.apply(this,a);};`);
  let output='';child=spawn(process.execPath,['--import',path.join(repo,'test-support/boot-network-guard.mjs'),'--import',observer,path.join(repo,'web/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  let port;for(let i=0;i<150;i++){await delay(100);port=output.match(/BOOT_TEST_PORT=(\d+)/)?.[1];if(port||child.exitCode!==null)break;}
  assert.ok(port,'servidor não subiu:\n'+output);
  // espera o initDb terminar antes de gravar as contas
  for(let i=0;i<100;i++){if((await db.query("SELECT to_regclass('mtr_harness.sessions') t")).rows[0].t)break;await delay(100);}
  await db.query(`INSERT INTO mtr_harness.users(id,name,email,password_hash) VALUES($1,'Conta A','a@example.invalid','x'),($2,'Conta B','b@example.invalid','x')`,[A,B]);
  await db.query(`INSERT INTO mtr_harness.sessions(token,user_id,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now()),($3,$4,now()+interval '1 day',now())`,[SID_A,A,SID_B,B]);
  const base='http://127.0.0.1:'+port;
  // A sonda de leitura só prova alguma coisa com dado dos dois lados: cada conta
  // ganha assistente, conversa e página própria, e as duas uma página de mesmo slug.
  const post=async(sid,rota,body)=>{const r=await fetch(base+rota,{method:'POST',headers:{cookie:'sid='+sid,origin:base,'content-type':'application/json'},body:JSON.stringify(body)});const txt=await r.text();assert.equal(r.status,200,rota+': '+txt);return JSON.parse(txt);};
  for(const [sid,nome] of [[SID_A,'a'],[SID_B,'b']]){
   const ag=await post(sid,'/api/agent',{name:'Assistente '+nome,goal:'teste',instructions:'teste'});
   await post(sid,'/api/thread',{agentId:ag.id,title:'Conversa '+nome});
   await post(sid,'/api/memory/page',{slug:'so-'+nome,title:'Só '+nome,body:'conteúdo de '+nome});
   await post(sid,'/api/memory/page',{slug:'comum',title:'Comum',body:'versão de '+nome});
  }
  for(const f of Object.keys(PULOS)){
   const r=await sonda(f,base);
   assert.equal(r.code,0,f+':\n'+r.out);
   const res=r.rel.results;
   assert.deepEqual(res.filter(x=>x.ok===false),[],f);
   assert.deepEqual(res.filter(x=>x.ok===null).map(x=>x.nome+'|'+(x.alvo||'')).sort(),PULOS[f].sort(),f+': pulo novo\n'+r.out);
   console.log(f+': '+res.filter(x=>x.ok).length+' provas de isolamento passaram');
   assert.ok(res.filter(x=>x.ok).length>=MINIMO[f],f+': menos provas que o esperado\n'+r.out);
  }
  assert.doesNotMatch(output,/ReferenceError|TypeError|SyntaxError/);
 }finally{if(child&&child.exitCode===null){child.kill('SIGKILL');}if(db)await db.end();if(started)cmd('pg_ctl',['-D',path.join(root,'data'),'-m','immediate','-w','stop']);await fs.rm(root,{recursive:true,force:true});}
});
