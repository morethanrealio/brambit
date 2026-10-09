// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
const denied=()=>{throw Error('EXTERNAL IO FORBIDDEN');};
net.Socket.prototype.connect=denied;tls.connect=denied;globalThis.fetch=denied;
registerHooks({resolve(specifier,context,next){
  if(specifier==='./compras.mjs'&&context.parentURL?.endsWith('/web/confirm.mjs'))return {url:'data:text/javascript,export const descreverCarrinho=()=>"synthetic";export const plataformaDoCarrinho=()=>"synthetic";',shortCircuit:true};
  return next(specifier,context);
}});
const {confirmationFixture}=await import('../test-support/confirmation-fixture.mjs');
const {createConfirmationSession,withConfirmationSession}=await import('../web/confirmation-session.mjs');
const {gateTool,listPending,hasPending}=await import('../web/confirm.mjs');
const {handleConfirmation,proposalCard,selectConfirmation}=await import('../web/confirmation-flow.mjs');
const {withConfirmationReceipt,createRoutineConfirmationHandoff}=await import('../web/channel-confirmation.mjs');

const context={policy:'synthetic-policy',googleEmail:'owner@example.invalid'};
async function fixture(t) {
  const f=await confirmationFixture();t.after(()=>f.db.close());
  const effects=[];
  let lastPresentation=[];
  const tool={name:'gmail_send',description:'synthetic',run:async args=>{effects.push(args);return {ok:true,id:'synthetic-receipt'};}};
  const session=()=>createConfirmationSession(f.store,f.scope,context);
  const propose=async(args,chosen=tool)=>{
    const s=await session();
    await withConfirmationSession(s,()=>gateTool(chosen,f.scope.threadId).run(args));
    const row=s.pending().at(-1);await f.store.present(f.scope,[row.id]);lastPresentation=[row.id];return row;
  };
  const decide=async(message,extra={})=>{
    const s=await session();s.implicitTargetIds=lastPresentation;s.implicitTargetId=lastPresentation.length===1?lastPresentation[0]:null;
    const result=await withConfirmationSession(s,()=>handleConfirmation(s,{message,resolveTool:async()=>({confirmationTool:tool}),...extra}));
    if(result)lastPresentation=result.proposalIds || [];return result;
  };
  return {...f,effects,tool,session,propose,decide};
}
const args=n=>({to:`recipient${n}@example.invalid`,subject:`Synthetic ${n}`,body:`Private synthetic body ${n}`});

