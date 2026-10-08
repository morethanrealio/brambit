// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
// Routine with MINUTE (case from 2026-10-01): asked for "todo dia às 22h30" and only
// whole hours existed. Covers parse/label, firing at the right minute, the card
// in pt/en/es and the old criar_rotina card being replaced by the new one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
const denied=()=>{throw Error('External IO forbidden');};
net.Socket.prototype.connect=tls.connect=denied;globalThis.fetch=denied;
registerHooks({resolve(specifier,context,next){
  if(specifier==='./compras.mjs'&&context.parentURL?.endsWith('/web/confirm.mjs')) return {url:'data:text/javascript,export const descreverCarrinho=()=>null;export const plataformaDoCarrinho=()=>null;',shortCircuit:true};
  return next(specifier,context);
}});
const {parseRoutineTime,routineTimeLabel,routineArgsTimeLabel,routineMinuteOfDay,routineSupersedeKey}=await import('../web/routine-time.mjs');
const {isDue}=await import('../web/scheduler.mjs');
const {describe,describeDone,gateTool}=await import('../web/confirm.mjs');
const {confirmationFixture}=await import('../test-support/confirmation-fixture.mjs');
const {createConfirmationSession,withConfirmationSession}=await import('../web/confirmation-session.mjs');
const {handleConfirmation}=await import('../web/confirmation-flow.mjs');

test('parse and labels: minute is optional, hora alone means the full hour',()=>{
  assert.deepEqual(parseRoutineTime({hora:22,minuto:30}),{hour:22,minute:30});
  assert.deepEqual(parseRoutineTime({hora:'8'}),{hour:8,minute:0});
  assert.deepEqual(parseRoutineTime({minuto:15}),{minute:15});
  assert.deepEqual(parseRoutineTime({}),{});
  for(const bad of [{hora:24},{hora:-1},{hora:7.5},{minuto:60},{minuto:'meia'},{hora:22,minuto:-5}]) assert.ok(parseRoutineTime(bad).error,JSON.stringify(bad));
  assert.equal(routineTimeLabel(22,30),'22h30');assert.equal(routineTimeLabel(7,0),'07h');assert.equal(routineTimeLabel(7,5,':'),'07:05');
  assert.equal(routineArgsTimeLabel({hora:22,minuto:30}),'22h30');assert.equal(routineArgsTimeLabel({}),null);assert.equal(routineArgsTimeLabel({minuto:30}),':30');
  assert.equal(routineMinuteOfDay({hour:22,minute:30}),1350);assert.equal(routineMinuteOfDay({hour:22}),1320,'legacy routine with no minute = full hour');
});

test('a 22h30 routine fires at 22:30 local, not at 22:00, and a legacy routine keeps firing on the hour',()=>{
  const r={enabled:true,hour:22,minute:30,days:'daily',tz:'America/Sao_Paulo',last_run_day:null};
  assert.equal(isDue(r,new Date('2026-10-02T01:00:00Z')),false,'22:00 BRT');
  assert.equal(isDue(r,new Date('2026-10-02T01:29:00Z')),false,'22:29 BRT');
  assert.equal(isDue(r,new Date('2026-10-02T01:30:00Z')),true,'22:30 BRT');
  assert.equal(isDue({...r,minute:undefined},new Date('2026-10-02T01:00:00Z')),true,'legacy with no minute = 22:00');
});

test('the confirmation card shows 22h30 in every language',()=>{
  const args={titulo:'Aquece diário de inglês',hora:22,minuto:30,dias:'todos',canal:'whatsapp'};
  assert.match(describe('criar_rotina',args),/22h30/);
  assert.match(describe('criar_rotina',args,'en'),/22:30/);
  assert.match(describe('criar_rotina',args,'es'),/22:30/);
  assert.match(describeDone('criar_rotina',args),/22h30/);
  assert.doesNotMatch(describe('criar_rotina',{...args,minuto:undefined}),/22h30|22h00/);
});

test('re-proposing the same routine closes the older card instead of stacking two',async t=>{
  const f=await confirmationFixture();t.after(()=>f.db.close());const effects=[];
  const tool={name:'criar_rotina',supersedeKey:routineSupersedeKey,run:async a=>{effects.push(a);return 'ok';}};
  const propose=async a=>{const s=await createConfirmationSession(f.store,f.scope);await withConfirmationSession(s,()=>gateTool(tool,f.scope.threadId).run(a));return (await createConfirmationSession(f.store,f.scope)).pending();};
  const a=await propose({titulo:'Aquece diário de inglês',hora:22});
  const b=await propose({titulo:'  aquece DIÁRIO de inglês ',hora:22,minuto:30});
  assert.equal(b.length,1,'the 22h card left the queue');assert.equal(b[0].args.minuto,30);
  const c=await propose({titulo:'Resumo do dia',hora:8});
  assert.equal(c.length,2,'a routine with a different title doesn\'t replace it');
  await f.store.present(f.scope,[a[0].id]);
  const s=await createConfirmationSession(f.store,f.scope);
  const velho=await withConfirmationSession(s,()=>handleConfirmation(s,{message:`confirmo pedido ${a[0].number}`,resolveTool:async()=>({confirmationTool:tool})}));
  assert.match(velho.text,/substituída por uma nova proposta/,velho.text);
  assert.deepEqual(effects,[],'proposing and approving the old card never creates a routine');
});
