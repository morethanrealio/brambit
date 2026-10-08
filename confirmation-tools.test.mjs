// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import net from 'node:net';
import tls from 'node:tls';
const denied=()=>{throw Error('EXTERNAL IO FORBIDDEN');};
net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
registerHooks({resolve(specifier,context,next){
  if(specifier==='./compras.mjs'&&context.parentURL?.endsWith('/web/confirm.mjs'))return {url:'data:text/javascript,export const descreverCarrinho=()=>null;export const plataformaDoCarrinho=()=>null;',shortCircuit:true};
  return next(specifier,context);
}});
const {confirmationFixture}=await import('./test-support/confirmation-fixture.mjs');
const {createConfirmationSession,withConfirmationSession}=await import('./web/confirmation-session.mjs');
const {handleConfirmation,proposalCard,proposalList}=await import('./web/confirmation-flow.mjs');
const {confirmationFingerprint}=await import('./web/confirmation-store.mjs');
const {routineConfirmationSnapshot}=await import('./web/confirmation-bindings.mjs');
const {gateTool}=await import('./web/confirm.mjs');
const {asaasTools}=await import('./web/connectors-vault.mjs');
const {conversationTools}=await import('./web/discovery-conversation.mjs');
const {createDiscoveryStore}=await import('./web/discovery-store.mjs');
const {isPauseOnlyRoutineChange,normalizeRoutineDays}=await import('./web/scheduler.mjs');
const {parseRoutineTime,routineTimeLabel}=await import('./web/routine-time.mjs');
const source=readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');
const ast=ts.createSourceFile('server.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function realTool(name,deps) {
  let text;
  function visit(node){
    if(ts.isObjectLiteralExpression(node)&&node.properties.some(p=>p.name?.text==='name'&&p.initializer?.text===name))text=node.getText(ast);
    else ts.forEachChild(node,visit);
  }
  visit(ast);assert.ok(text,'production tool exists');
  return new Function(...Object.keys(deps),'return ('+text+');')(...Object.values(deps));
}
async function fixture(t) {
  const f=await confirmationFixture();t.after(()=>f.db.close());
  return {...f,async propose(tool,args){
    const s=await createConfirmationSession(f.store,f.scope);
    await withConfirmationSession(s,()=>gateTool(tool,f.scope.threadId).run(args));
    const row=s.pending().at(-1);assert.ok(row,'proposal persisted');await f.store.present(f.scope,[row.id]);return row;
  },async approve(tool,number=1){
    const s=await createConfirmationSession(f.store,f.scope);
    return withConfirmationSession(s,()=>handleConfirmation(s,{message:`confirmo pedido ${number}`,resolveTool:async()=>({confirmationTool:tool})}));
  }};
}

test('real financial preparation rejects an account switch even when labels and PIX targets look identical',async t=>{
  const f=await fixture(t);let secret='synthetic-account-A';const calls=[];
  globalThis.fetch=async(_url,opts={})=>{calls.push(opts.method || 'GET');return {status:200,ok:true,text:async()=>JSON.stringify({data:[{id:'synthetic-key',key:'synthetic-pix',status:'ACTIVE'}]})};};
  t.after(()=>{globalThis.fetch=denied;});
  const tool=()=>asaasTools({secret:async()=>secret}).find(t=>t.name==='asaas_receber_pix');
  const proposal=await f.propose(tool(),{valor:10});assert.ok(proposal.binding.account.credentialHash);
  assert.ok(!JSON.stringify(proposal).includes(secret));secret='synthetic-account-B';
  assert.match((await f.approve(tool())).text,/revalidar/);assert.ok(calls.every(method=>method==='GET'));
});

test('real routine editor binds exact ID and configuration, tolerates scheduler heartbeats, rejects changed recurrence',async t=>{
  const f=await fixture(t);const effects=[];
  let rows=[{id:'routine-A',title:'Reuniões',hour:8,days:'daily',tz:'America/Sao_Paulo',channel:'app',prompt:'Consultar agenda',enabled:true,config:{execution:{status:'idle'}}}];
  const deps={userId:f.scope.userId,curationToolHelp:'',emailSearchToolHelp:'',curationToolSchema:{},emailSearchToolSchema:{},
    isPauseOnlyRoutineChange,routineConfirmationSnapshot,confirmationFingerprint,normalizeRoutineDays,parseRoutineTime,routineTimeLabel,
    listRoutinesForUser:async()=>structuredClone(rows),checarArgsRotina:()=>null,prepareRoutineChange:()=>null,
    routineCadence:r=>r.days+' '+r.hour,entregaLabel:x=>x,
    resolveRoutine:(rs,{id,titulo})=>{const found=rs.filter(r=>id?r.id===id:r.title.includes(titulo));return found.length===1?{row:found[0]}:{err:'Ambiguous routine'};},
    updateRoutine:async(id,_user,fields)=>{assert.deepEqual(fields.expected,routineConfirmationSnapshot(rows.find(r=>r.id===id)));effects.push({id,fields});},
  };
  const tool=()=>realTool('editar_rotina',deps);
  const row=await f.propose(tool(),{titulo:'Reuniões',hora:9});assert.equal(row.args.id,'routine-A');
  assert.ok(!('execution' in row.args.expected.config));
  rows[0].config.execution={status:'running',attempt:2};rows.push({...rows[0],id:'routine-B'});
  await f.approve(tool());assert.equal(effects.length,1);assert.equal(effects[0].id,'routine-A');
  await f.propose(tool(),{id:'routine-A',hora:10});rows[0].days='weekends';
  assert.match((await f.approve(tool(),2)).text,/revalidar/);assert.equal(effects.length,1);
});

