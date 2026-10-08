import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { nextReminderRun } from '../web/reminder-execution-store.mjs';
import { createReminderStoreFixture } from '../test-support/reminders/store-fixture.mjs';

test('schema migration backfills legacy initial slot without fabricating history or rewriting its cursor', async t => {
  const before = '2026-09-19T10:00:00Z';
  const after = '2026-09-21T10:00:00Z';
  let id;
  const f = await createReminderStoreFixture({ beforeSchema: async ({ db, userId, agentId }) => {
    const inserted = await db.query(`INSERT INTO mtr_harness.reminders(user_id,agent_id,message,run_at,channel,repeat_every_min)
      VALUES ($1,$2,'Legacy synthetic schedule',$3,'email',1440) RETURNING id`, [userId, agentId, before]);
    id = inserted.rows[0].id;
  } });
  t.after(() => f.db.close());
  assert.equal(new Date((await f.parent(id)).initial_run_at).toISOString(), new Date(before).toISOString());
  assert.deepEqual(await f.store.listOccurrences(f.userId, id), []);
  await f.db.query('UPDATE mtr_harness.reminders SET run_at=$2 WHERE id=$1', [id, after]);
  await f.store.ensureSchema();
  const row = await f.parent(id);
  assert.equal(new Date(row.run_at).toISOString(), new Date(after).toISOString());
  assert.equal(new Date(row.initial_run_at).toISOString(), new Date(before).toISOString());
  const indexes = await f.db.query("SELECT indexname FROM pg_indexes WHERE schemaname='mtr_harness' AND tablename='reminders'");
  assert.ok(indexes.rows.some(r => r.indexname === 'reminders_dedup_request_v2_idx'));
  assert.ok(!indexes.rows.some(r => r.indexname === 'reminders_dedup_pending_idx'));
});

