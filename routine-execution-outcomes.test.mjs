// Executor real, persistência simulada: nenhum banco, canal ou inicializador.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoutineExecutor, routineExecutionInfo } from './web/routine-execution.mjs';

const routine = { id: 'routine-fixture', user_id: 'owner-fixture' };
function harness({ failFirstFinish = false } = {}) {
  let state;
  const store = {
    async claim(_r, slot, token) {
      if (state?.status === 'running' || state?.slot === slot) return false;
      state = { slot, token, status: 'running', phase: 'preparing' };
      return true;
    },
    async phase(_r, token, phase) {
      if (state.token !== token || state.status !== 'running') return false;
      state.phase = phase;
      return true;
    },
    async finish(_r, token, status, outcome = {}) {
      if (failFirstFinish) { failFirstFinish = false; throw Error('synthetic storage failure'); }
      if (state.token !== token || state.status !== 'running') return false;
      state = { ...state, ...structuredClone(outcome), status, phase: 'finished' };
      return true;
    },
    async recoverExpired() {},
  };
  return { executor: createRoutineExecutor(store), state: () => state };
}

test('definitive rejection preserves generated content and records failed delivery', async () => {
  const h = harness();
  let runs = 0;
  await assert.rejects(h.executor.execute(routine, {
    slot: 'day:fixture', run: async () => { runs++; return 'Synthetic report'; },
    deliver: async () => { throw Object.assign(Error('synthetic refusal'), { definitive: true }); },
  }));
  assert.equal(h.state().status, 'failed');
  assert.equal(h.state().content.status, 'complete');
  assert.equal(h.state().delivery.status, 'failed');
  await assert.rejects(h.executor.execute(routine, { slot: 'day:fixture', run: async () => runs++ }), { code: 'ROUTINE_BUSY' });
  assert.equal(runs, 1);
});

test('explicit failed receipt differs from uncertain network failure', async () => {
  for (const definitive of [true, false]) {
    const h = harness();
    await assert.rejects(h.executor.execute(routine, {
      slot: 'day:fixture', run: async () => 'Synthetic report',
      deliver: async () => {
        if (definitive) return { status: 'failed', channel: 'email' };
        throw Error('synthetic network timeout');
      },
    }));
    assert.equal(h.state().status, definitive ? 'failed' : 'uncertain');
    assert.equal(h.state().delivery.status, definitive ? 'failed' : 'uncertain');
  }
});

test('missing delivery outcome cannot complete an execution', async () => {
  for (const receipt of [undefined, { skipped: true }, { status: 'unknown' }]) {
    const h = harness();
    await assert.rejects(h.executor.execute(routine, {
      slot: 'day:fixture', run: async () => 'Synthetic report', deliver: async () => receipt,
    }));
    assert.equal(h.state().status, 'uncertain');
    assert.equal(h.state().delivery.status, 'uncertain');
  }
});

test('receipt accepted before a storage failure remains recorded as accepted', async () => {
  const h = harness({ failFirstFinish: true });
  await assert.rejects(h.executor.execute(routine, {
    slot: 'day:fixture', run: async () => 'Synthetic report',
    deliver: async () => ({ status: 'accepted', channel: 'email', id: 'receipt-fixture' }),
  }));
  assert.equal(h.state().delivery.status, 'accepted');
  assert.equal(h.state().delivery.id, 'receipt-fixture');
});

test('interrupt during dispatch preserves content and uncertain delivery', async () => {
  const h = harness();
  let begin, release;
  const began = new Promise(resolve => { begin = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const execution = h.executor.execute(routine, {
    slot: 'day:fixture', run: async () => 'Synthetic report',
    deliver: async () => { begin(); await waiting; return { status: 'accepted', id: 'receipt-fixture' }; },
  });
  await began;
  await h.executor.interrupt();
  assert.equal(h.state().status, 'interrupted');
  assert.equal(h.state().content.status, 'complete');
  assert.equal(h.state().delivery.status, 'uncertain');
  release();
  await assert.rejects(execution);
  assert.equal(h.state().status, 'interrupted');
});

test('expired sending lease displays uncertain rather than missing delivery', () => {
  const result = routineExecutionInfo({ config: { execution: {
    status: 'running', phase: 'delivering', leaseUntil: '2000-01-01T00:00:00Z',
  } } });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.delivery.status, 'uncertain');
});
