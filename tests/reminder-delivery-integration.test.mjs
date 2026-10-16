// Real occurrence SQL + executor + delivery factory; all channel I/O is fake.
// No application initialization, configured database, or production credentials.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createReminderStoreFixture } from '../test-support/reminders/store-fixture.mjs';
import { createReminderExecutor } from '../web/reminder-execution.mjs';
import { createScheduledDelivery } from '../web/scheduled-delivery.mjs';

test('reminder delivery integration uses durable SQL evidence and no ambiguous replay', async t => {
  const f = await createReminderStoreFixture();
  t.after(() => f.db.close());
  const history = id => f.store.listOccurrences(f.userId, id);
  async function due(extra) {
    const made = await f.create(extra);
    return (await f.store.listDue()).find(row => row.id === made.id);
  }
  function executor(overrides = {}, store = f.store) {
    const delivery = createScheduledDelivery({
      sendEmail: async () => ({ ok: true, id: 'synthetic-email' }),
      getTelegramBotForDelivery: async () => ({ token: 'synthetic', chat_id: 'synthetic' }),
      sendTelegramMessage: async () => ({ message_id: 42 }),
      waEnabled: () => true,
      getWhatsAppLinkForUser: async () => ({ wa_phone: 'synthetic', enabled: true }),
      sendWhatsAppProactive: async () => ({ wamid: 'synthetic-wa' }),
      whatsappProse: async () => assert.fail('unexpected model call'),
      persistProactiveToThread: async () => assert.fail('reminders must not fake proactive chat history'),
      ...overrides,
    });
    return createReminderExecutor(store, { deliver: delivery.deliverReminder });
  }

  await t.test('three channels persist their provider receipt only after delivery begins', async () => {
    for (const channel of ['email', 'telegram', 'whatsapp']) {
      const r = await due({ channel });
      let calls = 0;
      const accept = async () => {
        calls++;
        assert.equal((await f.parent(r.id)).status, 'pending');
        assert.equal((await f.parent(r.id)).sent_at, null);
        assert.equal((await history(r.id))[0].status, 'delivering');
        return { ok: true, id: 'synthetic-email', message_id: 42, wamid: 'synthetic-wa' };
      };
      const e = executor({ sendEmail: accept, sendTelegramMessage: accept,
        sendWhatsAppProactive: async (phone, text, options) => {
          assert.equal(options.retryUnknown, false);
          return accept();
        } });
      assert.equal((await e.execute(r)).status, 'accepted');
      const record = (await history(r.id))[0];
      assert.equal(record.status, 'accepted');
      assert.equal(record.receipt_id, ({ email: 'synthetic-email', telegram: '42', whatsapp: 'synthetic-wa' })[channel]);
      assert.ok(record.delivery_started_at && record.finished_at);
      assert.equal((await f.parent(r.id)).status, 'sent');
      assert.ok((await f.parent(r.id)).sent_at);
      assert.equal((await e.execute(r)).status, 'skipped');
      assert.equal(calls, 1);
    }
  });

  await t.test('competing runtime workers send exactly once for the same occurrence', async () => {
    const r = await due({ channel: 'email' });
    let sends = 0;
    const deps = { sendEmail: async () => { sends++; return { ok: true, id: 'one-receipt' }; } };
    const outcomes = await Promise.all([executor(deps).execute(r), executor(deps).execute(r)]);
    assert.deepEqual(outcomes.map(value => value.status).sort(), ['accepted', 'skipped']);
    assert.equal(sends, 1);
    assert.equal((await history(r.id))[0].attempt_count, 1);
  });

  await t.test('skipped email fails; missing receipt and timeout remain uncertain without retry', async () => {
    for (const [status, send] of [
      ['failed', () => ({ skipped: true })],
      ['uncertain', () => ({ ok: true })],
      ['uncertain', () => { throw Error('Synthetic timeout'); }],
    ]) {
      const r = await due({ channel: 'email' });
      let sends = 0;
      const e = executor({ sendEmail: async () => { sends++; return send(); } });
      assert.equal((await e.execute(r)).status, status);
      assert.equal((await history(r.id))[0].status, status);
      assert.equal((await f.parent(r.id)).status, status);
      assert.equal((await f.parent(r.id)).sent_at, null);
      assert.equal((await e.execute(r)).status, 'skipped');
      assert.equal(sends, 1);
      const listed = (await f.store.listForUser(f.userId, { includeRecent: true })).find(row => row.id === r.id);
      assert.equal(listed.last_occurrence.status, status);
    }
  });

  await t.test('provider acceptance followed by failed SQL commit is recovered without another send', async () => {
    const r = await due({ channel: 'email' });
    let sends = 0;
    const e = executor({ sendEmail: async () => {
      sends++;
      f.failNext(/UPDATE mtr_harness\.reminder_occurrences\s+SET status=\$2/);
      return { ok: true, id: 'accepted-before-db-error' };
    } });
    await assert.rejects(e.execute(r), /Synthetic persistence failure/);
    assert.equal((await history(r.id))[0].status, 'delivering');
    assert.equal((await f.parent(r.id)).sent_at, null);
    await f.expired((await history(r.id))[0].id);
    assert.equal(await e.recover(), 1);
    assert.equal((await history(r.id))[0].status, 'uncertain');
    assert.equal((await e.execute(r)).status, 'skipped');
    assert.equal(sends, 1);
  });

  await t.test('recovery before external send fences the old worker and permits one safe attempt', async () => {
    const r = await due({ channel: 'email' });
    const old = await f.store.claim(r);
    await f.expired(old.id);
    let sends = 0;
    const e = executor({ sendEmail: async () => { sends++; return { ok: true, id: 'new-worker' }; } });
    assert.equal(await e.recover(), 1);
    assert.equal(await f.store.begin(old), false);
    assert.equal((await e.execute(r)).status, 'accepted');
    assert.equal((await history(r.id))[0].attempt_count, 2);
    assert.equal(sends, 1);
  });

  await t.test('cancel between claim and send prevents channel I/O', async () => {
    const r = await due({ channel: 'email' });
    const e = executor({ sendEmail: async () => assert.fail('canceled reminder was sent') }, {
      ...f.store,
      begin: async claim => {
        assert.equal(await f.store.cancel(r.id, r.user_id), true);
        return f.store.begin(claim);
      },
    });
    assert.equal((await e.execute(r)).status, 'skipped');
    assert.equal((await history(r.id))[0].status, 'canceled');
    assert.equal((await f.parent(r.id)).status, 'canceled');
  });
});
