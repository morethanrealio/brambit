// Local, disposable real-server journey rehearsal. No production DB settings
// are inherited. The encrypted owner snapshot is the only imported input.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {spawn,execFileSync} from 'node:child_process';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../..');
const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
const input=arg('--snapshot'),privateKey=arg('--private-key'),bin=arg('--postgres-bin'),port=Number(arg('--port')||8176);
if(![input,privateKey,bin].every(x=>x&&path.isAbsolute(x)))throw Error('Required: --snapshot /private/snapshot.enc.json --private-key /private/private.pem --postgres-bin /absolute/bin');
const packed=JSON.parse(await fs.readFile(input,'utf8'));
const key=crypto.privateDecrypt(await fs.readFile(privateKey),Buffer.from(packed.key,'base64'));
const dec=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(packed.iv,'base64'));dec.setAuthTag(Buffer.from(packed.tag,'base64'));
const snapshot=JSON.parse(gunzipSync(Buffer.concat([dec.update(Buffer.from(packed.body,'base64')),dec.final()])));
if(snapshot.version!==1||snapshot.user.id!==snapshot.agent.user_id||snapshot.participant.agent_id!==snapshot.agent.id||snapshot.participant.user_id!==snapshot.user.id)throw Error('Invalid snapshot scope');
const owner=snapshot.user.id,agent=snapshot.agent.id;
const root=await fs.mkdtemp(path.join(os.tmpdir(),'brambs-discovery-sandbox-'));await fs.chmod(root,0o700);
const socket=path.join(root,'socket');await fs.mkdir(socket,{mode:0o700});
const clean={PATH:process.env.PATH,HOME:root,LANG:'C',LC_ALL:'C',TZ:'America/Sao_Paulo'};
const command=(name,args)=>execFileSync(path.join(bin,name),args,{env:clean,encoding:'utf8',timeout:20000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const session=crypto.randomBytes(32).toString('hex'),access=crypto.randomBytes(24).toString('hex');
let child,db,pgStarted=false,web,internalPort,thread,busy=false,closing=false;
const log=await fs.open(path.join(root,'server.log'),'a',0o600);
const env={...clean,PGHOST:socket,PGPORT:'5432',PGUSER:'sandbox',PGDATABASE:'postgres',PGPASSWORD:'',PORT:'0',HOST:'127.0.0.1',DISCOVERY_SANDBOX_SOCKET:socket,DISCOVERY_ENABLED:'1',VAULT_KEY:crypto.randomBytes(32).toString('base64'),APP_TASK_STORE_DIR:path.join(root,'tasks'),CODING_JOB_STORE_DIR:path.join(root,'jobs'),CREDIT_CALL_STORE_DIR:path.join(root,'calls'),DEEPSEEK_FLASH_ENABLED:'0',TOGETHER_API_KEY:snapshot.modelKey,PRIMARY_TEXT_MODEL:'deepseek-ai/DeepSeek-V4.1-Flash',PUBLIC_BASE_URL:`http://127.0.0.1:${port}`};
delete snapshot.modelKey;
async function stopApp(){if(!child)return;const p=child;child=null;if(p.exitCode===null){p.kill('SIGTERM');await Promise.race([new Promise(r=>p.once('exit',r)),sleep(70000)]);if(p.exitCode===null)throw Error('Application is still draining; refusing to reset');}}
async function startApp(){
 const observer=path.join(root,'listen.mjs');await fs.writeFile(observer,"import net from 'node:net';const l=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){this.once('listening',()=>console.log('SANDBOX_PORT='+this.address().port));return l.apply(this,a);};",{mode:0o600});
 let output='';internalPort=null;child=spawn(process.execPath,['--import',path.join(here,'network-guard.mjs'),'--import',observer,path.join(repo,'web/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b).slice(-16000);void log.write(b);internalPort=Number(output.match(/SANDBOX_PORT=(\d+)/)?.[1])||internalPort;});
 for(let n=0;n<250&&!internalPort;n++){if(child.exitCode!==null)throw Error('Sandbox application failed; see private server.log');await sleep(100);}
 if(!internalPort)throw Error('Application boot timed out');
}
async function insert(table,row){const cols=Object.keys(row);if(!cols.every(c=>/^[a-z_]+$/.test(c))||!/^[a-z_]+$/.test(table))throw Error('Invalid column');await db.query(`INSERT INTO mtr_harness.${table}(${cols.join(',')}) VALUES(${cols.map((_,i)=>'$'+(i+1)).join(',')})`,cols.map(c=>typeof row[c]==='object'&&row[c]!==null?JSON.stringify(row[c]):row[c]));}
async function seed(){
 await db.query('BEGIN');try{
  await db.query('TRUNCATE mtr_harness.users CASCADE');
  await insert('users',{...snapshot.user,email:'owner@sandbox.invalid',password_hash:'sandbox-no-password',plan:'pro',cycle_anchor:new Date().toISOString(),trial_ends_at:'2099-01-01',email_send_enabled:false});
  await insert('agents',{...snapshot.agent,perm_mode:'padrao',history:[]});
  for(const r of snapshot.threads){if(r.user_id!==owner||r.agent_id!==agent)throw Error('Thread scope mismatch');await insert('threads',r);}
  const ids=new Set(snapshot.threads.map(r=>r.id));
  for(const r of snapshot.messages){if(r.agent_id!==agent||!ids.has(r.thread_id))throw Error('Message scope mismatch');const {id,...message}=r;await insert('messages',message);}
  await insert('discovery_participants',{...snapshot.participant,status:'paused',channel:'app',ends_at:new Date(Date.now()+7*86400000).toISOString(),pause_reason:'sandbox_rehearsal'});
  for(const r of snapshot.notes){if(r.user_id!==owner)throw Error('Note scope mismatch');await insert('discovery_notes',r);}
  for(const r of snapshot.wiki){if(r.user_id!==owner)throw Error('Wiki scope mismatch');await insert('wiki_pages',r);}
  for(const r of snapshot.connections)await insert('connections',{user_id:owner,provider:r.provider,kind:r.kind,label:'Somente metadados — teste',secret_enc:'SANDBOX_NO_CREDENTIAL'});
  for(const r of snapshot.apps)await insert('apps',{...r,user_id:owner,agent_id:agent,label:'sandbox',runtime:'node'});
  for(const [i,r] of snapshot.trackers.entries())await insert('trackers',{...r,slug:'sandbox-'+i,owner_user_id:owner,agent_id:agent});
  for(const r of snapshot.routines)await insert('routines',{...r,user_id:owner,agent_id:agent,channel:'app',days:'sandbox-disabled',repeat_every_min:60,next_run:'2099-01-01'});
  await db.query('UPDATE mtr_harness.discovery_settings SET enabled=true WHERE id=1');
  await db.query("INSERT INTO mtr_harness.sessions(token,user_id,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now())",[session,owner]);
  thread=crypto.randomUUID();await insert('threads',{id:thread,user_id:owner,agent_id:agent,title:'Teste privado da jornada'});
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK');throw e;}
}
async function api(route,body){const r=await fetch(`http://127.0.0.1:${internalPort}${route}`,{method:body?'POST':'GET',headers:{cookie:'sid='+session,origin:`http://127.0.0.1:${internalPort}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error||'Application request failed');return data;}
async function state(){const conversation=await api('/api/thread?id='+thread);return {agent:snapshot.agent.name,owner:snapshot.user.name,capturedAt:snapshot.capturedAt,notes:snapshot.notes.length,sourceMessages:snapshot.messages.filter(m=>m.role==='user').length,busy,messages:conversation.messages,journey:(await db.query('SELECT status FROM mtr_harness.discovery_participants WHERE user_id=$1',[owner])).rows[0]?.status,report:(await db.query('SELECT state,reason,attempts FROM mtr_harness.discovery_reports WHERE user_id=$1',[owner])).rows[0]||null};}
async function shutdown(){if(closing)return;closing=true;web?.close();await stopApp();if(db)await db.end();if(pgStarted)command('pg_ctl',['-D',path.join(root,'data'),'-m','fast','-w','stop']);await log.close();console.log('Sandbox stopped. Private data retained at '+root);process.exit(0);}
process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());
try{
 command('initdb',['-D',path.join(root,'data'),'-U','sandbox','--auth=trust','--no-locale','--encoding=UTF8']);
 command('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'pg.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c max_connections=24`,'-w','start']);pgStarted=true;
 db=new pg.Client({host:socket,port:5432,user:'sandbox',database:'postgres',password:''});await db.connect();
 if((await db.query('SELECT inet_server_addr() a')).rows[0].a!==null)throw Error('Expected Unix socket database');
 await db.query('CREATE SCHEMA mtr_harness');await startApp();await stopApp();
 await db.query(await fs.readFile(path.join(repo,'migrations/2026-09-12-execution-credit.sql'),'utf8'));
 await seed();await startApp();
 const html=await fs.readFile(path.join(here,'index.html'));
 web=http.createServer(async(req,res)=>{
  const send=(status,data,type='application/json')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(type==='application/json'?JSON.stringify(data):data);};
  try{
   if(req.headers.host!==`127.0.0.1:${port}`)return send(403,{error:'Local host only'});
   const url=new URL(req.url,`http://127.0.0.1:${port}`);
   if(req.method==='GET'&&url.pathname==='/enter/'+access){res.writeHead(303,{location:'/', 'set-cookie':`sandbox=${access}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,'cache-control':'no-store','referrer-policy':'no-referrer'});return res.end();}
   if(!(req.headers.cookie||'').split(';').some(s=>s.trim()==='sandbox='+access))return send(401,{error:'Use the private sandbox link'});
   if(req.method==='GET'&&url.pathname==='/')return send(200,html,'text/html; charset=utf-8');
   if(req.method==='GET'&&url.pathname==='/state')return send(200,await state());
   if(req.method!=='POST'||req.headers.origin!==`http://127.0.0.1:${port}`||!String(req.headers['content-type']).startsWith('application/json'))return send(403,{error:'Local JSON request required'});
   if(!['/message','/reset'].includes(url.pathname))return send(404,{error:'Unknown route'});
   if(busy)return send(409,{error:'Aguarde a resposta atual.'});
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)return send(413,{error:'Mensagem muito longa.'});}const body=JSON.parse(raw||'{}');
   busy=true;try{
    if(url.pathname==='/message'){if(typeof body.message!=='string'||!body.message.trim())return send(400,{error:'Escreva uma mensagem.'});await api('/api/chat',{threadId:thread,message:body.message});}
    else{
     const r=(await db.query('SELECT state FROM mtr_harness.discovery_reports WHERE user_id=$1',[owner])).rows[0];
     if(['pending','generating','ready','sending'].includes(r?.state))return send(409,{error:'Aguarde o preparo da devolutiva antes de recomeçar.'});
     await stopApp();await seed();await startApp();
    }
    send(200,{ok:true});
   }finally{busy=false;}
  }catch(e){send(500,{error:e.message});}
 });
 web.listen(port,'127.0.0.1',async()=>{
  const info={url:`http://127.0.0.1:${port}/enter/${access}`,root,pid:process.pid,socket,owner,agent,capturedAt:snapshot.capturedAt};
  await fs.writeFile(path.join(path.dirname(input),'running.json'),JSON.stringify(info,null,2),{mode:0o600});
  console.log(JSON.stringify({ready:true,url:info.url,root,notes:snapshot.notes.length,messages:snapshot.messages.length}));
 });
 web.on('error',e=>{console.error(e.message);void shutdown();});
}catch(e){console.error(e.message);await shutdown();}
