import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { createReminderStoreFixture } from './test-support/reminders/store-fixture.mjs';
import { createReminderExecutor } from './web/reminder-execution.mjs';
import { createReminderExecutionStore } from './web/reminder-execution-store.mjs';
import { createScheduledDelivery } from './web/scheduled-delivery.mjs';
import { recordReminderDeliveryStatuses } from './web/reminder-delivery-ledger.mjs';
import { reminderHistoryText } from './web/reminder-history.mjs';
net.Socket.prototype.connect = tls.connect = () => { throw Error('Real network forbidden'); };
process.env.WA_TOKEN = 'synthetic'; process.env.WA_PHONE_NUMBER_ID = 'business-fixture';
const { sendWhatsAppProactive, setWaHooks, retryProactiveAsTemplate } = await import('./web/whatsapp.mjs');
const phone = '5511000000000';
const payload = (status, business = 'business-fixture') => ({ entry: [{ changes: [{ value: {
  metadata: { phone_number_id: business }, statuses: [status],
} }] }] });

test('real webhook route authenticates before SQL and acknowledges only committed status',async()=>{
  const source=readFileSync(new URL('./web/server.mjs',import.meta.url),'utf8');
  const start=source.indexOf("  if (req.method === 'POST' && url.pathname === '/api/wa/webhook') {");
  const end=source.indexOf('\n  // ── Canal Slack',start);
  assert.ok(start>0&&end>start);
  const raw=Buffer.from(JSON.stringify(payload({id:'route-id',status:'sent',recipient_id:phone})));
  let authorized=false,fail=false,records=0,background=0,httpStatus;
  const deps={readRaw:async()=>raw,verifySignature:bytes=>{assert.equal(bytes,raw);return authorized;},
    recordReminderDeliveryStatuses,recordReminderDeliveryStatus:async()=>{records++;if(fail)throw Error('DB unavailable');},
    waEnabled:()=>true,waHandler:{accept:async()=>{},process:async()=>{background++;}}};
  const route=new Function(...Object.keys(deps),`return async(req,res,url)=>{${source.slice(start,end)}}`)(...Object.values(deps));
  const res={writeHead:code=>{httpStatus=code;},end(){}};
  const req={method:'POST',headers:{'x-hub-signature-256':'synthetic'}};
  const url={pathname:'/api/wa/webhook'};
  await route(req,res,url);assert.equal(httpStatus,403);assert.equal(records,0);assert.equal(background,0);
  authorized=true;fail=true;await route(req,res,url);assert.equal(httpStatus,503);assert.equal(records,1);assert.equal(background,0);
  fail=false;await route(req,res,url);assert.equal(httpStatus,200);assert.equal(records,2);assert.equal(background,1);
});

