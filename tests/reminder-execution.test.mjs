// Real scheduler and executor, synthetic store/channels; no database or network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReminderExecutor } from '../web/reminder-execution.mjs';
import { startScheduler } from '../web/scheduler.mjs';

const reminder = {
  id: 'reminder-fixture', user_id: 'owner-fixture', agent_id: 'agent-fixture',
  channel: 'email', message: 'Synthetic reminder', run_at: '2026-09-20T10:00:00Z',
};
const accepted = { status: 'accepted', id: 'receipt-fixture', channel: 'email' };
function harness({ begin = true, finish = true } = {}) {
  let state = 'scheduled';
  const events = [];
  const store = {
    async claim(rem) {
      events.push('claim');
      if (state !== 'scheduled') return null;
      state = 'claimed';
      return { id: 'occurrence-fixture', reminderId: rem.id, userId: rem.user_id, token: 'token-fixture' };
    },
    async begin() { events.push('begin'); if (!begin) return false; state = 'delivering'; return true; },
    async finish(_claim, outcome) {
      events.push(['finish', outcome]);
      if (!finish) return null;
      state = outcome.status;
      return { status: state, nextRun: null };
    },
    async recoverExpired() { events.push('recover'); },
  };
  return { store, events, state: () => state };
}

test('records acceptance only after a valid provider receipt', async () => {
  const h = harness();
  const executor = createReminderExecutor(h.store, { deliver: async () => {
    assert.equal(h.state(), 'delivering');
    assert.equal(h.events.filter(event => Array.isArray(event)).length, 0);
    h.events.push('send');
    return accepted;
  } });
  const result = await executor.execute(reminder);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.receipt, { id: accepted.id, channel: accepted.channel });
  assert.deepEqual(h.events.slice(0, 3), ['claim', 'begin', 'send']);
  assert.equal(h.events[3][1].status, 'accepted');
});

test('two workers cannot dispatch the same claimed occurrence', async () => {
  const h = harness();
  let sends = 0;
  const dependencies = { deliver: async () => { sends++; return accepted; } };
  const a = createReminderExecutor(h.store, dependencies);
  const b = createReminderExecutor(h.store, dependencies);
  const results = await Promise.all([a.execute(reminder), b.execute(reminder)]);
  assert.equal(sends, 1);
  assert.deepEqual(results.map(result => result.status).sort(), ['accepted', 'skipped']);
});

test('canceled or expired claim cannot cross the dispatch fence', async () => {
  const h = harness({ begin: false });
  const executor = createReminderExecutor(h.store, { deliver: async () => assert.fail('must not send') });
  assert.deepEqual(await executor.execute(reminder), { status: 'skipped' });
  assert.deepEqual(h.events, ['claim', 'begin']);
});

test('definitive rejection and ambiguous failure are recorded without automatic replay', async () => {
  for (const definitive of [true, false]) {
    const h = harness();
    let sends = 0;
    const executor = createReminderExecutor(h.store, { deliver: async () => {
      sends++;
      throw Object.assign(Error('synthetic channel failure'), { definitive });
    } });
    const result = await executor.execute(reminder);
    assert.equal(result.status, definitive ? 'failed' : 'uncertain');
    assert.equal((await executor.execute(reminder)).status, 'skipped');
    assert.equal(sends, 1);
    assert.ok(!JSON.stringify(h.events).includes('synthetic channel failure'));
  }
});

test('missing, skipped, and mismatched receipts cannot claim acceptance', async () => {
  for (const [receipt, expected] of [
    [undefined, 'uncertain'], [{ status: 'accepted' }, 'uncertain'],
    [{ ...accepted, channel: 'telegram' }, 'uncertain'],
    [{ skipped: true }, 'failed'], [{ status: 'failed' }, 'failed'],
  ]) {
    const h = harness();
    const executor = createReminderExecutor(h.store, { deliver: async () => receipt });
    assert.equal((await executor.execute(reminder)).status, expected);
  }
});

test('persistence failure after acceptance never triggers another delivery or rejection write', async () => {
  const h = harness({ finish: false });
  let sends = 0;
  const executor = createReminderExecutor(h.store, { deliver: async () => { sends++; return accepted; } });
  await assert.rejects(executor.execute(reminder), { code: 'REMINDER_OUTCOME_UNRECORDED' });
  assert.equal((await executor.execute(reminder)).status, 'skipped');
  assert.equal(sends, 1);
  const writes = h.events.filter(Array.isArray);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1].status, 'accepted');
});

test('scheduler recovers before listing and isolates failures between reminders', async () => {
  const flow = [];
  const scheduler = startScheduler({
    listDueRoutines: async () => [],
    recoverReminderDeliveries: async () => flow.push('recover'),
    listDueReminders: async () => { flow.push('list'); return [reminder, { ...reminder, id: 'second' }]; },
    executeReminder: async rem => {
      flow.push(rem.id);
      if (rem.id === reminder.id) throw Error('synthetic persistence failure');
      return { status: 'accepted' };
    },
    markReminderSent: async () => assert.fail('legacy status write must not run'),
    rescheduleReminder: async () => assert.fail('recurrence belongs to the occurrence transaction'),
  }, { intervalMs: 1_000_000 });
  try { await scheduler.tick(); }
  finally { await scheduler.stop(); }
  assert.deepEqual(flow, ['recover', 'list', reminder.id, 'second']);
});

test('scheduler stop drains in-flight dispatch and starts no next reminder', async () => {
  let entered, release;
  const began = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const sends = [];
  const scheduler = startScheduler({
    listDueRoutines: async () => [],
    listDueReminders: async () => [reminder, { ...reminder, id: 'second' }],
    executeReminder: async rem => { sends.push(rem.id); entered(); await waiting; return { status: 'accepted' }; },
  }, { intervalMs: 1_000_000 });
  const tick = scheduler.tick();
  await began;
  let drained = false;
  const stopping = scheduler.stop().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release();
  await Promise.all([tick, stopping]);
  assert.equal(drained, true);
  assert.deepEqual(sends, [reminder.id]);
  await scheduler.tick();
  assert.deepEqual(sends, [reminder.id]);
});
