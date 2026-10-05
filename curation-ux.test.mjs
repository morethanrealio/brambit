import {emailSearchToolSchema,emailSearchToolHelp,prepareEmailSearchChange} from './web/email-search-config.mjs';
import {isPauseOnlyRoutineChange} from './web/scheduler.mjs';
import { createScheduledDelivery } from './web/scheduled-delivery.mjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import net from 'node:net';import tls from 'node:tls';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const denied=()=>{throw Error('REAL I/O FORBIDDEN');};net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
for(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=denied;syncBuiltinESMExports();
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
import {curationToolSchema,curationToolHelp,prepareCurationChange,describeCuration,looksLikeCuration,editableCuration,pruneCurationTools} from './web/curation-config.mjs';
import {normalizeCurationConfig,finalizeCuration,curationPrompt} from './web/curation-runtime.mjs';
import {createCurationStore,deliverCurationEdition} from './web/curation-store.mjs';
import {curationPackets,sendCurationChannel} from './web/curation-delivery.mjs';
import {curationArticleKey} from './web/curation-policy.mjs';
import {gateTool,takePending,hasPending,isConfirmation} from './web/confirm.mjs';
import {randomUUID} from 'node:crypto';
import {routineConfirmationSnapshot} from './web/confirmation-bindings.mjs';
import {parseRoutineTime,routineTimeLabel,routineSupersedeKey} from './web/routine-time.mjs';
import {confirmationFingerprint} from './web/confirmation-store.mjs';
import {pendingRoutineEdit,routineTestOutcome} from './web/routine-edit-test.mjs';
import {routineActionFailure,actionResult} from './web/action-evidence.mjs';
let n=0;const eq=(a,b)=>{assert.deepEqual(a,b);n++;},ok=v=>{assert.ok(v);n++;},reject=async f=>{await assert.rejects(f);n++;};
const uuid=i=>'00000000-0000-0000-0000-'+String(i).padStart(12,'0');
const cfg={source:'web',sections:[{id:'news',label:'Energia solar',min:0,max:3,maxAgeDays:7}],summaryBullets:1,includeWhy:false,language:'pt-BR'};
const prompt='Busque até três artigos recentes sobre energia solar, com resumo curto.';
for(const channel of ['email','whatsapp','telegram','app','none']){
 const c=prepareCurationChange(null,{tipo:'curadoria',curadoria:cfg,prompt,channel});eq(c.curation.sections[0].min,0);eq(c.curation.source,'web');
}
for(const args of [{tipo:'curadoria',prompt},{curadoria:cfg,prompt,channel:'fax'},{curadoria:{...cfg,source:'other'},prompt,channel:'email'},{curadoria:{...cfg,sections:[{...cfg.sections[0],max:9}]},prompt,channel:'email'},{tipo:'geral',curadoria:cfg,prompt,channel:'email'},{prompt}])assert.throws(()=>prepareCurationChange(null,args)),n++;
for(const p of ['Olhe minha agenda','Faça triagem de e-mails; ignore newsletters','Use checar_monitor para novidades da Zara','Envie a oração da Canção Nova'])eq(looksLikeCuration(p),false);
eq(prepareCurationChange(null,{prompt:'Olhe a agenda'}),undefined);
eq(editableCuration({...cfg,version:2,excludeUrls:['https://example.invalid/old']}),cfg);
for(const source of ['web','gmail']){const registry={map:new Map(['google','buscar_web','abrir_link','memoria_ler','enviar_mensagem','gmail_send','gmail_create_draft','criar_lembrete','ssh'].map(k=>[k,{}]))};pruneCurationTools(registry,source);eq([...registry.map.keys()],source==='gmail'?['google','memoria_ler']:['buscar_web','abrir_link','memoria_ler']);}
const current={config:{other:42,curation:{...cfg,version:2,excludeUrls:['https://example.invalid/old']}},prompt,channel:'email'};
const changed=prepareCurationChange(current,{curadoria:{...cfg,sections:[{...cfg.sections[0],max:2}]},prompt:prompt+' Só dois.',channel:'whatsapp'});
eq(changed.other,42);eq(changed.curation.excludeUrls,current.config.curation.excludeUrls);
assert.throws(()=>prepareCurationChange(current,{prompt:'Outra tarefa'}));n++;
assert.throws(()=>prepareCurationChange(current,{tipo:'geral'}));n++;
assert.throws(()=>prepareCurationChange({...current,config:{flight_monitor:{}}},{curadoria:cfg,prompt,channel:'email'}));n++;
ok(describeCuration(changed.curation).includes('0–2'));ok(curationPrompt({...cfg,version:2},[]).includes('1 resumos'));
const pg=new PGlite();await pg.exec(`CREATE SCHEMA mtr_harness;
 CREATE TABLE mtr_harness.users(id uuid PRIMARY KEY);
 CREATE TABLE mtr_harness.routines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES mtr_harness.users,agent_id uuid,title text,prompt text,hour int,minute int NOT NULL DEFAULT 0,days text,tz text,channel text,enabled boolean DEFAULT true,repeat_every_min int,repeat_until timestamptz,next_run timestamptz,config jsonb DEFAULT '{}');
 CREATE TABLE mtr_harness.threads(id uuid PRIMARY KEY,user_id uuid,agent_id uuid);
 CREATE TABLE mtr_harness.messages(id serial PRIMARY KEY,thread_id uuid,role text,content text);`);
for(const u of [1,2])await pg.query('INSERT INTO mtr_harness.users VALUES($1)',[uuid(u)]);
await pg.exec(readFileSync('migrations/20260911-curation-deliveries.sql','utf8'));
const pool={query:(s,v)=>pg.query(s,v),connect:async()=>({query:(s,v)=>pg.query(s,v),release(){}})};
const db=readFileSync('web/db.mjs','utf8'),server=readFileSync('web/server.mjs','utf8');
function extract(source,name){const a=source.indexOf('async function '+name+'('),b=source.indexOf('\n}\n',a);ok(a>=0&&b>a);return source.slice(a,b+2);}
function extractSync(source,name,deps={}){const a=source.indexOf('function '+name+'('),b=source.indexOf('\n}',a)+2;ok(a>=0&&b>a);return new Function(...Object.keys(deps),source.slice(a,b)+';return '+name)(...Object.values(deps));}
const prepareRoutineChange=extractSync(server,'prepareRoutineChange',{prepareCurationChange,prepareEmailSearchChange});
const composeRoutineConfig=extractSync(db,'composeRoutineConfig',{prepareCurationChange,prepareEmailSearchChange});
const emailSearchTipo=extractSync(db,'emailSearchTipo');
const crud={};for(const name of ['createRoutine','updateRoutine','deleteRoutine'])crud[name]=new Function('pool','S','composeRoutineConfig','emailSearchTipo',extract(db,name)+';return '+name)(pool,'mtr_harness',composeRoutineConfig,emailSearchTipo);
const store=createCurationStore(pool);
function routineTool(name,user,extra={}){
 const a=server.indexOf("    name: '"+name+"',"),start=server.lastIndexOf('addGated(registry, [{',a),end=server.indexOf('}], thread.id);',a)+'}], thread.id);'.length;let raw;
 const deps={registry:{},addGated:(r,ts)=>{raw=ts[0];},thread:{id:'test-'+user},userId:uuid(user),agent:{id:uuid(10+user)},userTz:'America/Sao_Paulo',curationToolHelp,curationToolSchema,prepareCurationChange,describeCuration,emailSearchToolSchema,emailSearchToolHelp,prepareRoutineChange,isPauseOnlyRoutineChange,routineConfirmationSnapshot,confirmationFingerprint,parseRoutineTime,routineTimeLabel,routineSupersedeKey,
  checarArgsRotina:()=>null,normalizeRoutineDays:()=>({days:'[1]'}),normalizarCanalRotina:ch=>({ch:ch==='app'?'none':ch||'none'}),parseRecurrence:()=>null,setUserTimezone:denied,resolveReminderWhen:()=>new Date('2027-01-01'),
  createRoutine:crud.createRoutine,acceptRoutineOffers:async()=>{},routineDaysLabel:()=> 'segunda',intervalLabel:()=>'',listRoutinesForUser:async u=>(await pg.query('SELECT * FROM mtr_harness.routines WHERE user_id=$1',[u])).rows,
  resolveRoutine:(rows,{id})=>({row:rows.find(r=>r.id===id)}),routineCadence:()=> 'segunda às8h',routineCode:r=>r.id,entregaLabel:ch=>ch,updateRoutine:crud.updateRoutine,...extra};
 new Function(...Object.keys(deps),server.slice(start,end))(...Object.values(deps));return raw;
}
const created=[];
for(const user of [1,2]){
 const tool=routineTool('criar_rotina',user),tid='confirm-'+user;
 const before=(await pg.query('SELECT count(*)::int n FROM mtr_harness.routines')).rows[0].n;
 const args={titulo:'Energia',o_que_fazer:prompt,hora:8,dias_da_semana:['seg'],canal:user===1?'email':'whatsapp',tipo:'curadoria',curadoria:structuredClone(cfg)};
 const gated=gateTool(tool,tid);
 const proposal=await gated.run(args);ok(hasPending(tid));ok(proposal.includes('Energia solar'));ok(proposal.includes('0–3'));eq((await pg.query('SELECT count(*)::int n FROM mtr_harness.routines')).rows[0].n,before);
 ok(isConfirmation('pode'));const pending=takePending(tid);await pending.run(pending.args);
 const row=(await pg.query('SELECT * FROM mtr_harness.routines WHERE user_id=$1',[uuid(user)])).rows[0];created.push(row);ok(row.config?.curation);eq(row.config.curation.sections[0].max,3);eq(row.channel,args.canal);eq(row.days,'[1]');
}
// Missing contract refuses BEFORE asking confirmation, with no writes.
const invalidGate=gateTool(routineTool('criar_rotina',1),'missing');ok((await invalidGate.run({titulo:'Articles',o_que_fazer:prompt,tipo:'curadoria'})).includes('NÃO registrei'));eq(hasPending('missing'),false);
// Existing normal routine is converted by confirmed conversational editing, no replacement ID.
const legacy=await crud.createRoutine({userId:uuid(1),agentId:uuid(11),title:'Existing',prompt:'Busque conteúdo na web',hour:9,channel:'telegram'});
const legacyBefore=(await pg.query('SELECT * FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0];
const editTool=routineTool('editar_rotina',1),editArgs={id:legacy.id,o_que_fazer:prompt,curadoria:cfg};
const editGate=gateTool(editTool,'edit');await editGate.run(editArgs);eq((await pg.query('SELECT config FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0].config,{});
const editPending=takePending('edit');await editPending.run(editPending.args);const edited=(await pg.query('SELECT * FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0];eq(edited.id,legacy.id);eq(edited.hour,legacyBefore.hour);eq(edited.channel,'telegram');eq(edited.config.curation.source,'web');
// Change criteria/content together; stale approval rolls back instead of overwriting.
await crud.updateRoutine(legacy.id,uuid(1),{prompt:prompt+' Somente dois.',curation:{...cfg,sections:[{...cfg.sections[0],max:2}]},expected:{config:edited.config,prompt:edited.prompt,channel:edited.channel}});
await reject(()=>crud.updateRoutine(legacy.id,uuid(1),{prompt:'Stale',curation:cfg,expected:{config:edited.config,prompt:edited.prompt,channel:edited.channel}}));
await reject(()=>crud.updateRoutine(legacy.id,uuid(2),{title:'Cross tenant'}));
await crud.updateRoutine(legacy.id,uuid(1),{enabled:false});eq((await pg.query('SELECT enabled FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0].enabled,false);
await crud.updateRoutine(legacy.id,uuid(1),{enabled:true,channel:'none'});eq((await pg.query('SELECT config FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0].config.curation.sections[0].max,2);
const pauseGate=gateTool(routineTool('editar_rotina',1),'pause');
const pauseReceipt=await pauseGate.run({id:legacy.id,ativa:false});ok(pauseReceipt.ok);eq(hasPending('pause'),false);eq((await pg.query('SELECT enabled FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0].enabled,false);
await crud.updateRoutine(legacy.id,uuid(1),{enabled:true});
// Confirmed edit + explicit test is one ordered workflow. Use the actual SQL
// update and its returned row, rather than rebuilding a routine from tool args.
let executions=0;const order=[];
const recordedUpdate=async(...args)=>{order.push('update');return crud.updateRoutine(...args);};
const changedConfig={...cfg,sections:[{...cfg.sections[0],max:1}]};
const combinedArgs={id:legacy.id,o_que_fazer:prompt+' Selecione um item.',curadoria:changedConfig,testar_agora:true};
let testedRow;
const combinedTool=routineTool('editar_rotina',1,{updateRoutine:recordedUpdate,routineTestOutcome,
 executeRoutineNow:async saved=>{executions++;order.push('test');testedRow=saved;const actual=(await pg.query('SELECT * FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0];eq(saved,actual);return {contentStatus:'complete',delivery:{status:'saved'}};}});
const combinedGate=gateTool(combinedTool,'combined-edit-test');
const combinedProposal=await combinedGate.run(combinedArgs);
ok(/testar agora|testar juntos/.test(combinedProposal));eq(executions,0);eq(order,[]);
eq((await pg.query('SELECT config FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0].config.curation.sections[0].max,2);
const combinedPending=takePending('combined-edit-test');ok(combinedPending);
const combinedResult=await combinedPending.run(combinedPending.args);
eq(order,['update','test']);eq(executions,1);eq(testedRow.config.curation.sections[0].max,1);eq(testedRow.curation,undefined);ok(combinedResult.ok);ok(combinedResult.saida.includes('versão atualizada'));ok(combinedResult.saida.includes('salvo no app'));
// Editing alone never starts a test, before or after its confirmation.
const noTestTool=routineTool('editar_rotina',1,{routineTestOutcome,executeRoutineNow:denied});
await gateTool(noTestTool,'edit-without-test').run({id:legacy.id,novo_titulo:'Nova curadoria'});
const noTest=takePending('edit-without-test');ok(noTest);ok((await noTest.run(noTest.args)).ok);eq(executions,1);
// A test timeout does not undo the confirmed edit or retry the delivery.
let failures=0;
const failingTool=routineTool('editar_rotina',1,{routineTestOutcome,executeRoutineNow:async()=>{failures++;throw Error('unknown delivery');}});
await gateTool(failingTool,'edit-test-fails').run({id:legacy.id,novo_titulo:'Edição preservada',testar_agora:true});
const failedPending=takePending('edit-test-fails');ok(failedPending);
const failedTest=await failedPending.run(failedPending.args);
eq(failures,1);eq(failedTest.ok,true);eq((await pg.query('SELECT title FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0].title,'Edição preservada');
ok(failedTest.saida.includes('A alteração foi salva'));ok(failedTest.saida.includes('não teve conclusão confirmada'));ok(!/aceitou o envio|teste concluído|entregue com sucesso/.test(failedTest.saida));
// Without a confirmed saved row, don't execute a reconstructed version.
const missingSaved=routineTool('editar_rotina',1,{routineTestOutcome,executeRoutineNow:denied,updateRoutine:async()=>({ok:true})});
const missingResult=await missingSaved.run({id:legacy.id,novo_titulo:'Não reconstruir',testar_agora:true});
ok(missingResult.saida.includes('nenhum teste foi iniciado'));
// A stale proposal fails the SQL snapshot check before starting any test.
const staleTool=routineTool('editar_rotina',1,{routineTestOutcome,executeRoutineNow:denied});
await gateTool(staleTool,'stale-edit-test').run({id:legacy.id,novo_titulo:'Proposta antiga',testar_agora:true});
const stalePending=takePending('stale-edit-test');ok(stalePending);
await crud.updateRoutine(legacy.id,uuid(1),{title:'Edição concorrente'});
await reject(()=>stalePending.run(stalePending.args));eq((await pg.query('SELECT title FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0].title,'Edição concorrente');
// Reproduce the 14/09 sequence: a separate run must not execute old settings
// while an edit for that same routine is still pending.
const runIndex=server.indexOf("    name: 'executar_rotina_agora',"),runStart=server.lastIndexOf('registry.add({',runIndex),runEnd=server.indexOf('\n  });',runIndex)+'\n  });'.length;
let runTool;
const runDeps={registry:{add:t=>{runTool=t;}},userId:uuid(1),thread:{title:'Main chat'},listRoutinesForUser:async()=> (await pg.query('SELECT * FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows,resolveRoutine:rows=>({row:rows[0]}),getRoutineOwned:async()=> (await pg.query('SELECT * FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0],confirmationSession:{pending:()=>[{state:'pending',name:'editar_rotina',args:{id:legacy.id}}]},pendingRoutineEdit,routineActionFailure,actionResult,executeRoutineNow:denied};
new Function(...Object.keys(runDeps),server.slice(runStart,runEnd))(...Object.values(runDeps));
const blockedRun=JSON.parse(await runTool.run({id:legacy.id}));eq(blockedRun.action_evidence.state,'routine_blocked');ok(/teste não (?:começou|foi iniciado)/i.test(blockedRun.text));ok(!/editar_rotina|testar_agora/.test(blockedRun.text));
// Renderer, real PostgreSQL history and real delivery orchestration, all transports mocked.
const checks=[{section:'news',status:'complete',detail:'Fonte consultada nesta execução'}];
const item={section:'news',url:'https://example.invalid/article/',title:'Solar',author:'Fonte',date:'2026-09-11',summary:['Resumo verificado'],why:''};
const checkLinks=async t=>({checados:t.split('\n').length,quebrados:[],indefinidos:[],naoChecados:[]});
let sends=0;
const runner=new Function('getAgentOwned','getOrCreateThreadByTitle','runConversationInThread','normalizeFlightMonitor','normalizeCurationConfig','randomUUID',extract(server,'runRoutine')+';return runRoutine')(
 async(a,u)=>({id:a,user_id:u}),async({userId,agentId})=>{const id=uuid(userId===uuid(1)?101:102);await pg.query('INSERT INTO mtr_harness.threads VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,userId,agentId]);return {id};},
 async(a,t,u,p,opts)=>{const report=await finalizeCuration({text:JSON.stringify({items:[item],checks}),config:opts.curationConfig,userId:u,routineId:opts.routineId,history:await store.history({userId:u,routineId:opts.routineId}),now:'2026-09-11T15:00:00Z'},{checkLinks});await pg.query("INSERT INTO mtr_harness.messages(thread_id,role,content) VALUES($1,'assistant',$2)",[t.id,report.text]);return {text:report.text,curation:{urls:report.urls}};},denied,normalizeCurationConfig,randomUUID);
const channels=[];
const {deliverRoutine:delivery}=createScheduledDelivery({curationStore:store,deliverCurationEdition,sendCurationChannel,
 sendEmail:async()=>{sends++;channels.push('email');return {ok:true,id:'email-'+sends};},
 getTelegramBotForDelivery:async()=>({token:'synthetic',chat_id:'1'}),
 sendTelegramMessage:async()=>{sends++;channels.push('telegram');return {message_id:sends};},
 waEnabled:()=>true,getWhatsAppLinkForUser:async()=>({wa_phone:'synthetic'}),
 sendWhatsAppProactive:async(phone,text,options)=>{sends++;channels.push('whatsapp');eq(options.templateText,text.split('\n\n').slice(1).join('\n\n').replace(/\s+/g,' ').trim());eq(options.retryUnknown,false);ok(!/[\r\n]/.test(options.templateText));ok(text.includes('\n'));return {wamid:'chat-'+sends};},
 whatsappProse:denied,persistProactiveToThread:async()=>{}});
for(const row of created){const e=await runner(row);await pg.query("UPDATE mtr_harness.routines SET config=jsonb_set(config,'{execution}','{\"status\":\"running\",\"phase\":\"delivering\"}') WHERE id=$1",[row.id]);await delivery({...row,email:'synthetic@example.invalid'},e);eq((await store.history({userId:row.user_id,routineId:row.id})).length,1);const repeated=await runner(row);eq(repeated.urls,[]);}
eq(channels.includes('email'),true);eq(channels.includes('whatsapp'),true);
const forApp=(await pg.query('SELECT * FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0];const appE=await runner(forApp),beforeApp=sends;await delivery(forApp,appE);eq(sends,beforeApp);eq((await store.history({userId:forApp.user_id,routineId:forApp.id})).length,1);
await reject(()=>store.appReceipt({...forApp,user_id:uuid(2)},appE));
// Private Gmail IDs retain identity; confirm owned source and received timestamp without probing Gmail URL.
const privateUrl=id=>'https://mail.google.com/mail/u/0/#all/'+id;
ok(curationArticleKey(privateUrl('abcdef12345678'))!==curationArticleKey(privateUrl('abcdef12345679')));
const gmailCfg={...cfg,source:'gmail',version:2,sections:[{...cfg.sections[0],maxAgeDays:1}]};
const gmailItem={...item,url:privateUrl('abcdef12345678'),sourceId:'abcdef12345678',date:'2026-09-11'};
const gmailArgs={text:JSON.stringify({items:[gmailItem],checks}),config:gmailCfg,userId:uuid(2),routineId:created[1].id,history:[],now:'2026-09-11T08:00:00Z'};
let gmailReads=0;
let report=await finalizeCuration(gmailArgs,{checkLinks:denied,checkMail:async()=>{gmailReads++;return {body:'Newsletter body',receivedAt:'2026-09-10T20:00:00Z'};}});eq(report.urls,[gmailItem.url]);eq(gmailReads,1);ok(report.text.includes('Recebido em: 2026-09-10'));
report=await finalizeCuration(gmailArgs,{checkLinks:denied,checkMail:async()=>({body:'Newsletter',receivedAt:'2026-09-09T20:00:00Z'})});eq(report.urls,[]);
report=await finalizeCuration(gmailArgs,{checkLinks:denied,checkMail:async()=>{throw Error('Other account / permission denied');}});eq(report.urls,[]);eq(report.coverageSatisfied,false);
report=await finalizeCuration({...gmailArgs,text:JSON.stringify({items:[{...gmailItem,url:'https://example.invalid/not-in-mail'}],checks})},{checkLinks:denied,checkMail:async()=>({body:'Newsletter',receivedAt:'2026-09-11'})});eq(report.urls,[]);
// Source reader uses the actual same user's connector and cache, never a public Gmail probe.
const a=server.indexOf('function curationMailReader('),b=server.indexOf('\n}\n',a)+2;let tokenFor;
const reader=new Function('validGoogleToken','googleTools',server.slice(a,b)+';return curationMailReader')(
 async(u,email)=>{tokenFor={u,email};return 'synthetic-token';},({token,caps})=>{eq(token,'synthetic-token');eq(caps.gmail.read,true);return [{name:'gmail_read',run:async()=>JSON.stringify({body:'newsletter',receivedAt:'2026-09-11'})}];})(uuid(2),'account@example.invalid');
await reader('abcdef12345678');await reader('abcdef12345678');eq(tokenFor.u,uuid(2));
eq(curationPackets('whatsapp','## título https://example.invalid/my_article#part *fim*')[0],'título https://example.invalid/my_article#part fim');
ok(curationPackets('whatsapp',privateUrl('abcdef12345678'))[0].includes('#all/'));
// Chunking has no dropped content, no hidden channel switch; unknown send blocks subsequent execution.
for(const channel of ['whatsapp','telegram']){const text='Notícia com fonte https://example.invalid/a. '.repeat(150),packets=curationPackets(channel,text);ok(packets.length>1);for(const p of packets)ok(p.length<(channel==='whatsapp'?800:3500));}
let calls=0;await reject(()=>sendCurationChannel({channel:'whatsapp'},{text:'texto '.repeat(200)},{whatsapp:async()=>{calls++;return calls===1?{ok:true,id:'part1'}:null;}}));eq(calls,2);
const reserved={type:'curation-v1',channel:'telegram',editionId:randomUUID(),userId:created[0].user_id,routineId:created[0].id,urls:['https://example.invalid/next'],text:'next',configSnapshot:{stale:true}};
await reject(()=>deliverCurationEdition(reserved,{store,send:denied}));
const valid={...reserved,configSnapshot:created[0].config};await reject(()=>deliverCurationEdition(valid,{store,send:async()=>{throw Error('timeout');}}));await reject(()=>store.history({userId:valid.userId,routineId:valid.routineId}));
// Cancel preserves other users and cascades only this routine's ledger.
await crud.deleteRoutine(legacy.id,uuid(2));eq((await pg.query('SELECT count(*)::int n FROM mtr_harness.routines WHERE id=$1',[legacy.id])).rows[0].n,1);
await crud.deleteRoutine(legacy.id,uuid(1));eq((await pg.query('SELECT count(*)::int n FROM mtr_harness.curation_deliveries WHERE routine_id=$1',[legacy.id])).rows[0].n,0);
eq((await pg.query('SELECT count(*)::int n FROM mtr_harness.routines')).rows[0].n,2);
await pg.close();console.log(`OK: ${n} verificações UX curadoria: gate/criação/edição/concorrência/multiusuário/Gmail/entrega/app/cancelamento; sem I/O real.`);