test('real sender and SQL reconcile callbacks without another HTTP send', async t => {
  const f = await createReminderStoreFixture(); t.after(() => f.db.close());
  setWaHooks({ lastInboundAt: async () => new Date() });
  let requests = [], replies = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const reply = replies.shift(); assert.ok(reply, 'unexpected send');
    return reply(body);
  };
  const accept = id => async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id }] }) });
  const reject = code => async () => ({ ok: false, status: 400, json: async () => ({ error: { message: String(code) } }) });
  const delivery = createScheduledDelivery({ waEnabled: () => true,
    getWhatsAppLinkForUser: async () => ({ wa_phone: phone }), sendWhatsAppProactive });
  const executor = createReminderExecutor(f.store, { deliver: delivery.deliverReminder });
  const history = async r => (await f.store.listOccurrences(f.userId, r.id))[0];
  const status = (request, id, state = 'delivered', recipient = phone) => ({
    id, status: state, recipient_id: recipient, biz_opaque_callback_data: request.biz_opaque_callback_data,
  });
  const callback = (st, business) => recordReminderDeliveryStatuses(payload(st, business), f.store.recordDeliveryStatus, 'business-fixture');

  await t.test('lost HTTP response recovers by opaque ID after restart, without sending again', async () => {
    requests = []; replies = [async () => { throw Error('lost response'); }];
    const r = await f.create();
    assert.equal((await executor.execute(r)).status, 'uncertain');
    // Recreate the store: correlation belongs to SQL, not the process Map.
    const restarted = createReminderExecutionStore({ query: (...args) => f.db.query(...args),
      connect: async () => ({ query: (...args) => f.db.query(...args), release() {} }) });
    await recordReminderDeliveryStatuses(payload(status(requests[0], 'lost-http')), restarted.recordDeliveryStatus, 'business-fixture');
    assert.equal((await history(r)).delivery_state, 'delivered');
    assert.equal((await history(r)).status, 'accepted');
    assert.equal((await f.parent(r.id)).status, 'sent');
    assert.equal((await executor.execute(r)).status, 'skipped');
    assert.equal(requests.length, 1);
  });
  await t.test('callback before the HTTP reply and duplicates/out-of-order statuses are monotonic', async () => {
    requests = []; replies = [async request => {
      await callback(status(request, 'early', 'read'));
      return accept('early')();
    }];
    const r = await f.create(); await executor.execute(r);
    for (const state of ['delivered', 'sent', 'failed', 'read']) await callback(status(requests[0], 'early', state));
    assert.equal((await history(r)).delivery_state, 'read');
    const text = reminderHistoryText(await f.store.listForUser(f.userId, { includeRecent: true }));
    assert.match(text, /leitura confirmada pelo canal/);
  });
  await t.test('all parts must be delivered; failure of a later part remains partial', async () => {
    requests = []; replies = [accept('partial-first'), reject('synthetic refusal')];
    const r = await f.create({ message: 'x'.repeat(1800) });
    assert.equal((await executor.execute(r)).status, 'uncertain');
    await callback(status(requests[0], 'partial-first'));
    assert.equal((await history(r)).delivery_state, 'partial');
    assert.equal((await executor.execute(r)).status, 'skipped');
    assert.equal(requests.length, 2);
    assert.match(reminderHistoryText(await f.store.listForUser(f.userId, { includeRecent: true })), /envio parcial/);
  });
  await t.test('first delivered part cannot prove full delivery; remaining callback completes it', async () => {
    requests = []; replies = [accept('multi-1'), accept('multi-2')];
    const r = await f.create({ message: 'y'.repeat(1800) }); await executor.execute(r);
    await callback(status(requests[0], 'multi-1'));
    assert.equal((await history(r)).delivery_state, 'accepted');
    await callback(status(requests[1], 'multi-2'));
    assert.equal((await history(r)).delivery_state, 'delivered');
  });
  await t.test('known first rejection allows template, but an asynchronous failure never repeats tracked content', async () => {
    requests = []; replies = [reject('131047: outside allowed window'), accept('template')];
    const r = await f.create(); await executor.execute(r);
    assert.deepEqual(requests.map(x => x.type), ['text','template']);
    await callback(status(requests[1], 'template', 'failed'));
    assert.equal((await history(r)).status, 'failed');
    assert.equal(await retryProactiveAsTemplate('template', phone), false);
    assert.equal(requests.length, 2);
  });
  await t.test('owner/recipient/provider/business mismatch cannot attach evidence', async () => {
    requests = []; replies = [accept('scoped')];
    const r = await f.create(); await executor.execute(r);
    await callback(status(requests[0], 'scoped', 'read', '5522000000000'));
    await callback(status(requests[0], 'scoped', 'read'), 'other-business');
    await callback(status(requests[0], 'wrong-message', 'read'));
    assert.equal((await history(r)).delivery_state, 'accepted');
    assert.deepEqual(await f.store.listOccurrences(f.otherId,r.id), []);
  });
  await t.test('callback persistence failure propagates for webhook retry, then replay succeeds', async () => {
    requests = []; replies = [accept('retry-event')];
    const r = await f.create(); await executor.execute(r);
    f.failNext(/UPDATE mtr_harness.reminder_delivery_parts/);
    await assert.rejects(callback(status(requests[0], 'retry-event')), /Synthetic persistence/);
    await callback(status(requests[0], 'retry-event'));
    assert.equal((await history(r)).delivery_state, 'delivered');
    assert.equal(requests.length, 1);
  });
  await t.test('accepted receipt survives failed final commit and expired worker recovery', async () => {
    requests = []; replies = [accept('saved-part')];
    const r = await f.create();
    f.failNext(/SET status=\$2,finished_at/);
    await assert.rejects(executor.execute(r), /Synthetic persistence/);
    await f.expired((await history(r)).id); await executor.recover();
    assert.equal((await history(r)).status, 'accepted');
    assert.equal(requests.length, 1);
  });
  await t.test('cancel and recurrence cursor are preserved during late reconciliation', async () => {
    requests = []; replies = [async () => { throw Error('unknown'); }];
    const r = await f.create({ repeatEveryMin: 1440 }); await executor.execute(r);
    const next = (await f.parent(r.id)).run_at;
    await f.store.cancel(r.id,f.userId);
    await callback(status(requests[0], 'canceled-late'));
    assert.equal((await f.parent(r.id)).status, 'canceled');
    assert.deepEqual((await f.parent(r.id)).run_at, next);
    const original = (await f.store.listOccurrences(f.userId,r.id)).find(o => new Date(o.scheduled_at).getTime() === new Date(r.run_at).getTime());
    assert.equal(original.delivery_state, 'delivered');
  });
  const metrics = await f.store.metrics();
  assert.equal(metrics.windowDays, 30);
  assert.ok(metrics.outcomes.some(row => row.delivery_state === 'partial'));
  assert.doesNotMatch(JSON.stringify(metrics), new RegExp(phone));
});
