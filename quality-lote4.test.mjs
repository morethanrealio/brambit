import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';
import {confirmationFixture} from './test-support/confirmation-fixture.mjs';
import {createInboundDecisionResponder,createRespondDecisionTool} from './web/inbound-decision.mjs';
import {configurationConfirmation} from './web/discovery-conversation.mjs';
import {actionResult,routineActionFailure,createActionJournal} from './web/action-evidence.mjs';
import {measuredActionState} from './web/task-metrics.mjs';
import {pendingRoutineEdit} from './web/routine-edit-test.mjs';

async function fixture(t){
 const f=await confirmationFixture();t.after(()=>f.db.close());
 await f.db.exec(`ALTER TABLE mtr_harness.users ADD COLUMN name text, ADD COLUMN email text;
 CREATE TABLE mtr_harness.agent_convos(id uuid PRIMARY KEY,from_user uuid,to_user uuid,to_agent uuid,origin_channel text,objetivo text,resultado text,status text,updated_at timestamptz);
 CREATE TABLE mtr_harness.agent_convo_msgs(id serial,convo_id uuid,sender_agent uuid,side text,intent text,payload text);`);
 const contact=randomUUID();await f.db.query('INSERT INTO mtr_harness.users(id,name,email) VALUES ($1,$2,$3)',[contact,'Contato','contact@example.invalid']);
 const add=async(text)=>{const id=randomUUID();await f.db.query("INSERT INTO mtr_harness.agent_convos VALUES ($1,$2,$3,$4,'app','Proposta',$5,'accepted',now())",[id,contact,f.scope.userId,f.scope.agentId,text]);return id;};
 const list=async user=>(await f.db.query("SELECT c.*,u.name from_name,u.email from_email FROM mtr_harness.agent_convos c JOIN mtr_harness.users u ON u.id=c.from_user WHERE c.to_user=$1 AND status='accepted'",[user])).rows;
 const notifications=[];const tool=()=>createRespondDecisionTool({fromUser:f.scope.userId,list,respond:createInboundDecisionResponder(f.pool),owner:async()=>({name:'Dono'}),notifyOwner:async(...args)=>notifications.push(args)});
 return {...f,add,list,tool,notifications};
}
test('two decisions from the same contact bind content and ID across reconstruction, not the latest remaining proposal',async t=>{
 const f=await fixture(t),a=await f.add('Terça às 15h'),b=await f.add('Quarta às 10h');
 await assert.rejects(f.tool().prepareConfirmation({de:'Contato',aceito:true}),/mais de uma/);
 await assert.rejects(f.tool().prepareConfirmation({id:randomUUID(),de:'Contato',aceito:true}),/não está mais/);
 const args={id:a,aceito:true};const prepared=await f.tool().prepareConfirmation(args);
 assert.match(prepared.labels['pt-BR'],/Terça às 15h/);assert(!prepared.labels['pt-BR'].includes(a));
 const restored=f.tool().restoreConfirmation(JSON.parse(JSON.stringify(args)),JSON.parse(JSON.stringify(prepared.descriptor)));
 const result=JSON.parse(await restored.run());assert.equal(result.ok,true);
 assert.deepEqual((await f.list(f.scope.userId)).map(r=>r.id),[b]);assert.equal(f.notifications.length,1);
 assert.equal(JSON.parse(await restored.run()).ok,false);assert.equal(f.notifications.length,1);
 assert.equal((await f.db.query('SELECT * FROM mtr_harness.agent_convo_msgs')).rows.length,1);
});
test('invalid or another owner ID never falls back to the only pending decision',async t=>{
 const f=await fixture(t),id=await f.add('Teste');const respond=createInboundDecisionResponder(f.pool);
 for(const input of [{id:randomUUID(),de:'Contato',accept:true},{id:'not-a-uuid',accept:true}])assert.equal((await respond(f.scope.userId,input)).error,'nao_encontrada');
 assert.equal((await respond(randomUUID(),{id,accept:true})).error,'nao_encontrada');
 assert.equal((await f.list(f.scope.userId)).length,1);
 assert.equal(JSON.parse(await f.tool().run({id,aceito:true})).ok,false);
});
test('changed decision is rejected, duplicate responders commit one response, failed writes roll back',async t=>{
 const f=await fixture(t),id=await f.add('Original'),args={id,aceito:false};const p=await f.tool().prepareConfirmation(args);
 await f.db.query('UPDATE mtr_harness.agent_convos SET resultado=$2 WHERE id=$1',[id,'Alterada']);
 assert.match(JSON.parse(await p.run()).error,/mudou/);assert.equal(f.notifications.length,0);
 const p2=await f.tool().prepareConfirmation({id,aceito:false});f.failNext(/UPDATE mtr_harness.agent_convos/);
 await assert.rejects(p2.run(),/synthetic/);assert.equal((await f.db.query('SELECT * FROM mtr_harness.agent_convo_msgs')).rows.length,0);
 const results=await Promise.all([p2.run(),p2.run()]);assert.equal(results.map(JSON.parse).filter(r=>r.ok).length,1);assert.equal(f.notifications.length,1);
});
test('Portuguese preposition is not a refusal; actual negatives and reported consent stay rejected',()=>{
 for(const input of ['pode começar no WhatsApp','vamos iniciar no app','quero começar no horário combinado','pode começar no Telegram'])assert.equal(configurationConfirmation(input),true,input);
 for(const input of ['não pode começar no WhatsApp','pode começar no WhatsApp, não agora','no quiero iniciar','quiero iniciar, pero no ahora','we can start, not now','we can start no WhatsApp','quiero iniciar no WhatsApp','podemos iniciar, no WhatsApp','pode começar, no','ele disse pode começar no app','sim','pode começar no app, espera'])assert.equal(configurationConfirmation(input),false,input);
});
const source=readFileSync('web/server.mjs','utf8'),ast=ts.createSourceFile('server.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
function routineTool(deps){let code;function visit(n){if(ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.text==='name'&&p.initializer?.text==='executar_rotina_agora'))code=n.getText(ast);else ts.forEachChild(n,visit);}visit(ast);assert(code);return new Function(...Object.keys(deps),'return ('+code+')')(...Object.values(deps));}
test('real routine tool retains concrete blockers/failures through the action journal without asserting completion or replaying',async()=>{
 const routine={id:'routine-fixture',title:'Teste',channel:'app'};
 for(const scenario of ['empty','ambiguous','missing','recursive','busy','partial','success']){
  let effects=0;const deps={actionResult,routineActionFailure,pendingRoutineEdit,confirmationSession:{pending:()=>[]},userId:'fixture',thread:{title:scenario==='recursive'?'⏰ Teste':'chat'},listRoutinesForUser:async()=>scenario==='empty'?[]:[routine],resolveRoutine:()=>scenario==='ambiguous'?{err:'Há duas rotinas; escolha pelo título.'}:{row:routine},getRoutineOwned:async()=>scenario==='missing'?null:routine,executeRoutineNow:async()=>{effects++;if(scenario==='busy')throw Object.assign(Error('busy'),{code:'ROUTINE_BUSY'});if(scenario==='partial')throw Error('Canal indisponível');return {delivery:{status:'saved'},contentStatus:'complete'};}};
  const journal=createActionJournal();journal.toolResult({name:'executar_rotina_agora',args:{}},await routineTool(deps).run({}));
  const text=journal.finish('Rotina executada com sucesso.');const state=measuredActionState(journal.entries,'completed');
  const expected={empty:/nenhuma rotina/,ambiguous:/duas rotinas/,missing:/Não achei/,recursive:/recursiva/,busy:/Não repita/,partial:/Canal indisponível/,success:/conteúdo completo/};assert.match(text,expected[scenario],scenario);
  assert.equal(effects,['busy','partial','success'].includes(scenario)?1:0);
  assert.equal(state,scenario==='success'?'completed':['busy','partial'].includes(scenario)?'uncertain':'failed');
  if(scenario==='partial'){assert.match(text,/ação parcial/);assert.match(text,/Não vou repetir/);}
  if(scenario!=='success')assert(!text.includes('com sucesso'));
 }
 // Arbitrary plain tool output must still not become trusted evidence.
 const j=createActionJournal();j.toolResult({name:'executar_rotina_agora',args:{}},'Tudo executado');assert.equal(j.entries[0].state,'unknown');
});
