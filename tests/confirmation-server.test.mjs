// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
const denied=()=>{throw Error('EXTERNAL IO FORBIDDEN');};
net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
registerHooks({resolve(specifier,context,next){
  if(specifier==='./compras.mjs'&&context.parentURL?.endsWith('/web/confirm.mjs'))return {url:'data:text/javascript,export const descreverCarrinho=()=>null;export const plataformaDoCarrinho=()=>null;',shortCircuit:true};
  return next(specifier,context);
}});
const {confirmationFixture}=await import('../test-support/confirmation-fixture.mjs');
const sessions=await import('../web/confirmation-session.mjs');
const flow=await import('../web/confirmation-flow.mjs');
const {withConfirmationReceipt}=await import('../web/channel-confirmation.mjs');
const {gateTool}=await import('../web/confirm.mjs');
const {codingPolicySnapshot,codingControlIntent}=await import('../web/coding-jobs.mjs');
const {migrateCodingConfirmation}=await import('../web/confirmation-recovery.mjs');
const {handleRoutinePause,routinePauseIntent}=await import('../web/routine-control.mjs');
const source=readFileSync(new URL('../web/server.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function runConversationInThread('),end=source.indexOf('// Cooldown for the no-credit emergency turn',start);
assert.ok(start>0&&end>start);

async function fixture(t) {
  const f=await confirmationFixture();t.after(()=>f.db.close());
  const state={agent:{id:f.scope.agentId},thread:{id:f.scope.threadId,agent_id:f.scope.agentId,history:[]},effects:[],modelTurns:0,cancelled:0,resumes:[]};
  const tool={name:'editar_rotina',run:async args=>{state.effects.push(args);return {ok:true};}};
  const deps={...sessions,...flow,withConfirmationReceipt,codingPolicySnapshot,codingControlIntent,jevEnabled:()=>false,jevCodingControl:async()=>null,migrateCodingConfirmation,
    handleRoutinePause,routinePauseIntent,getCreditStatus:async()=>({over:true}),listRoutinesForUser:denied,updateRoutine:denied,
    confirmationStore:f.store,confirmationRecovery:{continueCoding:async()=>{}},
    withThreadLock:async(_id,run)=>run(), getUserLocale:async()=>({language:'pt-BR'}), getThreadOwned:async()=>structuredClone(state.thread),getAgentOwned:async()=>state.agent,
    saveThreadTurn:async(_id,_agent,data)=>{state.thread.history=data.history;},
    createCodingApprovals:()=>({peek:async()=>null}),appTaskStore:{},
    codingJobs:{status:async()=>({programming_job:{id:'job'}}),cancel:async()=>{state.cancelled++;return {text:'Job canceled'};},
      resume:async(scope,options)=>{state.resumes.push({scope,options});return {text:'Retomada registrada.'};}},
    runConversationTurn:async(agent,thread,_user,message,opts)=>{
      if(opts.confirmationRestore){assert.equal(agent,state.agent,'restoration uses current permissions');return {confirmationTool:tool};}
      state.modelTurns++;
      let text='Resposta comum.';
      if(message.startsWith('propor:')) {
        for(const id of message.slice(7).split(',')) await gateTool(tool,thread.id).run({id,hora:9});
        const session=sessions.currentConfirmationSession(thread.id);
        text=session.pending().filter(r=>session.createdIds.has(r.id)).map(flow.proposalCard).join('\n\n');
      }
      state.thread.history.push({role:'user',content:message},{role:'assistant',content:text});
      return {text,attachments:[]};
    },
  };
  const run=new Function(...Object.keys(deps),source.slice(start,end)+'\nreturn runConversationInThread;')(...Object.values(deps));
  const turn=(text,opts={})=>run({id:f.scope.agentId,perm_mode:'stale'},state.thread,f.scope.userId,text,{kind:'chat',...opts});
  return {...f,state,turn};
}

test('explicit job resume uses current policy and source input ID without a model turn or bypassing pending approval',async t=>{
 const f=await fixture(t);
 const result=await f.turn('retomar programação',{confirmationInputId:'resume-message'});
 assert.equal(result.text,'Retomada registrada.');assert.equal(f.state.modelTurns,0);
 assert.deepEqual(f.state.resumes,[{scope:f.scope,options:{policy:codingPolicySnapshot(f.state.agent),requestId:'resume-message'}}]);
 await f.turn('propor:rotina-A');await f.turn('retomar programação');
 assert.equal(f.state.resumes.length,1);assert.equal(f.state.effects.length,0);
});

test('real server wrapper persists separate cards, resolves exact request without a model, and rejects stale cancellation targets',async t=>{
  const f=await fixture(t);
  const cards=await f.turn('propor:rotina-A,rotina-B');assert.equal(cards.confirmationCards.length,2);
  let rows=await f.store.list(f.scope);assert.ok(rows.every(r=>r.presented));
  await f.turn('pode');assert.equal(f.state.effects.length,0);assert.equal(f.state.modelTurns,1);
  await f.turn('cancela',{confirmationTarget:{channel:'telegram',messageId:'old'}});
  assert.equal(f.state.cancelled,0);assert.equal((await f.store.list(f.scope)).filter(r=>r.state==='pending').length,2);
  await f.turn('confirmo pedido 2');assert.deepEqual(f.state.effects,[{id:'rotina-B',hora:9}]);
  await f.turn('confirmo pedido 2');assert.equal(f.state.effects.length,1);
  await f.turn('cancela pedido 1');assert.equal((await f.store.list(f.scope)).filter(r=>r.state==='pending').length,0);
  assert.equal(f.state.cancelled,0);assert.equal(f.state.modelTurns,1);
});

// Bug 2026-10 (Nate/Jorge reports): WhatsApp and Telegram used to skip the eager
// present() here and rely entirely on a post-send callback, so any dropped/failed
// send left presented_at unset forever and the already-sent card could resurface
// later as if it had never been shown.
test('a WhatsApp or Telegram card is presented as soon as it is in the reply, not only after a later send callback',async t=>{
  const f=await fixture(t);
  const wa=await f.turn('propor:rotina-A',{kind:'whatsapp'});
  assert.equal(wa.confirmationCards.length,1);
  const tg=await f.turn('propor:rotina-B',{kind:'telegram'});
  assert.equal(tg.confirmationCards.length,1);
  const rows=await f.store.list(f.scope);
  assert.ok(rows.every(r=>r.presented),'WhatsApp/Telegram proposals must be presented the moment their card is sent');
});

test('real server wrapper accepts a natural approval of the presented set and replays the complete receipt',async t=>{
  const f=await fixture(t);await f.turn('propor:rotina-A,rotina-B');
  await f.turn('confirmo os dois',{confirmationInputId:'set-approval'});
  assert.deepEqual(f.state.effects,[{id:'rotina-A',hora:9},{id:'rotina-B',hora:9}]);
  const result=await f.turn('confirmo os dois',{confirmationInputId:'set-approval'});
  assert.equal(f.state.effects.length,2);assert.equal(result.replay,true);
  await f.turn('propor:rotina-C');await f.turn('pode',{confirmationInputId:'set-approval'});
  assert.equal(f.state.effects.length,2,'an old transport input cannot confirm the next proposed action');
});

test('plain consent is valid adjacent to each sole card; changing subject preserves but cannot silently approve it',async t=>{
  const f=await fixture(t);await f.turn('propor:rotina-A');await f.turn('Pergunta sobre outro assunto');
  await f.turn('sim');assert.equal(f.state.effects.length,0);
  await f.turn('confirmo pedido 1');assert.equal(f.state.effects.length,1);
  await f.turn('propor:rotina-B');await f.turn('sim');assert.equal(f.state.effects.length,2,'fresh consent to a freshly presented sole action works after the first request');
  await f.turn('confirmo pedido 2');assert.equal(f.state.effects.length,2);
});

test('the wrapper reloads current policy and invalidates a proposal after a permission change',async t=>{
  const f=await fixture(t);await f.turn('propor:rotina-A');f.state.agent={...f.state.agent,perm_mode:'plano'};
  const result=await f.turn('confirmo pedido 1');assert.match(result.text,/revalidar/);
  assert.equal(f.state.effects.length,0);assert.equal((await f.store.list(f.scope))[0].state,'invalidated');
});

test('a first sole card accepts adjacent plain consent, while an unrelated quoted question remains a normal turn',async t=>{
  const f=await fixture(t);await f.turn('propor:rotina-A');await f.turn('sim');assert.equal(f.state.effects.length,1);
  await f.turn('propor:rotina-B');
  const before=f.state.modelTurns;
  await f.turn('Como funciona isso?',{confirmationTarget:{channel:'whatsapp',messageId:'unrelated-message'}});
  assert.equal(f.state.modelTurns,before+1);assert.equal(f.state.effects.length,1);
  assert.equal((await f.store.list(f.scope)).find(r=>r.number===2).state,'pending');
});

test('a reaction to ordinary conversation with no proposal stays quiet and never starts a model turn',async t=>{
  const f=await fixture(t);const result=await f.turn('👍',{viaReaction:true,confirmationTarget:{channel:'telegram',messageId:'ordinary-message'}});
  assert.equal(result,null);assert.equal(f.state.modelTurns,0);assert.equal(f.state.effects.length,0);
});

test('a new supermarket request without a proposal reaches the ordinary server turn',async t=>{
  const f=await fixture(t);
  const message='Pode ir na sessao de supermercado';
  const result=await f.turn(message);
  assert.equal(f.state.modelTurns,1);
  assert.equal(result.text,'Resposta comum.');
  assert.equal(f.state.thread.history.at(-2).content,message);
  assert.deepEqual(await f.store.list(f.scope),[]);
  assert.deepEqual(f.state.effects,[]);
});

test('natural refusal closes the sole visible proposal before the server saves its receipt',async t=>{
  const f=await fixture(t);
  await f.turn('propor:rotina-A');
  const result=await f.turn('Não precisa fazer nada',{confirmationInputId:'natural-refusal'});
  const rows=await f.store.list(f.scope);
  assert.equal(rows[0].state,'canceled');
  assert.equal(rows[0].decisionKey,'natural-refusal');
  assert.match(result.text,/Cancelei/);
  assert.equal(f.state.thread.history.at(-1).content,result.text);
  assert.equal(f.state.modelTurns,1,'refusal must not delegate the state change to model prose');
  assert.equal(f.state.cancelled,0,'the refusal refers to the proposal, not a background job');
  assert.deepEqual(f.state.effects,[]);
});

test('frustration 25/09: "Ok, Pode seguir." and "isso" confirm the only card shown',async t=>{
  const f=await fixture(t);await f.turn('propor:rotina-A');await f.turn('Ok, Pode seguir.');
  assert.deepEqual(f.state.effects,[{id:'rotina-A',hora:9}]);
  await f.turn('propor:rotina-B');await f.turn('isso');assert.equal(f.state.effects.length,2);
  await f.turn('propor:rotina-C');await f.turn('isso não');assert.equal(f.state.effects.length,2);
});

test('frustration 25/09, English and Spanish: the "isso" of each language confirms the only card shown',async t=>{
  const f=await fixture(t);let n=0;
  for (const sim of ['exactly',"that's right",'Correct.','ok, exactly','eso','sí, eso','eso es','exacto','correcto']) {
    await f.turn(`propor:rotina-s${n}`);await f.turn(sim);n++;assert.equal(f.state.effects.length,n,sim);
  }
  for (const [i,nao] of ['not exactly','eso no','eso depende','exactly why I asked?'].entries()) {
    await f.turn(`propor:rotina-n${i}`);await f.turn(nao);assert.equal(f.state.effects.length,n,nao);
  }
});

test('frustration 25/09: with an old pending request, "pode seguir" confirms only the just-shown card',async t=>{
  const f=await fixture(t);await f.turn('propor:rotina-A');await f.turn('Pergunta sobre outro assunto');
  await f.turn('propor:rotina-B');
  const turns=f.state.modelTurns;
  await f.turn('Pode seguir');
  assert.deepEqual(f.state.effects,[{id:'rotina-B',hora:9}]);assert.equal(f.state.modelTurns,turns);
  const rows=await f.store.list(f.scope);
  assert.equal(rows.find(r=>r.number===1).state,'pending','the old request is neither approved nor erased');
});