test('several proposals survive a fresh session, remain scoped, and are encrypted at rest',async t=>{
  const f=await fixture(t);await f.propose(args(1));await f.propose(args(2));
  const rows=(await f.session()).pending();assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.number),[1,2]);
  assert.ok(rows.every(r=>r.selectionRequired));assert.equal(rows[0].args.body,args(1).body);
  const raw=JSON.stringify((await f.db.query('SELECT * FROM mtr_harness.confirmation_requests')).rows);
  assert.ok(!raw.includes(args(1).body));assert.ok(!raw.includes(args(1).to));
  await assert.rejects(f.store.list({...f.scope,userId:randomUUID()}),/unavailable/);
  assert.equal(f.effects.length,0);
});
// Frustration 2026-09-25: a simple yes goes to the one card just shown;
// the old request is neither approved nor deleted. Without a visible card, it stays ambiguous.
test('a bare yes confirms only the sole card just shown and leaves the older request pending',async t=>{
  const f=await fixture(t);await f.propose(args(1));await f.propose(args(2));
  await f.decide('sim');assert.deepEqual(f.effects,[args(2)]);
  assert.equal((await f.session()).pending().length,1);
});
test('numbered selection executes only that immutable proposal after restart and replays its receipt',async t=>{
  const f=await fixture(t);await f.propose(args(1));const b=await f.propose(args(2));
  await f.decide('confirmo pedido 2');assert.deepEqual(f.effects,[args(2)]);
  const again=await f.decide('confirmo pedido 2');assert.equal(again.replay,true);assert.equal(f.effects.length,1);
  assert.equal((await f.session()).pending()[0].number,1);
  assert.equal((await f.store.list(f.scope)).find(r=>r.id===b.id).state,'completed');
  await f.decide('sim');assert.equal(f.effects.length,1,'leftover proposal must not inherit a repeated bare yes');
});
test('unrelated messages preserve proposals and exact duplicate proposals reuse their number',async t=>{
  const f=await fixture(t);const a=await f.propose(args(1));
  assert.equal(await f.decide('Qual a previsão do tempo?'),null);
  const again=await f.propose(args(1));assert.equal(again.id,a.id);assert.equal((await f.session()).pending().length,1);
});
test('cards bind separately and channel metadata still selects the right proposal after restart',async t=>{
  const f=await fixture(t);const a=await f.propose(args(1));const b=await f.propose(args(2));
  const s=await f.session();const result=await withConfirmationSession(s,()=>withConfirmationReceipt(f.scope.threadId,{text:s.pending().map(proposalCard).join('\n\n')}));
  assert.equal(result.confirmationCards.length,2);
  await result.confirmationCards[0].onReplySent({channel:'whatsapp',messageIds:['card-a']});
  await result.confirmationCards[1].onReplySent({channel:'whatsapp',messageIds:['card-b']});
  await f.decide('pode',{target:{channel:'whatsapp',messageId:'card-b'}});
  assert.deepEqual(f.effects,[args(2)]);assert.equal((await f.session()).pending()[0].id,a.id);
  await f.decide('pode',{target:{channel:'whatsapp',messageId:'card-b'}});assert.equal(f.effects.length,1);
  const current=(await f.store.list(f.scope)).find(r=>r.id===b.id);assert.equal(current.messageRefs[0].messageId,'card-b');
});
test('canceling one request keeps another intact and invalidates every old reference',async t=>{
  const f=await fixture(t);const a=await f.propose(args(1));await f.propose(args(2));
  await f.store.bind(f.scope,[a.id],{channel:'telegram',messageId:'123:4'});
  assert.match((await f.decide('cancela pedido 1')).text,/Cancelei.*recipient1/);
  await f.decide('pode',{target:{channel:'telegram',messageId:'123:4'}});
  assert.equal(f.effects.length,0);assert.equal((await f.session()).pending()[0].number,2);
});
test('changing a selected request supersedes the old version before proposing the new one',async t=>{
  const f=await fixture(t);const a=await f.propose(args(1));await f.propose(args(2));
  const edit=await f.decide('altere pedido 1 para outro destinatário');assert.match(edit.note,/invalidado/);
  const next=await f.propose({...args(1),to:'new@example.invalid'});assert.equal(next.number,3);
  await f.decide('confirmo pedido 1');assert.equal(f.effects.length,0);
  assert.equal((await f.store.list(f.scope)).find(r=>r.id===a.id).state,'superseded');
  await f.decide('confirmo pedido 3');assert.equal(f.effects[0].to,'new@example.invalid');
  assert.equal((await f.session()).pending()[0].number,2);
});
test('two workers approving concurrently produce only one external effect',async t=>{
  const f=await fixture(t);await f.propose(args(1));
  let release;const wait=new Promise(resolve=>release=resolve);let entered;
  const started=new Promise(resolve=>entered=resolve);
  const slow={...f.tool,run:async data=>{f.effects.push(data);entered();await wait;return {ok:true};}};
  const first=f.decide('confirmo pedido 1',{resolveTool:async()=>({confirmationTool:slow})});
  await started;const second=await f.decide('confirmo pedido 1');assert.match(second.text,/em execução/);
  release();await first;assert.equal(f.effects.length,1);
});
test('expired proposals and interrupted claims cannot be executed on recovery',async t=>{
  const f=await fixture(t);const a=await f.propose(args(1));
  await f.db.query("UPDATE mtr_harness.confirmation_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",[a.id]);
  assert.match((await f.decide('confirmo pedido 1')).text,/expirad[oa]/);
  const b=await f.propose(args(2));const claim=await f.store.claim(f.scope,b.id,b.fingerprint);
  assert.ok(claim);await f.db.query("UPDATE mtr_harness.confirmation_requests SET lease_until=now()-interval '1 minute' WHERE id=$1",[b.id]);
  assert.match((await f.decide('confirmo pedido 2')).text,/resultado incerto/);assert.equal(f.effects.length,0);
});
test('missing delivery/presentation evidence asks to show the card before executing',async t=>{
  const f=await fixture(t);const s=await f.session();await withConfirmationSession(s,()=>gateTool(f.tool,f.scope.threadId).run(args(1)));
  assert.match((await f.decide('confirmo pedido 1')).text,/Confira primeiro/);assert.equal(f.effects.length,0);
});
test('changed permissions, target details, or missing adapters invalidate instead of executing',async t=>{
  const f=await fixture(t);await f.propose(args(1));
  const result=await f.decide('pode',{resolveTool:async()=>({confirmationTool:{...f.tool,preflight:async()=>({aviso:'Target changed'})}})});
  assert.match(result.text,/revalidar/);assert.equal(f.effects.length,0);
  await f.propose(args(2));await f.decide('pode',{resolveTool:async()=>null});assert.equal(f.effects.length,0);
});
test('an irreversible action still rejects reactions while a matched text can approve',async t=>{
  const f=await fixture(t);const a=await f.propose(args(1));await f.store.bind(f.scope,[a.id],{channel:'whatsapp',messageId:'card'});
  const result=await f.decide('👍',{viaReaction:true,target:{channel:'whatsapp',messageId:'card'}});
  assert.match(result.text,/exige confirmação por texto/);assert.equal(f.effects.length,0);
  await f.decide('pode',{target:{channel:'whatsapp',messageId:'card'}});assert.equal(f.effects.length,1);
});
test('failed persistence after execution never permits another attempt',async t=>{
  const f=await fixture(t);const a=await f.propose(args(1));
  f.failNext(/SET state=\$6,result=/);
  assert.match((await f.decide('pode')).text,/não pôde ser confirmado/);
  await f.decide('confirmo pedido 1');assert.equal(f.effects.length,1);
  assert.equal((await f.store.list(f.scope)).find(r=>r.id===a.id).state,'uncertain');
});
test('a repeated channel input cannot approve a different proposal',async t=>{
  const f=await fixture(t);await f.propose(args(1));await f.decide('pode',{inputId:'telegram:123:4'});
  await f.propose(args(2));await f.decide('confirmo pedido 2',{inputId:'telegram:123:4'});
  assert.equal(f.effects.length,1);assert.equal((await f.session()).pending()[0].number,2);
});
test('the proposal and arguments remain immutable when caller changes its object',async t=>{
  const f=await fixture(t);const input=args(1);await f.propose(input);input.to='changed@example.invalid';
  await f.decide('pode');assert.equal(f.effects[0].to,args(1).to);
});
test('selection ignores channel context and rejects conflicting number/reference and compound approvals',async t=>{
  const f=await fixture(t);await f.propose(args(1));await f.propose(args(2));
  const rows=(await f.session()).pending();rows[1].messageRefs=[{channel:'telegram',messageId:'123:8'}];
  assert.equal(selectConfirmation(rows,'confirmo pedido 1',{channel:'telegram',messageId:'123:8'}).kind,'unknown');
  assert.equal(selectConfirmation(rows,'confirmo pedido 1 e cancela pedido 2').kind,'ambiguous');
  assert.equal(selectConfirmation(rows,'[quoted: confirmo pedido 1]⁣Como funciona?').kind,'continue');
});
// Routine case 2026-10-07: the card stayed in the routine's own conversation,
// so a 👍 on the delivered Telegram message matched nothing and it expired.
test('a routine card moves to the chat it was delivered to and a reply there approves only it',async t=>{
  const f=await fixture(t);const chat={...f.scope,threadId:randomUUID()};
  await f.db.query('INSERT INTO mtr_harness.threads(id,user_id,agent_id) VALUES ($1,$2,$3)',[chat.threadId,chat.userId,chat.agentId]);
  const waiting=await f.store.propose(chat,{name:'gmail_send',args:args(9),label:'synthetic',confirmationText:'Synthetic chat card',context,source:{channel:'telegram'}});
  const card=await f.propose(args(1));
  const titles={'⏰ Weekly list':f.scope.threadId,Telegram:chat.threadId};
  const handOff=createRoutineConfirmationHandoff({store:f.store,getOrCreateThreadByTitle:async({title})=>({id:titles[title]}),log:()=>{}});
  const routine={channel:'telegram',title:'Weekly list',agent_id:f.scope.agentId,user_id:f.scope.userId};
  assert.deepEqual(await handOff(routine,'Nothing to approve',['123:7']),[]);
  assert.deepEqual(await handOff(routine,`Weekly summary\n\n${proposalCard(card)}`,['123:8']),[card.id]);
  assert.equal((await f.session()).pending().length,0);
  const moved=(await f.store.list(chat)).find(r=>r.id===card.id);
  assert.equal(moved.number,2);assert.deepEqual(moved.messageRefs,[{channel:'telegram',messageId:'123:8'}]);
  const s=await createConfirmationSession(f.store,chat,context);
  await withConfirmationSession(s,()=>handleConfirmation(s,{message:'pode',target:{channel:'telegram',messageId:'123:8'},resolveTool:async()=>({confirmationTool:f.tool})}));
  assert.deepEqual(f.effects,[args(1)]);
  assert.deepEqual((await f.store.list(chat)).filter(r=>r.state==='pending').map(r=>r.id),[waiting.id]);
});
