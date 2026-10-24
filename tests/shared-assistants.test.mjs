// Community assistants (shared-assistants.mjs) against the real server, on a
// disposable Postgres with two synthetic accounts: A publishes, B uses. Catches a
// change that lets one side see the other's data: B reading A's role text,
// memory or settings through the entry, A reaching B's entry or conversations,
// or B's conversations going away with A's account. Also a version the
// publication review refuses, or can't check, going live anyway. And the plugin's
// say (sharedAssistants port): someone it doesn't allow publishing, someone
// starting a priced assistant without accepting that price, a check that can't run
// letting the action through, or a model call of an entry turn reaching the spend
// port without saying whose assistant it is (that's where the creator's price is charged).
// Same isolation as tenancy-contract.test.mjs: its own Unix socket, no outbound
// network (boot-network-guard), no inherited credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import pg from 'pg';
import {postgresSkipReason} from '../test-support/local-postgres.mjs';
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin=process.env.TEST_POSTGRES_BIN;
const cmd=(name,args)=>execFileSync(path.join(bin,name),args,{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C',HOME:os.tmpdir()}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b',C='00000000-0000-4000-8000-00000000000c';
const SID_A='synthetic-a-'+'a'.repeat(40),SID_B='synthetic-b-'+'b'.repeat(40),SID_C='synthetic-c-'+'c'.repeat(40);
const ROLE_V1='ROLE-OF-A-V1',ROLE_V2='ROLE-OF-A-V2',STYLE='STYLE-OF-A',SKILL='SKILL-BODY-OF-A';

test('a community assistant shares only the published version, and each side sees nothing of the other',{timeout:180000,skip:postgresSkipReason()},async()=>{
 let child,started=false,db,lib;const root=await fs.mkdtemp(path.join(os.tmpdir(),'brambs-boot-test-'));
 try{
  const socket=path.join(root,'socket');await fs.mkdir(socket);
  cmd('initdb',['-D',path.join(root,'data'),'-U','synthetic','--auth=trust','--no-locale','--encoding=UTF8']);
  cmd('pg_ctl',['-D',path.join(root,'data'),'-l',path.join(root,'pg.log'),'-o',`-c listen_addresses='' -c unix_socket_directories='${socket}' -c max_connections=24`,'-w','start']);started=true;
  db=new pg.Client({host:socket,port:5432,user:'synthetic',database:'postgres',password:''});await db.connect();
  await db.query('CREATE SCHEMA mtr_harness');
  const pgEnv={PGHOST:socket,PGPORT:'5432',PGUSER:'synthetic',PGDATABASE:'postgres',PGPASSWORD:'',VAULT_KEY:Buffer.alloc(32,7).toString('base64'),BRAMBIT_SHARED_ASSISTANTS:'on'};
  const env={PATH:process.env.PATH,HOME:root,TZ:'UTC',...pgEnv,PORT:'0',HOST:'127.0.0.1',TEST_BOOT_SOCKET:socket,APP_TASK_STORE_DIR:path.join(root,'tasks'),CODING_JOB_STORE_DIR:path.join(root,'jobs'),CREDIT_CALL_STORE_DIR:path.join(root,'calls'),DEEPSEEK_FLASH_ENABLED:'0',BRAMBIT_MODELS_FILE:path.join(root,'models.yaml'),BRAMBIT_PLUGINS:path.join(root,'plugins.mjs')};
  const observer=path.join(root,'listen-observer.mjs');await fs.writeFile(observer,`import net from 'node:net';const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...a){this.once('listening',()=>console.log('BOOT_TEST_PORT='+this.address().port));return listen.apply(this,a);};`);
  // The publication review answers from a fake endpoint, the only one let through the guard.
  await fs.writeFile(env.BRAMBIT_MODELS_FILE,'providers:\n  review:\n    base_url: http://review.invalid/v1\ntasks:\n  default: review/fake\n  classification: review/fake\n');
  const reviewer=path.join(root,'fake-reviewer.mjs');await fs.writeFile(reviewer,`const blocked=globalThis.fetch;globalThis.fetch=async(url,init)=>{if(!String(url).startsWith('http://review.invalid/'))return blocked(url,init);const text=JSON.parse(init.body).messages.at(-1).content;if(text.includes('REVIEW-DOWN'))return new Response('{}',{status:400});const verdict=text.includes('EXFIL-MARK')?{allowed:false,categories:['data_exfiltration'],field:'role',excerpt:'EXFIL-MARK',reason:'sends data out'}:{allowed:true,categories:[]};return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(verdict)},finish_reason:'stop'}],usage:{prompt_tokens:9,completion_tokens:9,total_tokens:18}}),{status:200,headers:{'content-type':'application/json'}});};`);
  // The plugin: B may not publish; a price only while the price file exists; both
  // hooks throw while hooks-down exists. Its spend port logs what each model call brings.
  await fs.writeFile(env.BRAMBIT_PLUGINS,`import fs from 'node:fs';import {createGastoSimples} from ${JSON.stringify(path.join(repo,'web/simple-spend.mjs'))};
const at=n=>${JSON.stringify(root)}+'/'+n,up=()=>{if(fs.existsSync(at('hooks-down')))throw Error('hook down');};
export default [{nome:'test-market',portas:()=>{const g=createGastoSimples({gravarUso:async()=>{}});return {
 sharedAssistants:{canPublish:({userId})=>(up(),{allowed:userId!==${JSON.stringify(B)}}),
  prices:({publications})=>{up();const p=fs.existsSync(at('price'))?JSON.parse(fs.readFileSync(at('price'),'utf8')):null;return Object.fromEntries(publications.map(x=>[x.id,p]));}},
 gasto:{...g,vincular:a=>{console.log('SPEND_ORIGIN='+JSON.stringify({agentId:a.agentId,origin:a.origin??null}));return g.vincular(a);}}};}}];`);
  let output='';child=spawn(process.execPath,['--import',path.join(repo,'test-support/boot-network-guard.mjs'),'--import',reviewer,'--import',observer,path.join(repo,'web/server.mjs')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  let port;for(let i=0;i<150;i++){await delay(100);port=output.match(/BOOT_TEST_PORT=(\d+)/)?.[1];if(port||child.exitCode!==null)break;}
  assert.ok(port,'server did not start up:\n'+output);
  for(let i=0;i<100;i++){if((await db.query("SELECT to_regclass('mtr_harness.agent_publications') t")).rows[0].t)break;await delay(100);}
  await db.query(`INSERT INTO mtr_harness.users(id,name,email,password_hash) VALUES($1,'Ana Creator','a@example.invalid','x'),($2,'Bia User','b@example.invalid','x'),($3,'Cid User','c@example.invalid','x')`,[A,B,C]);
  await db.query(`INSERT INTO mtr_harness.sessions(token,user_id,expires_at,last_seen_at) VALUES($1,$2,now()+interval '1 day',now()),($3,$4,now()+interval '1 day',now()),($5,$6,now()+interval '1 day',now())`,[SID_A,A,SID_B,B,SID_C,C]);
  // getAgentOwned is what every turn loads the assistant with.
  Object.assign(process.env,pgEnv);lib=await import('../web/db.mjs');
  const base='http://127.0.0.1:'+port;
  const call=async(sid,method,route,body)=>{const r=await fetch(base+route,{method,headers:{cookie:'__Host-sid='+sid,origin:base,'content-type':'application/json'},body:body&&JSON.stringify(body)});const txt=await r.text();return {status:r.status,txt,json:(()=>{try{return JSON.parse(txt);}catch{return null;}})()};};
  const ok=async(...a)=>{const r=await call(...a);assert.equal(r.status,200,a[2]+': '+r.txt);return r.json;};
  const noneOfA=(txt,where)=>{for(const s of [ROLE_V1,ROLE_V2,STYLE,SKILL,'a@example.invalid'])assert.ok(!txt.includes(s),`${where} shows the creator's ${s}`);};

  // A's assistant, with things of A's that must never reach B.
  const ag=await ok(SID_A,'POST','/api/agent',{name:'Chef',goal:'Cooking help',instructions:ROLE_V1});
  await ok(SID_A,'POST','/api/agent/update',{agentId:ag.id,style:STYLE});
  await db.query(`UPDATE mtr_harness.agents SET google_email='a@example.invalid',perm_mode='livre',cmd_allowlist='["rm"]'::jsonb,tool_config='{"groups":["shell"]}'::jsonb WHERE id=$1`,[ag.id]);
  const {rows:[sk]}=await db.query(`INSERT INTO mtr_harness.skills(owner_user_id,slug,title,trigger,body) VALUES($1,'menu','Weekly menu','when planning meals',$2) RETURNING id`,[A,SKILL]);
  await db.query(`INSERT INTO mtr_harness.skill_installs(skill_id,user_id,agent_id) VALUES($1,$2,$3)`,[sk.id,A,ag.id]);

  assert.equal((await call(SID_B,'POST','/api/shared-assistants/publish',{agentId:ag.id})).status,404,'B published A\'s assistant');
  const pub=await ok(SID_A,'POST','/api/shared-assistants/publish',{agentId:ag.id});
  assert.equal(pub.version,1);assert.equal(pub.skills,1);
  const list=await call(SID_B,'GET','/api/shared-assistants');
  assert.ok(!list.txt.includes(ag.id),'the list exposes the creator\'s assistant id');noneOfA(list.txt,'the list');
  assert.deepEqual(list.json.assistants.map(x=>[x.id,x.creator,x.own,x.using,x.price]),[[pub.publicationId,'Ana',false,false,null]]);

  // Who may publish is the plugin's call; a check that can't run refuses.
  const mine=await ok(SID_B,'POST','/api/agent',{name:'Mine',goal:'Mine',instructions:'mine'});
  const denied=await call(SID_B,'POST','/api/shared-assistants/publish',{agentId:mine.id});
  assert.equal(denied.status,403,denied.txt);
  await fs.writeFile(path.join(root,'hooks-down'),'');
  for(const r of [await call(SID_A,'POST','/api/shared-assistants/publish',{agentId:ag.id}),await call(SID_B,'GET','/api/shared-assistants')])assert.equal(r.status,503,r.txt);
  await fs.rm(path.join(root,'hooks-down'));

  // B's entry: B's own row, nothing of A's settings in it.
  const st=await ok(SID_B,'POST','/api/shared-assistants/start',{publicationId:pub.publicationId});
  assert.equal(st.created,true);
  assert.deepEqual(await ok(SID_B,'POST','/api/shared-assistants/start',{publicationId:pub.publicationId}),{agentId:st.agentId,created:false});
  assert.equal((await ok(SID_A,'POST','/api/shared-assistants/start',{publicationId:pub.publicationId})).agentId,ag.id);
  const E=st.agentId;
  const {rows:[row]}=await db.query(`SELECT user_id,instructions,goal,style,google_email,perm_mode,cmd_allowlist,tool_config FROM mtr_harness.agents WHERE id=$1`,[E]);
  assert.equal(row.user_id,B);assert.equal(row.google_email,null);noneOfA(JSON.stringify(row),'the entry row');

  // B's turn runs A's published version, under B's ownership and with no A settings.
  const turn=await lib.getAgentOwned(E,B);
  assert.ok(turn.instructions.includes(ROLE_V1)&&turn.instructions.includes('Bia User'),turn.instructions);
  assert.deepEqual([turn.user_id,turn.perm_mode,turn.cmd_allowlist,turn.tool_config,turn.google_email,turn.style],[B,'padrao',[],{},null,STYLE]);
  assert.deepEqual(turn.shared.skills.map(s=>s.body),[SKILL]);

  // B can't read the creator's text through the entry, nor change it.
  const got=await ok(SID_B,'GET','/api/agent/get?agentId='+E);
  assert.equal(got.name,'Chef');noneOfA(JSON.stringify(got),'/api/agent/get');
  assert.equal((await call(SID_B,'GET','/api/memory/prompt?agentId='+E)).status,404);
  assert.equal((await call(SID_B,'POST','/api/agent/update',{agentId:E,instructions:'mine now'})).status,409);
  assert.equal((await call(SID_B,'POST','/api/agent/rename',{agentId:E,name:'Mine'})).status,409);

  // A can't reach B's entry nor B's conversation in it.
  const th=await ok(SID_B,'POST','/api/thread',{agentId:E,title:'Bia only'});
  await db.query(`INSERT INTO mtr_harness.messages(agent_id,thread_id,role,content) VALUES($1,$2,'user','BIA-PRIVATE')`,[E,th.id]);
  assert.equal((await call(SID_A,'GET','/api/agent/get?agentId='+E)).status,404);
  const aRead=await call(SID_A,'GET','/api/thread?id='+th.id);
  assert.equal(aRead.status,404);assert.ok(!aRead.txt.includes('BIA-PRIVATE'));

  // Every model call of B's turn on the entry tells the spend port whose assistant
  // it is; A's turn on their own assistant tells nothing, so A pays no price.
  const origins=async(sid,threadId,agentId)=>{const from=output.length;await call(sid,'POST','/api/chat',{threadId,message:'hello'});await delay(300);
   return [...output.slice(from).matchAll(/SPEND_ORIGIN=(.*)/g)].map(m=>JSON.parse(m[1])).filter(o=>o.agentId===agentId).map(o=>o.origin);};
  const onEntry=await origins(SID_B,th.id,E);
  assert.ok(onEntry.length,'B\'s turn made no model call:\n'+output.slice(-3000));
  assert.deepEqual(onEntry,onEntry.map(()=>({type:'shared_assistant',publicationId:pub.publicationId,version:1,assistantId:ag.id,creatorUserId:A})));
  const onOwn=await origins(SID_A,(await ok(SID_A,'POST','/api/thread',{agentId:ag.id,title:'Ana'})).id,ag.id);
  assert.ok(onOwn.length);assert.deepEqual(onOwn,onOwn.map(()=>null));

  // A priced assistant: C starts it only by accepting the price on the screen.
  await fs.writeFile(path.join(root,'price'),JSON.stringify({key:'p1',credits:5}));
  assert.deepEqual((await ok(SID_C,'GET','/api/shared-assistants')).assistants.map(x=>x.price),[{key:'p1',credits:5}]);
  for(const acceptedPrice of [undefined,'p0']){const r=await call(SID_C,'POST','/api/shared-assistants/start',{publicationId:pub.publicationId,acceptedPrice});assert.deepEqual([r.status,r.json?.price?.key],[409,'p1']);}
  assert.equal((await db.query(`SELECT count(*)::int n FROM mtr_harness.agents WHERE user_id=$1 AND shared_entry`,[C])).rows[0].n,0);
  assert.equal((await ok(SID_C,'POST','/api/shared-assistants/start',{publicationId:pub.publicationId,acceptedPrice:'p1'})).created,true);
  assert.equal((await ok(SID_A,'GET','/api/shared-assistants')).assistants[0].price,null);
  await fs.rm(path.join(root,'price'));

  // A version the review refuses or can't check is not published: the entry keeps v1.
  await ok(SID_A,'POST','/api/agent/update',{agentId:ag.id,instructions:ROLE_V2+' EXFIL-MARK'});
  const refused=await call(SID_A,'POST','/api/shared-assistants/publish',{agentId:ag.id});
  assert.equal(refused.status,422,refused.txt);assert.deepEqual([refused.json.categories,refused.json.excerpt],[['data_exfiltration'],'EXFIL-MARK']);
  await ok(SID_A,'POST','/api/agent/update',{agentId:ag.id,instructions:ROLE_V2+' REVIEW-DOWN'});
  assert.equal((await call(SID_A,'POST','/api/shared-assistants/publish',{agentId:ag.id})).status,503);
  assert.ok((await lib.getAgentOwned(E,B)).instructions.includes(ROLE_V1));
  assert.deepEqual((await db.query(`SELECT version FROM mtr_harness.agent_publications WHERE agent_id=$1`,[ag.id])).rows,[{version:1}]);

  // A new version reaches the entry; a withdrawn one stops it, B's history stays.
  await ok(SID_A,'POST','/api/agent/update',{agentId:ag.id,name:'Chef Two',instructions:ROLE_V2});
  assert.equal((await ok(SID_A,'POST','/api/shared-assistants/publish',{agentId:ag.id})).version,2);
  const v2=await lib.getAgentOwned(E,B);
  assert.ok(v2.instructions.includes(ROLE_V2)&&!v2.instructions.includes(ROLE_V1));
  assert.equal((await db.query(`SELECT name FROM mtr_harness.agents WHERE id=$1`,[E])).rows[0].name,'Chef Two');
  const history=async()=>JSON.stringify(await ok(SID_B,'GET','/api/thread?id='+th.id));
  await ok(SID_A,'POST','/api/shared-assistants/unpublish',{agentId:ag.id});
  assert.equal(await lib.getAgentOwned(E,B),null,'a withdrawn assistant still runs');
  assert.deepEqual((await lib.getAgentOwned(E,B,{incluirArquivado:true})).shared,{available:false});
  assert.ok((await history()).includes('BIA-PRIVATE'));
  await ok(SID_A,'POST','/api/shared-assistants/publish',{agentId:ag.id});
  assert.ok(await lib.getAgentOwned(E,B));
  // The flag off is also the kill switch.
  process.env.BRAMBIT_SHARED_ASSISTANTS='';assert.equal(await lib.getAgentOwned(E,B),null);process.env.BRAMBIT_SHARED_ASSISTANTS='on';

  // A's account closed, then deleted: the entry stops, B's conversation stays.
  await db.query(`UPDATE mtr_harness.users SET deleted_at=now() WHERE id=$1`,[A]);
  assert.equal(await lib.getAgentOwned(E,B),null,'runs after the creator closed the account');
  await db.query(`DELETE FROM mtr_harness.users WHERE id=$1`,[A]);
  assert.equal((await db.query(`SELECT source_agent_id FROM mtr_harness.agents WHERE id=$1`,[E])).rows[0].source_agent_id,null);
  assert.ok((await history()).includes('BIA-PRIVATE'));
  assert.deepEqual((await ok(SID_B,'GET','/api/shared-assistants')).assistants,[]);
  assert.doesNotMatch(output,/ReferenceError|TypeError|SyntaxError/);
 }finally{await lib?.pool.end().catch(()=>{});if(child&&child.exitCode===null){child.kill('SIGKILL');}if(db)await db.end();if(started)cmd('pg_ctl',['-D',path.join(root,'data'),'-m','immediate','-w','stop']);await fs.rm(root,{recursive:true,force:true});}
});
