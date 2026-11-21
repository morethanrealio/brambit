import test from 'node:test';
import assert from 'node:assert/strict';
import { settleConfirmedTurn, __continuationNote } from '../web/confirmation-continuation.mjs';

// Item 3 of the plan (2026-10-31): after a confirmed action executes, run one
// continuation model turn so a promised next step happens, keeping the receipt.

const agent = { id: 'a' };
const baseThread = () => ({ id: 't', history: [{ role: 'user', content: 'edit it' }], summary: '' });
const receipt = { text: 'Done: routine edited.', attachments: [{ name: 'r.pdf' }], executed: true };

function harness(overrides = {}) {
  const calls = { turns: [], saves: [] };
  const runTurn = overrides.runTurn || (async (_a, _t, _u, _m, opts) => {
    calls.turns.push(opts);
    return { text: 'And the summary is ready.', attachments: [{ name: 's.pdf' }], proposalIds: [1] };
  });
  const saveTurn = async (id, a, data) => { calls.saves.push({ id, data }); };
  const creditStatus = overrides.creditStatus || (async () => ({ over: false }));
  return { calls, runTurn, saveTurn, creditStatus };
}

test('with credit, an executed action runs the continuation and prepends the receipt', async () => {
  const h = harness();
  const out = await settleConfirmedTurn({ resolution: receipt, agent, thread: baseThread(), userId: 'u', message: 'go',
    opts: { kind: 'chat' }, runTurn: h.runTurn, saveTurn: h.saveTurn, creditStatus: h.creditStatus });
  assert.equal(h.calls.turns.length, 1, 'one continuation turn');
  assert.equal(h.calls.turns[0].confirmationManaged, true);
  assert.equal(h.calls.turns[0].confirmationNote, __continuationNote);
  assert.equal(out.text, 'Done: routine edited.\n\nAnd the summary is ready.');
  assert.deepEqual(out.attachments, [{ name: 'r.pdf' }, { name: 's.pdf' }]);
  assert.deepEqual(out.proposalIds, [1], 'a new proposal from the continuation is carried through');
  assert.equal(h.calls.saves.length, 0, 'the continuation turn persists itself; no extra save here');
});

test('no credit skips the continuation and just persists the receipt', async () => {
  const h = harness({ creditStatus: async () => ({ over: true }) });
  const out = await settleConfirmedTurn({ resolution: receipt, agent, thread: baseThread(), userId: 'u', message: 'go',
    opts: { kind: 'chat' }, runTurn: h.runTurn, saveTurn: h.saveTurn, creditStatus: h.creditStatus });
  assert.equal(h.calls.turns.length, 0, 'no model turn spent out of budget');
  assert.equal(out.text, receipt.text);
  assert.equal(h.calls.saves.length, 1, 'the receipt is persisted');
  assert.equal(h.calls.saves[0].data.assistantMsg, receipt.text);
});

test('a non-execution resolution (cancel/replay text) is just persisted', async () => {
  const h = harness();
  const resolution = { text: 'Canceled.', attachments: [] };
  const out = await settleConfirmedTurn({ resolution, agent, thread: baseThread(), userId: 'u', message: 'no',
    opts: { kind: 'chat' }, runTurn: h.runTurn, saveTurn: h.saveTurn, creditStatus: h.creditStatus });
  assert.equal(h.calls.turns.length, 0);
  assert.equal(out.text, 'Canceled.');
  assert.equal(h.calls.saves.length, 1);
});

test('webhook and tool-less turns never run a continuation', async () => {
  for (const opts of [{ webhook: {} }, { noTools: true }, { ephemeral: true }]) {
    const h = harness();
    await settleConfirmedTurn({ resolution: receipt, agent, thread: baseThread(), userId: 'u', message: 'go',
      opts, runTurn: h.runTurn, saveTurn: h.saveTurn, creditStatus: h.creditStatus });
    assert.equal(h.calls.turns.length, 0, JSON.stringify(opts));
    assert.equal(h.calls.saves.length, 1, JSON.stringify(opts));
  }
});

test('if the continuation turn throws, fall back to the receipt', async () => {
  const h = harness({ runTurn: async () => { throw new Error('model down'); } });
  const out = await settleConfirmedTurn({ resolution: receipt, agent, thread: baseThread(), userId: 'u', message: 'go',
    opts: { kind: 'chat' }, runTurn: h.runTurn, saveTurn: h.saveTurn, creditStatus: h.creditStatus });
  assert.equal(out.text, receipt.text);
  assert.equal(h.calls.saves.length, 1, 'the receipt is still persisted');
});

test('an empty continuation reply delivers just the receipt', async () => {
  const h = harness({ runTurn: async () => ({ text: '   ', attachments: [] }) });
  const out = await settleConfirmedTurn({ resolution: receipt, agent, thread: baseThread(), userId: 'u', message: 'go',
    opts: { kind: 'chat' }, runTurn: h.runTurn, saveTurn: h.saveTurn, creditStatus: h.creditStatus });
  assert.equal(out.text, receipt.text);
});

// Production, 2026-11: the action ran, its receipt was shown, and the
// continuation turn restated it ("Mensagem enviada ao colega ✅"). That turn has
// no receipt of its own (the proof stays with the confirmation), so the true
// sentence was cut and replaced by "Não consegui confirmar isso agora" right
// under the receipt. The turn now gets the receipt and falls back to it.
test('a continuation that only restates the confirmed action leaves the receipt, not a doubt', async () => {
  const { createActionJournal } = await import('../web/action-evidence.mjs');
  const shown = 'Mensagem enviada. Destino: colega.', restated = 'Mensagem enviada ao colega ✅';
  const doubt = /Não consegui confirmar/;
  assert.equal(createActionJournal({ shownReceipt: shown }).finish(restated), shown);
  assert.match(createActionJournal().finish(restated), doubt, 'any other turn keeps the doubt');
  // Text that claims nothing is kept, and a new action that failed in the
  // continuation still shows.
  const next = 'Amanhã cedo eu te lembro de conferir.';
  assert.equal(createActionJournal({ shownReceipt: shown }).finish(next), next);
  const j = createActionJournal({ shownReceipt: shown });
  j.toolResult({ name: 'criar_lembrete', args: { mensagem: 'conferir' } }, JSON.stringify({ ok: false }));
  assert.match(j.finish('Lembrete agendado para amanhã.'), /não foi concluída/);

  // The turn receives the receipt, and a reply that fell back to it is not doubled.
  const h = harness({ runTurn: async (_a, _t, _u, _m, opts) => ({ text: opts.confirmationReceipt, attachments: [] }) });
  const out = await settleConfirmedTurn({ resolution: receipt, agent, thread: baseThread(), userId: 'u', message: 'go',
    opts: { kind: 'chat' }, runTurn: h.runTurn, saveTurn: h.saveTurn, creditStatus: h.creditStatus });
  assert.equal(out.text, receipt.text);
});