test('real Drive upload resolves latest file at proposal time and refuses another version',async t=>{
  const f=await fixture(t);let latest={id:1,s3_key:'synthetic-original',caption:'Relatório'};
  const files=new Map([[1,latest]]);
  const tool=()=>realTool('enviar_para_drive',{userId:f.scope.userId,agent:{name:'Synthetic'},
    getMediaAsset:async(_u,id)=>files.get(id),listMediaAssets:async()=>[latest],fetchMedia:denied});
  const row=await f.propose(tool(),{});assert.equal(row.args.id,1);assert.equal(row.args.assetKey,'synthetic-original');
  latest={id:2,s3_key:'synthetic-new',caption:'Outro'};files.set(2,latest);
  assert.equal(await tool().preflight(row.args),undefined,'new unrelated asset cannot replace approved file');
  files.set(1,{...files.get(1),s3_key:'synthetic-replaced'});
  assert.match((await f.approve(tool())).text,/revalidar/);
});

test('checkout restores the encrypted session after cache loss and rechecks price before any mutation',async t=>{
  const f=await fixture(t);const carts=new Map();const calls=[];
  const cart={criadoEm:Date.now(),...{userId:f.scope.userId,agentId:f.scope.agentId,threadId:f.scope.threadId},
    plataforma:'vtex',origin:'https://synthetic.invalid',moeda:'BRL',orderFormId:'synthetic-form',jar:new Map([['session','private-synthetic-cookie']]),
    produto:{nome:'Synthetic product',qtd:1},valor:1000,frete:{preco:0},pix:{id:125}};
  carts.set(`${f.scope.userId}:cart`,cart);
  const src=readFileSync(new URL('./web/compras.mjs',import.meta.url),'utf8');
  const factory=src.slice(src.indexOf('export function comprasTools('),src.indexOf('// Short block for the end of the prompt:')).replace('export function','function');
  const ctx=vm.createContext({Map,Date,JSON,URL,console:{log(){}},CARTS:carts,CART_TTL_MS:40*60_000,
    getCarrinho:(u,id)=>carts.get(`${u}:${id}`),brl:n=>String(n/100),carrinhoVivoDoThread:()=>null,
    req:async(url,opts={})=>{calls.push({url,method:opts.method || 'GET',cookies:[...opts.jar]});return {status:200,json:{value:1200}};}});
  const factoryFn=vm.runInContext(factory+'\ncomprasTools;',ctx);
  const tool=()=>factoryFn(f.scope.userId,f.scope.agentId,{threadId:f.scope.threadId}).find(t=>t.name==='fechar_pedido');
  const row=await f.propose(tool(),{carrinho_id:'cart'});assert.equal(row.binding.cart.jar[0][1],'private-synthetic-cookie');
  assert.ok(!JSON.stringify((await f.db.query('SELECT payload FROM mtr_harness.confirmation_requests')).rows).includes('private-synthetic-cookie'));
  carts.clear();const result=await f.approve(tool());assert.match(result.text,/total mudou/);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(calls[0].cookies[0][1],'private-synthetic-cookie');
  await f.approve(tool());assert.equal(calls.length,1,'a duplicate confirmation cannot try checkout again');
  assert.throws(()=>factoryFn('another-user',f.scope.agentId,{threadId:f.scope.threadId}).find(t=>t.name==='fechar_pedido').restoreConfirmation(row.args,row.binding),/indisponível/);
});

test('a reconstructed discovery proposal keeps its original journey generation',async t=>{
  const f=await fixture(t);let version=1,effects=0;
  const store={get:async()=>({status:'invited',version}),available:async()=>true,control:async()=>{effects++;}};
  const tool=()=>conversationTools(store,{user:f.scope.userId,agent:f.scope.agentId,
    message:'Quero iniciar a jornada de descoberta',validateChannel:async()=>{}}).gated.find(t=>t.name==='jornada_configurar');
  const row=await f.propose(tool(),{action:'accept',channel:'app',lunch:'12:30',evening:'20:30',timezone:'America/Sao_Paulo',frequency:'twice',duration:7});
  assert.equal(row.binding.version,1);version=2;
  assert.match((await f.approve(tool())).text,/revalidar/);assert.equal(effects,0);
});

