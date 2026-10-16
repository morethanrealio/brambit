import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerHooks} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
const denied=()=>{throw Error('EXTERNAL IO FORBIDDEN');};
net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
registerHooks({resolve(specifier,context,next){
  if(specifier==='./compras.mjs'&&context.parentURL?.endsWith('/web/confirm.mjs'))return {url:'data:text/javascript,export const descreverCarrinho=()=>null;export const plataformaDoCarrinho=()=>null;',shortCircuit:true};
  return next(specifier,context);
}});
const {confirmationFixture}=await import('../test-support/confirmation-fixture.mjs');
const {createConfirmationSession,withConfirmationSession}=await import('../web/confirmation-session.mjs');
const {handleConfirmation}=await import('../web/confirmation-flow.mjs');
const {createConfirmationRecovery,migrateCodingConfirmation}=await import('../web/confirmation-recovery.mjs');
const {codingPolicySnapshot}=await import('../web/coding-jobs.mjs');
const {gateTool}=await import('../web/confirm.mjs');

test('encrypted proposals and channel references survive closing and reopening the database',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'confirmation-restart-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const first=await confirmationFixture({dataDir});
  const scope=first.scope;const row=await first.store.propose(scope,{name:'gmail_send',args:{to:'private@example.invalid'},label:'Synthetic',confirmationText:'Synthetic'});
  await first.store.bind(scope,[row.id],{channel:'whatsapp',messageId:'persisted-card'});await first.db.close();
  const second=await confirmationFixture({dataDir,scope});t.after(()=>second.db.close());
  const [restored]=await second.store.list(scope);assert.equal(restored.id,row.id);assert.equal(restored.args.to,'private@example.invalid');
  assert.deepEqual(restored.messageRefs,[{channel:'whatsapp',messageId:'persisted-card'}]);
  const claim=await second.store.claim(scope,row.id,row.fingerprint,'new-input');assert.ok(claim);
  await second.store.finish(scope,claim,{text:'Synthetic receipt'});
  assert.equal(await second.store.claim(scope,row.id,row.fingerprint,'duplicate-input'),null);
});

test('coding recovery reconciles committed control receipts and retries enqueue with the same identity',async t=>{
  const f=await confirmationFixture();t.after(()=>f.db.close());
  const policy=codingPolicySnapshot({});
  const proposal={name:'gerenciar_tarefa_de_app',args:{app:'synthetic',acao:'atualizar_escopo'},label:'Synthetic app',
    confirmationText:'Synthetic app',binding:{version:1,scope:'synthetic-app-scope',operationId:'synthetic-op'},context:{policy},source:{channel:'telegram'}};
  const row=await f.store.propose(f.scope,proposal);await f.store.present(f.scope,[row.id]);
  const claim=await f.store.claim(f.scope,row.id,row.fingerprint);
  await f.db.query("UPDATE mtr_harness.confirmation_requests SET lease_until=now()-interval '1 second' WHERE id=$1",[row.id]);
  const rawResult={ok:true,continuation:{app:'synthetic',modo:'edicao',objetivo:'Synthetic change'}};
  const calls=[];let fail=true;
  const recovery=createConfirmationRecovery({store:f.store,appTaskStore:{read:async key=>{assert.equal(key,'synthetic-app-scope');return {status:'paused',mode:'edicao',objective:'Synthetic change',controlReceipts:{'synthetic-op':rawResult}};}},
    getAgentOwned:async()=>({}),jobs:{submit:async(scope,data,key)=>{calls.push({scope,data,key});if(fail)throw Error('Queue unavailable');return {ok:true,programming_job:{id:'synthetic-job'}};}}});
  await recovery.recover();assert.equal((await f.store.list(f.scope))[0].state,'completed');assert.equal(calls.length,1);
  fail=false;await recovery.recover();await recovery.recover();assert.equal(calls.length,2);
  assert.equal(calls[0].key,calls[1].key);assert.equal(calls[0].key,'confirmation:'+row.id);
  assert.equal((await f.store.recoverableCoding()).length,0);
  await recovery.continueCoding(f.scope,(await f.store.list(f.scope))[0]);assert.equal(calls.length,2);
  assert.equal(await f.store.finish(f.scope,claim,{text:'stale worker'}),false);
});

test('recovery never executes an interrupted control without a receipt or queues under changed permissions',async t=>{
  const f=await confirmationFixture();t.after(()=>f.db.close());
  const row=await f.store.propose(f.scope,{name:'gerenciar_tarefa_de_app',args:{},binding:{version:1,scope:'synthetic',operationId:'op'},context:{policy:codingPolicySnapshot({})}});
  await f.store.present(f.scope,[row.id]);const claim=await f.store.claim(f.scope,row.id,row.fingerprint);
  await f.store.finish(f.scope,claim,{rawResult:{ok:true,continuation:{objetivo:'Synthetic'}}});
  let queued=0;
  const recovery=createConfirmationRecovery({store:f.store,appTaskStore:{read:denied},getAgentOwned:async()=>({perm_mode:'plano'}),jobs:{submit:async()=>{queued++;}}});
  await recovery.recover();assert.equal(queued,0);
});

