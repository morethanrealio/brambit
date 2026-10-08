import test from 'node:test';
import assert from 'node:assert/strict';
import { recurrenceOccurrences, localDateTimeInstant, calendarWindow } from './web/calendar-recurrence.mjs';
import { nextReminderRun } from './web/reminder-execution-store.mjs';
import { selectReminder, reminderManagementTools } from './web/reminder-management.mjs';
import { createReminderStoreFixture } from './test-support/reminders/store-fixture.mjs';
import { createActionJournal } from './web/action-evidence.mjs';

test('monthly and every-other-day cross months without turning into 30 days or odd days', () => {
  const month=recurrenceOccurrences({frequencia:'mensal'},'2026-09-14T08:30:00');
  assert.deepEqual(month.map(x=>x.local),['2026-09-14T08:30:00','2026-10-14T08:30:00','2026-11-14T08:30:00']);
  assert.deepEqual(recurrenceOccurrences({frequencia:'diaria',intervalo:2,quantidade:3},'2026-09-29T07:00:00').map(x=>x.local.slice(0,10)),['2026-09-29','2026-10-01','2026-10-03']);
  assert.equal(recurrenceOccurrences({frequencia:'mensal',ate:'2026-10-14'},'2026-09-14T08:30:00').length,2);
  assert.throws(()=>recurrenceOccurrences({frequencia:'mensal'},'2026-09-30T08:30:00'),/meses curtos/);
  const dst=recurrenceOccurrences({frequencia:'diaria'},'2026-10-24T08:30:00','Europe/Zurich');
  assert.deepEqual(dst.map(x=>x.instant),['2026-10-24T06:30:00.000Z','2026-10-25T07:30:00.000Z','2026-10-26T07:30:00.000Z']);
  assert.throws(()=>localDateTimeInstant('2026-03-29T02:30:00','Europe/Zurich'),/não existe/);
  assert.throws(()=>localDateTimeInstant('2026-02-30T10:00:00'),/inválida/);
  assert.deepEqual(calendarWindow({inicio:'2025-08-01',fim:'2025-08-02'}),{from:'2025-08-01T03:00:00.000Z',to:'2025-08-02T03:00:00.000Z'});
  assert.equal(recurrenceOccurrences({frequencia:'diaria'},'2026-09-14T08:30:00','America/Sao_Paulo',{after:'2056-09-14T11:30:00Z',limit:1})[0].local,'2056-09-15T08:30:00');
});

test('a date alone does not authorize canceling two reminders on the same day', async () => {
  const rows=[{id:'a',message:'Pagar conta',run_at:'2027-09-14T10:00:00Z',channel:'email'},{id:'b',message:'Pagar conta',run_at:'2027-09-14T15:00:00Z',channel:'whatsapp'}];
  assert.equal(selectReminder(rows,{descricao:'conta',data:'2027-09-14'},'America/Sao_Paulo').code,'AMBIGUOUS');
  assert.equal(selectReminder(rows,{descricao:'conta',data:'2027-99-99'},'America/Sao_Paulo').ok,false);
  let canceled=[];
  const tools=reminderManagementTools({userId:'owner',timeZone:'America/Sao_Paulo',list:async()=>rows,cancel:async id=>{canceled.push(id);return true;}});
  assert.equal(JSON.parse(await tools[0].run({descricao:'conta',data:'2027-09-14'})).ok,false);
  assert.deepEqual(canceled,[]);
  assert.equal(JSON.parse(await tools[0].run({id:'b'})).ok,true);
  assert.deepEqual(canceled,['b']);
  const journal=createActionJournal();
  journal.toolResult({name:'cancelar_lembrete',args:{id:'b'}},JSON.stringify({ok:true,id:'b',canal:'whatsapp'}));
  assert.equal(journal.finish('Lembrete cancelado.'),'Lembrete cancelado.');
});