test('early journey completion survives reconstructed confirmation sessions and duplicate approval without duplicate reports',async t=>{
  const f=await fixture(t);
  const journey=createDiscoveryStore(f.pool,()=>true);await journey.init();
  await f.db.exec('UPDATE mtr_harness.discovery_settings SET enabled=true');
  await f.db.query("INSERT INTO mtr_harness.discovery_participants(user_id,agent_id,status,started_at,ends_at) VALUES($1,$2,'active',now()-interval '2 days',now()+interval '5 days')",[f.scope.userId,f.scope.agentId]);
  const tool=()=>conversationTools(createDiscoveryStore(f.pool,()=>true),{user:f.scope.userId,agent:f.scope.agentId,
    message:'Quero concluir minha jornada agora e preparar minha devolutiva',thread:f.scope.threadId,channel:'telegram',validateChannel:async()=>{}}).gated.find(t=>t.name==='jornada_concluir');
  const row=await f.propose(tool(),{});
  assert.equal(row.binding.action,'complete');assert.equal(row.binding.auto_send,true);
  assert.doesNotMatch(proposalCard(row), /Pedido 1|confirmo pedido/);
  assert.equal((proposalCard(row).match(/Posso seguir\?/g)||[]).length,1);
  assert.doesNotMatch(proposalList([row]).text, /Pedido 1|confirmo pedido/);
  assert.equal((await journey.get(f.scope.userId)).status,'active');
  const reactionSession=await createConfirmationSession(f.store,f.scope);
  const reaction=await withConfirmationSession(reactionSession,()=>handleConfirmation(reactionSession,{message:'confirmo pedido 1',viaReaction:true,resolveTool:async()=>({confirmationTool:tool()})}));
  assert.match(reaction.text,/exige confirmação por texto/);
  assert.equal((await journey.get(f.scope.userId)).status,'active');
  const naturalSession=await createConfirmationSession(f.store,f.scope);naturalSession.implicitTargetId=row.id;
  const result=await withConfirmationSession(naturalSession,()=>handleConfirmation(naturalSession,{message:'pode',resolveTool:async()=>({confirmationTool:tool()})}));assert.match(result.text,/Estou preparando/);
  const replay=await f.approve(tool());assert.equal(replay.text,result.text);
  assert.equal((await journey.get(f.scope.userId)).status,'completed');
  const report=await journey.closing.owned(f.scope.userId,f.scope.agentId);
  assert.equal(report.state,'pending');assert.equal(report.auto_send,true);
  assert.equal((await journey.closing.overview()).length,1);
});

test('failed journey retry survives reconstructed confirmation and duplicate replies without reopening the journey',async t=>{
  const f=await fixture(t),journey=createDiscoveryStore(f.pool,()=>true);await journey.init();
  await f.db.exec('UPDATE mtr_harness.discovery_settings SET enabled=true');
  await f.db.query("INSERT INTO mtr_harness.discovery_participants(user_id,agent_id,status,started_at,ends_at) VALUES($1,$2,'completed',now()-interval '7 days',now())",[f.scope.userId,f.scope.agentId]);
  await journey.maintenance();
  await f.db.query("UPDATE mtr_harness.discovery_reports SET state='failed',attempts=3,reason='invalid_report_evidence'");
  const before=await journey.get(f.scope.userId),beforeReport=await journey.closing.owned(f.scope.userId,f.scope.agentId);
  const tool=()=>conversationTools(createDiscoveryStore(f.pool,()=>true),{user:f.scope.userId,agent:f.scope.agentId,thread:f.scope.threadId,channel:'telegram',message:'Pode refazer minha devolutiva?',validateChannel:async()=>{}}).gated.find(t=>t.name==='jornada_refazer_devolutiva');
  await f.propose(tool(),{});
  const result=await f.approve(tool());assert.match(result.text,/preparando sua devolutiva novamente/);
  assert.equal((await f.approve(tool())).text,result.text);
  const after=await journey.closing.owned(f.scope.userId,f.scope.agentId);
  assert.equal(after.id,beforeReport.id);assert.equal(after.recovery_count,1);assert.equal(after.state,'pending');
  assert.equal(after.delivery_thread_id,f.scope.threadId);assert.deepEqual((await journey.get(f.scope.userId)).ends_at,before.ends_at);
});