test('legacy pending app approval migrates once, keeps expiry, and requires a freshly presented card',async t=>{
  const f=await confirmationFixture();t.after(()=>f.db.close());const context={policy:codingPolicySnapshot({})};
  const old={id:'legacy-fixture',state:'pending',name:'gerenciar_tarefa_de_app',language:'pt-BR',args:{app:'synthetic',acao:'cancelar'},
    binding:{version:1,scope:'synthetic',operationId:'op'},context,expiresAt:Date.now()+30_000};
  const legacy={peek:async()=>old,cancel:async()=>{}};let executed=0;
  const adapter={confirmationTool:{name:old.name,run:denied,restoreConfirmation:()=>({run:async()=>{executed++;return {ok:true};}})}};
  const s=await createConfirmationSession(f.store,f.scope,context);
  await withConfirmationSession(s,async()=>{
    const a=await migrateCodingConfirmation(s,legacy,async()=>adapter);
    const b=await migrateCodingConfirmation(s,legacy,async()=>adapter);
    assert.equal(a.id,b.id);assert.equal(a.presented,false);assert.equal(a.expiresAt,old.expiresAt);
    const result=await handleConfirmation(s,{message:'confirmo pedido 1',resolveTool:async()=>adapter});assert.match(result.text,/Confira primeiro/);assert.equal(executed,0);
    await f.store.present(f.scope,[a.id]);await s.refresh();
    await handleConfirmation(s,{message:'confirmo pedido 1',resolveTool:async()=>adapter});assert.equal(executed,1);
    assert.equal(await migrateCodingConfirmation(s,legacy,async()=>adapter),null);
    assert.equal((await f.store.list(f.scope)).length,1);
  });
});

test('a failed continuation enqueue cannot turn a completed action into an uncertain retry',async t=>{
  const f=await confirmationFixture();t.after(()=>f.db.close());const s=await createConfirmationSession(f.store,f.scope);let effects=0;
  const tool={name:'gerenciar_tarefa_de_app',run:async()=>{effects++;return {ok:true,continuation:{app:'synthetic'}};}};
  await withConfirmationSession(s,async()=>{
    await gateTool(tool,f.scope.threadId).run({app:'synthetic',acao:'cancelar'});const row=s.pending()[0];await f.store.present(f.scope,[row.id]);await s.refresh();
    const options={message:'confirmo pedido 1',resolveTool:async()=>({confirmationTool:tool}),afterComplete:async()=>{throw Error('Synthetic enqueue failure');}};
    const first=await handleConfirmation(s,options);const second=await handleConfirmation(s,options);
    assert.equal(first.text,second.text);assert.equal(effects,1);assert.equal((await f.store.list(f.scope))[0].state,'completed');
  });
});

test('canceling during continuation enqueue remains authoritative when the delayed job reaches the real runtime',async t=>{
  const f=await confirmationFixture();t.after(()=>f.db.close());
  const {createProgrammingRuntime}=await import('../web/coding-runtime.mjs');
  const policy=codingPolicySnapshot({}),continuation={app:'synthetic',modo:'edicao',objetivo:'Approved scope'};
  const row=await f.store.propose(f.scope,{name:'gerenciar_tarefa_de_app',args:{},binding:{scope:'synthetic-task'},context:{policy}});
  await f.store.present(f.scope,[row.id]);const claim=await f.store.claim(f.scope,row.id,row.fingerprint);
  await f.store.finish(f.scope,claim,{rawResult:{ok:true,continuation}});
  let entered,release,queued;
  const started=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);
  const recovery=createConfirmationRecovery({store:f.store,getAgentOwned:async()=>({}),
    appTaskStore:{read:async()=>({status:'paused',mode:'edicao',objective:'Approved scope'})},
    jobs:{submit:async(scope,input)=>{entered();await waiting;queued={...scope,...input};return {ok:true,programming_job:{id:'late-job'}};}}});
  const enqueue=recovery.continueCoding(f.scope,(await f.store.list(f.scope))[0]);await started;
  await f.store.cancelContinuations(f.scope);release();await enqueue;
  assert.equal(await f.store.isContinuationAllowed(f.scope,row.id),false);assert.equal(queued.confirmationId,row.id);
  const runtime=createProgrammingRuntime({confirmationStore:f.store,getAgentOwned:async()=>({}),
    getThreadOwned:async()=>({agent_id:f.scope.agentId}),getUserLocale:denied});
  const result=await runtime.execute(queued,{});assert.equal(result.ok,false);assert.match(result.text,/cancelada/);
  await recovery.recover();assert.equal((await f.store.recoverableCoding()).length,0);
});