test('durable recurrence and rescheduling: dedup, rollback, worker fence and series resumption', async t => {
  const f=await createReminderStoreFixture(); t.after(()=>f.db.close());
  const c={regra:{frequencia:'mensal',quantidade:3},inicio:'2027-09-14T08:30:00',fuso:'America/Sao_Paulo'};
  const a={calendarRecurrence:c,runAt:'2027-09-14T11:30:00.000Z',message:'Mensal'};
  const r=await f.create(a), again=await f.create(a);
  assert.equal(again.id,r.id); assert.equal(again.duplicate,true);
  assert.equal((await f.create({...a,calendarRecurrence:null})).duplicate,false);
  assert.equal((await f.create({...a,calendarRecurrence:{...c,regra:{frequencia:'mensal',quantidade:4}}})).duplicate,false);
  assert.equal(nextReminderRun(r,r.run_at),'2027-10-14T11:30:00.000Z');
  assert.equal(nextReminderRun(r,'2027-11-14T11:30:00Z'),null);
  await assert.rejects(f.create({...a,repeatEveryMin:1440}),/Não combine/);
  assert.equal((await f.store.reschedule(r.id,f.otherId,{expectedRunAt:r.run_at,runAt:'2027-09-14T10:00:00Z'})).ok,false);
  const moved=await f.store.reschedule(r.id,f.userId,{expectedRunAt:r.run_at,runAt:'2027-09-14T10:00:00Z'});
  assert.equal(moved.ok,true);
  assert.equal(nextReminderRun(moved.reminder,moved.reminder.run_at),'2027-10-14T11:30:00.000Z');
  assert.equal((await f.store.reschedule(r.id,f.userId,{expectedRunAt:r.run_at,runAt:'2027-09-14T09:00:00Z'})).code,'REMINDER_CHANGED');
  const old=(await f.store.listOccurrences(f.userId,r.id)).find(o=>new Date(o.scheduled_at).toISOString()===a.runAt);
  assert.equal(old.status,'canceled');
  // Legacy interval also resumes the anchor, without firing again on the same day.
  const daily=await f.create({runAt:'2027-09-14T13:00:00Z',repeatEveryMin:1440});
  const dayMoved=await f.store.reschedule(daily.id,f.userId,{expectedRunAt:daily.run_at,runAt:'2027-09-14T10:00:00Z'});
  assert.equal(nextReminderRun(dayMoved.reminder,dayMoved.reminder.run_at),'2027-09-15T13:00:00.000Z');
  const claimed=await f.create(), worker=await f.store.claim(claimed);
  const rescheduled=await f.store.reschedule(claimed.id,f.userId,{expectedRunAt:claimed.run_at,runAt:new Date(Date.now()+3600000)});
  assert.equal(rescheduled.ok,true); assert.equal(await f.store.begin(worker),false);
  const sending=await f.create(), inFlight=await f.store.claim(sending); await f.store.begin(inFlight);
  assert.equal((await f.store.reschedule(sending.id,f.userId,{expectedRunAt:sending.run_at,runAt:new Date(Date.now()+3600000)})).code,'DELIVERY_STARTED');
  const before=await f.parent(daily.id);
  f.failNext(/UPDATE mtr_harness.reminders SET run_at/);
  await assert.rejects(f.store.reschedule(daily.id,f.userId,{expectedRunAt:before.run_at,runAt:'2027-09-16T12:00:00Z'}),/persistence failure/);
  assert.equal(new Date((await f.parent(daily.id)).run_at).toISOString(),new Date(before.run_at).toISOString());
  const current=(await f.store.listOccurrences(f.userId,daily.id)).find(o=>new Date(o.scheduled_at).getTime()===new Date(before.run_at).getTime());
  assert.equal(current.status,'scheduled');
  const yesterday=new Date(Date.now()-86400000), local=yesterday.toISOString().slice(0,10)+'T08:30:00';
  const recent=await f.create({runAt:localDateTimeInstant(local),calendarRecurrence:{regra:{frequencia:'diaria',quantidade:3},inicio:local,fuso:'America/Sao_Paulo'}});
  const recentClaim=await f.store.claim(recent);await f.store.begin(recentClaim);
  const finished=await f.store.finish(recentClaim,{status:'accepted',receipt:{channel:recent.channel,id:'synthetic-acceptance'}});
  assert.equal(finished.nextRun,nextReminderRun(recent,new Date()));
  assert.equal((await f.parent(recent.id)).status,'pending');
  assert.equal((await f.store.listOccurrences(f.userId,recent.id)).filter(o=>o.status==='scheduled').length,1);
});