test('isolated reminder persistence: real SQL, ownership, fencing and occurrence history', async t => {
  const f = await createReminderStoreFixture();
  const { db, store, create, parent, userId, otherId, agentId, threadId } = f;
  t.after(() => db.close());

  await t.test('create request identity and schedule atomically; conflicting cadence is refused', async () => {
    const actionId = randomUUID();
    const args = { userId, agentId, message: 'Synthetic scheduled message', channel: 'whatsapp',
      runAt: new Date(Date.now() - 5_000).toISOString(), actionId, originThreadId: threadId };
    const first = await store.create(args);
    const duplicate = await store.create(args);
    assert.equal(first.id, duplicate.id);
    assert.equal(duplicate.duplicate, true);
    const records = await store.listOccurrences(userId, first.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'scheduled');
    assert.equal(records[0].action_id, actionId);
    assert.equal(records[0].origin_thread_id, threadId);
    assert.equal(records[0].attempt_count, 0);
    assert.equal('claim_token' in records[0], false);
    assert.equal('message' in records[0], false);
    await assert.rejects(store.create({ ...args, channel: 'email' }), { code: 'REMINDER_CONFLICT' });
    await assert.rejects(store.create({ ...args, repeatEveryMin: 1440 }), { code: 'REMINDER_CONFLICT' });
    await assert.rejects(store.create({ ...args, runAt: new Date(Date.now() + 3600_000).toISOString() }), { code: 'REMINDER_CONFLICT' });
    assert.equal(await store.create({ ...args, userId: otherId, actionId: randomUUID() }), null);
    assert.deepEqual(await store.listOccurrences(otherId, first.id), []);
  });

  await t.test('competing claims admit one sender; no sent marker or next slot before acceptance', async () => {
    const r = await create();
    const claims = await Promise.all([store.claim(r), store.claim(r)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const claim = claims.find(Boolean);
    assert.equal((await parent(r.id)).status, 'pending');
    assert.equal((await parent(r.id)).sent_at, null);
    assert.equal(await store.claim({ ...r, user_id: otherId }), null);
    assert.equal(await store.begin({ ...claim, token: randomUUID() }), false);
    assert.equal(await store.begin(claim), true);
    assert.equal(await store.begin(claim), false);
    await assert.rejects(store.finish(claim, { status: 'accepted' }), /receipt/);
    const result = await store.finish(claim, { status: 'accepted', receipt: { id: 'synthetic-receipt', channel: r.channel } });
    assert.deepEqual(result, { status: 'accepted', nextRun: null, reminderStatus: 'sent' });
    assert.ok((await parent(r.id)).sent_at);
    assert.equal(await store.finish(claim, { status: 'uncertain' }), null);
    assert.equal(await store.claim(r), null);
    const history = await store.listOccurrences(userId, r.id);
    assert.equal(history[0].receipt_id, 'synthetic-receipt');
    assert.equal(history[0].status, 'accepted');
    assert.ok(history[0].delivery_started_at && history[0].finished_at);
  });

  await t.test('recurrence advances after finish, retains previous result and refuses stale slot', async () => {
    const actionId = randomUUID();
    const r = await create({ repeatEveryMin: 1440, actionId });
    const claim = await store.claim(r);
    assert.equal(new Date((await parent(r.id)).run_at).getTime(), new Date(r.run_at).getTime());
    await store.begin(claim);
    const result = await store.finish(claim, { status: 'accepted', receipt: { id: 'daily-receipt', channel: r.channel } });
    assert.ok(new Date(result.nextRun) > new Date());
    assert.equal(result.reminderStatus, 'pending');
    const history = await store.listOccurrences(userId, r.id);
    assert.deepEqual(history.map(row => row.status), ['scheduled', 'accepted']);
    assert.equal(history[1].attempt_count, 1);
    assert.equal(await store.claim(r), null);
    assert.equal(await store.claim(await parent(r.id)), null); // Future slot.
    const originalRequest = { userId, agentId, message: r.message, channel: r.channel,
      runAt: r.initial_run_at, repeatEveryMin: 1440, actionId };
    const replayed = await store.create(originalRequest);
    assert.equal(replayed.id, r.id);
    assert.equal(replayed.duplicate, true);
    assert.equal(new Date(replayed.run_at).toISOString(), result.nextRun);
    assert.equal(new Date(replayed.initial_run_at).toISOString(), new Date(r.initial_run_at).toISOString());
    await assert.rejects(store.create({ ...originalRequest, runAt: result.nextRun }), { code: 'REMINDER_CONFLICT' });
  });

  await t.test('dedup identity preserves different channels, intervals and recurrence ends', async () => {
    const args = { message: randomUUID(), runAt: new Date(Date.now() - 5_000).toISOString() };
    const oneoff = await create(args);
    assert.equal((await create(args)).id, oneoff.id);
    const email = await create({ ...args, channel: 'email' });
    const daily = await create({ ...args, repeatEveryMin: 1440 });
    const alternate = await create({ ...args, repeatEveryMin: 2880 });
    const bounded = await create({ ...args, repeatEveryMin: 1440, repeatUntil: new Date(Date.now() + 86400_000).toISOString() });
    assert.equal(new Set([oneoff.id, email.id, daily.id, alternate.id, bounded.id]).size, 5);
  });

  await t.test('distinct starting dates remain independent when future slots overlap or one series is canceled', async () => {
    const recurring = await create({ repeatEveryMin: 1440 });
    const next = nextReminderRun(recurring, new Date());
    const covering = await create({ message: recurring.message, runAt: next, repeatEveryMin: 1440 });
    const claim = await store.claim(recurring);
    await store.begin(claim);
    const result = await store.finish(claim, { status: 'accepted', receipt: { id: 'accepted-before-overlap', channel: recurring.channel } });
    assert.deepEqual(result, { status: 'accepted', nextRun: next, reminderStatus: 'pending' });
    assert.equal((await parent(recurring.id)).status, 'pending');
    assert.equal((await parent(covering.id)).status, 'pending');
    assert.equal(new Date((await parent(covering.id)).run_at).toISOString(), next);
    const records = await store.listOccurrences(userId, recurring.id);
    assert.deepEqual(records.map(r => r.status), ['scheduled', 'accepted']);
    assert.equal(records[0].attempt_count, 0);
    assert.equal(records[1].receipt_id, 'accepted-before-overlap');
    await store.cancel(covering.id, userId);
    assert.equal((await parent(recurring.id)).status, 'pending');
    assert.equal((await store.listOccurrences(userId, recurring.id))[0].status, 'scheduled');
    assert.equal(await store.claim(recurring), null);
  });

  await t.test('overlapping one-off does not suppress a series with different delivery terms', async () => {
    const recurring = await create({ repeatEveryMin: 1440 });
    const next = nextReminderRun(recurring, new Date());
    const oneoff = await create({ message: recurring.message, runAt: next });
    const claim = await store.claim(recurring);
    await store.begin(claim);
    const result = await store.finish(claim, { status: 'uncertain' });
    assert.equal(result.nextRun, next);
    assert.equal(result.reminderStatus, 'pending');
    assert.equal((await parent(oneoff.id)).status, 'pending');
    assert.deepEqual((await store.listOccurrences(userId, recurring.id)).map(r => r.status), ['scheduled', 'uncertain']);
  });

  await t.test('known failure and ambiguous delivery are terminal for that occurrence, not the series', async () => {
    for (const status of ['failed', 'uncertain']) {
      const r = await create({ repeatEveryMin: 1440 });
      const claim = await store.claim(r);
      await store.begin(claim);
      const result = await store.finish(claim, { status, errorCode: 'PRIVATE MESSAGE must not be logged' });
      assert.equal(result.status, status);
      assert.equal(result.reminderStatus, 'pending');
      assert.ok(result.nextRun);
      assert.equal(await store.claim(r), null);
      const history = await store.listOccurrences(userId, r.id);
      assert.equal(history[1].status, status);
      assert.equal(JSON.stringify(history).includes('PRIVATE'), false);
      assert.equal((await parent(r.id)).sent_at, null);
    }
  });

  await t.test('expired claim before network can retry, with an invalidated old token', async () => {
    const r = await create();
    const old = await store.claim(r);
    await f.expired(old.id);
    assert.equal(await store.begin(old), false);
    assert.equal(await store.recoverExpired(), 1);
    const fresh = await store.claim(r);
    assert.equal(fresh.id, old.id);
    assert.notEqual(fresh.token, old.token);
    assert.equal(await store.begin(old), false);
    assert.equal(await store.finish(old, { status: 'failed' }), null);
    assert.equal(await store.begin(fresh), true);
    await store.finish(fresh, { status: 'accepted', receipt: { id: 'recovered-before-send', channel: r.channel } });
    assert.equal((await store.listOccurrences(userId, r.id))[0].attempt_count, 2);
  });

  await t.test('expired in-flight delivery becomes uncertain and never replays that slot', async () => {
    const r = await create({ repeatEveryMin: 1440 });
    const claim = await store.claim(r);
    await store.begin(claim);
    await f.expired(claim.id);
    assert.equal(await store.recoverExpired(), 1);
    assert.equal(await store.claim(r), null);
    assert.equal(await store.finish(claim, { status: 'accepted', receipt: { id: 'late-worker', channel: r.channel } }), null);
    const history = await store.listOccurrences(userId, r.id);
    assert.deepEqual(history.map(row => row.status), ['scheduled', 'uncertain']);
    assert.equal(history[1].error_code, 'WORKER_INTERRUPTED');
    assert.equal(history[1].receipt_id, null);
  });

  await t.test('cancellation before sending fences worker; after sending preserves evidence without resurrection', async () => {
    const before = await create({ repeatEveryMin: 1440 });
    const a = await store.claim(before);
    assert.equal(await store.cancel(before.id, otherId), false);
    assert.equal(await store.cancel(before.id, userId), true);
    assert.equal(await store.begin(a), false);
    assert.equal((await store.listOccurrences(userId, before.id))[0].status, 'canceled');

    const after = await create({ repeatEveryMin: 1440 });
    const b = await store.claim(after);
    await store.begin(b);
    assert.equal(await store.cancel(after.id, userId), true);
    const result = await store.finish(b, { status: 'accepted', receipt: { id: 'already-in-flight', channel: after.channel } });
    assert.deepEqual(result, { status: 'accepted', nextRun: null, reminderStatus: 'canceled' });
    assert.equal((await parent(after.id)).status, 'canceled');
    const history = await store.listOccurrences(userId, after.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].status, 'accepted');
  });

  await t.test('ledger and recurrence update roll back together after persistence failure', async () => {
    const r = await create({ repeatEveryMin: 1440 });
    const claim = await store.claim(r);
    await store.begin(claim);
    f.failNext(/UPDATE mtr_harness\.reminders\s+SET run_at/);
    await assert.rejects(store.finish(claim, { status: 'accepted', receipt: { id: 'external-request-succeeded', channel: r.channel } }), /Synthetic/);
    assert.equal((await store.listOccurrences(userId, r.id))[0].status, 'delivering');
    assert.equal(new Date((await parent(r.id)).run_at).getTime(), new Date(r.run_at).getTime());
    await store.finish(claim, { status: 'uncertain', errorCode: 'PERSISTENCE_FAILED' });
    assert.equal((await store.listOccurrences(userId, r.id))[1].status, 'uncertain');
  });

  await t.test('owner listing distinguishes next scheduled occurrence from last outcome and opts into recent history', async () => {
    const recurring = await create({ repeatEveryMin: 1440 });
    const claim = await store.claim(recurring);
    await store.begin(claim);
    await store.finish(claim, { status: 'failed', errorCode: 'PROVIDER_REJECTED' });
    const oneoff = await create();
    const sent = await store.claim(oneoff);
    await store.begin(sent);
    await store.finish(sent, { status: 'accepted', receipt: { id: 'listing-receipt', channel: oneoff.channel } });
    const pending = await store.listForUser(userId);
    const series = pending.find(r => r.id === recurring.id);
    assert.equal(series.status, 'pending');
    assert.ok(new Date(series.run_at) > new Date());
    assert.equal(series.last_occurrence.status, 'failed');
    assert.equal(series.last_occurrence.errorCode, 'PROVIDER_REJECTED');
    assert.equal(pending.some(r => r.id === oneoff.id), false);
    const history = await store.listForUser(userId, { includeRecent: true });
    assert.equal(history.find(r => r.id === oneoff.id).last_occurrence.status, 'accepted');
    assert.equal(history.find(r => r.id === oneoff.id).last_occurrence.receiptId, 'listing-receipt');
    assert.deepEqual(await store.listForUser(otherId, { includeRecent: true }), []);
    assert.equal(JSON.stringify(history).includes('claim_token'), false);
    await db.query("UPDATE mtr_harness.reminders SET created_at=now()-interval '40 days' WHERE id=$1", [oneoff.id]);
    await db.query("UPDATE mtr_harness.reminder_occurrences SET scheduled_at=now()-interval '40 days',finished_at=now()-interval '40 days' WHERE reminder_id=$1", [oneoff.id]);
    assert.equal((await store.listForUser(userId, { includeRecent: true })).some(r => r.id === oneoff.id), false);
  });

  await t.test('legacy rows are enrolled lazily; expired recurrence stops; deleted/archived owners are excluded', async () => {
    const runAt = new Date(Date.now() - 120_000).toISOString();
    const legacy = await db.query(`INSERT INTO mtr_harness.reminders(user_id,agent_id,message,run_at,initial_run_at,channel,repeat_every_min,repeat_until)
      VALUES ($1,$2,'legacy fixture',$3,$3,'email',1,$3) RETURNING *`, [userId, agentId, runAt]);
    const r = legacy.rows[0];
    assert.equal((await store.listOccurrences(userId, r.id)).length, 0);
    const claim = await store.claim(r);
    await store.begin(claim);
    const result = await store.finish(claim, { status: 'failed' });
    assert.equal(result.nextRun, null);
    assert.equal(result.reminderStatus, 'failed');

    const excluded = await create();
    await db.query('UPDATE mtr_harness.agents SET archived_at=now() WHERE id=$1', [agentId]);
    assert.equal(await store.claim(excluded), null);
    assert.equal((await store.listDue()).some(x => x.id === excluded.id), false);
    await db.query('UPDATE mtr_harness.agents SET archived_at=NULL WHERE id=$1', [agentId]);
    await db.query('UPDATE mtr_harness.users SET deleted_at=now() WHERE id=$1', [userId]);
    assert.equal(await store.claim(excluded), null);
    assert.equal((await store.listDue()).some(x => x.id === excluded.id), false);
  });
});

test('recurrence keeps interval anchor, skips backlog and honors inclusive end', () => {
  const r = { run_at: '2026-09-01T08:00:00Z', repeat_every_min: 2880 };
  assert.equal(nextReminderRun(r, '2026-09-30T12:00:00Z'), '2026-10-01T08:00:00.000Z');
  assert.equal(nextReminderRun({ ...r, repeat_until: '2026-10-01T08:00:00Z' }, '2026-09-30T12:00:00Z'), '2026-10-01T08:00:00.000Z');
  assert.equal(nextReminderRun({ ...r, repeat_until: '2026-10-01T07:59:59Z' }, '2026-09-30T12:00:00Z'), null);
  assert.equal(nextReminderRun({ ...r, repeat_every_min: 0 }, '2026-09-30T12:00:00Z'), null);
});