test('a reconstructed early-completion proposal cannot undo a pause made after it was presented',async t=>{
  const f=await fixture(t);const journey=createDiscoveryStore(f.pool,()=>true);await journey.init();
  await f.db.exec('UPDATE mtr_harness.discovery_settings SET enabled=true');
  await f.db.query("INSERT INTO mtr_harness.discovery_participants(user_id,agent_id,status,started_at,ends_at) VALUES($1,$2,'active',now()-interval '2 days',now()+interval '5 days')",[f.scope.userId,f.scope.agentId]);
  const tool=()=>conversationTools(journey,{user:f.scope.userId,agent:f.scope.agentId,message:'Conclua minha jornada',thread:f.scope.threadId,channel:'telegram',validateChannel:async()=>{}}).gated.find(t=>t.name==='jornada_concluir');
  await f.propose(tool(),{});
  await journey.control(f.scope.userId,{action:'pause'});
  assert.match((await f.approve(tool())).text,/revalidar/);
  assert.equal((await journey.get(f.scope.userId)).status,'paused');
  assert.equal((await journey.closing.overview()).length,0);
});

test('OAuth reconnection changes approval identity, while normal refresh retains it; snapshots exclude secrets',async t=>{
  const f=await fixture(t);
  await f.db.exec(`CREATE TABLE mtr_harness.oauth_tokens(user_id uuid,provider text,access_token text,refresh_token text,scope text,expiry timestamptz,meta jsonb,updated_at timestamptz,PRIMARY KEY(user_id,provider));
    CREATE TABLE mtr_harness.connections(id uuid,provider text,user_id uuid,updated_at timestamptz);`);
  const src=readFileSync(new URL('./web/db.mjs',import.meta.url),'utf8');
  await f.db.query('INSERT INTO mtr_harness.oauth_tokens(user_id,provider,access_token) VALUES ($1,$2,$3)',[f.scope.userId,'microsoft','synthetic-legacy']);
  const migration=src.match(/ALTER TABLE \$\{S\}\.oauth_tokens ADD COLUMN IF NOT EXISTS confirmation_version[^;]+;/)?.[0];assert.ok(migration);
  await f.db.exec(migration.replace('${S}','mtr_harness'));
  const original=(await f.db.query('SELECT confirmation_version FROM mtr_harness.oauth_tokens')).rows[0].confirmation_version;
  await f.db.exec(migration.replace('${S}','mtr_harness'));
  assert.equal((await f.db.query('SELECT confirmation_version FROM mtr_harness.oauth_tokens')).rows[0].confirmation_version,original);
  function realDb(name){const start=src.indexOf('export async function '+name+'('),end=src.indexOf('\n}',start)+2;assert.ok(start>0&&end>start);
    return new Function('pool','S','encMaybe',src.slice(start,end).replace('export ','')+';return '+name)(f.pool,'mtr_harness',s=>s?'encrypted:'+s:null);}
  const save=realDb('saveOAuthToken'),context=realDb('getConfirmationAuthorizationContext');
  await save(f.scope.userId,'microsoft',{access_token:'private-synthetic-A',scope:'Mail.Send'});
  const a=await context(f.scope.userId);assert.equal(a.oauth.length,1);assert.ok(!JSON.stringify(a).includes('private-synthetic'));
  await save(f.scope.userId,'microsoft',{access_token:'private-synthetic-refresh',scope:'Mail.Send'},{refresh:true});
  assert.deepEqual(await context(f.scope.userId),a);
  await save(f.scope.userId,'microsoft',{access_token:'private-synthetic-B',scope:'Mail.Send'});
  assert.notEqual((await context(f.scope.userId)).oauth[0].version,a.oauth[0].version);
  assert.deepEqual((await context('00000000-0000-0000-0000-000000000099')).oauth,[]);
});

test('contact decision card pins the exact proposal across a durable confirmation session',async t=>{
  const {createRespondDecisionTool}=await import('./web/inbound-decision.mjs');
  const f=await fixture(t);let writes=0;
  const rows=[{id:'decision-A',from_user:'contact',from_name:'Contato',resultado:'Terça às 15h'},{id:'decision-B',from_user:'contact',from_name:'Contato',resultado:'Quarta às 10h'}];
  const tool=()=>createRespondDecisionTool({fromUser:f.scope.userId,list:async()=>rows,respond:async(_user,args)=>{assert.equal(args.id,'decision-A');assert.equal(args.expected.resultado,'Terça às 15h');writes++;return {ok:true,accepted:true,from_name:'Contato'};},owner:async()=>null});
  const p=await f.propose(tool(),{id:'decision-A',aceito:true});assert.equal(writes,0);assert.match(p.label,/Terça às 15h/);assert.equal(p.binding.snapshot.id,'decision-A');
  const result=await f.approve(tool());assert.match(result.text,/confirmação/);assert.equal(writes,1);
  await f.approve(tool());assert.equal(writes,1);
});
