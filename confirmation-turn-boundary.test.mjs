import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_CTX_END,
  deferIncomingWhileConfirmationPending,
  gateTool,
  hasPending,
  isConfirmation,
  takePending,
} from './web/confirm.mjs';
import { isPauseOnlyRoutineChange } from './web/scheduler.mjs';

test('confirmação que chega durante o turno fica para a fronteira segura e executa uma vez', async (t) => {
  const threadId = 'confirmation-mid-turn';
  t.after(() => takePending(threadId));
  let executions = 0;
  const gated = gateTool({
    name: 'publicar_sistema',
    run: async () => { executions++; return { ok: true }; },
  }, threadId);

  await gated.run({ nome_do_sistema: 'demo' });
  assert.equal(hasPending(threadId), true);

  const quotedConfirmation = `[Contexto da mensagem citada]${CHANNEL_CTX_END}\n\nPode`;
  let queued = { text: quotedConfirmation };
  let polls = 0;
  const destructivePoll = async () => { polls++; const value = queued; queued = null; return value; };
  const safePoll = deferIncomingWhileConfirmationPending(threadId, destructivePoll);

  assert.equal(await safePoll(), null);
  assert.equal(polls, 0, 'a mensagem não pode ser consumida pelo turno em andamento');
  assert.ok(queued, 'o adaptador ainda deve possuir a mensagem para o próximo turno');
  assert.equal(executions, 0);

  const nextTurn = await destructivePoll();
  assert.equal(isConfirmation(nextTurn.text), true);
  const pending = takePending(threadId);
  assert.ok(pending);
  await pending.run(pending.args);
  assert.equal(executions, 1);
  assert.equal(await destructivePoll(), null);
  assert.equal(executions, 1, 'não pode haver publicação duplicada');
});

test('mensagem comum continua entrando no turno quando não há confirmação pendente', async () => {
  let polls = 0;
  const safePoll = deferIncomingWhileConfirmationPending('ordinary-interjection', async () => {
    polls++;
    return { text: 'na verdade, ajuste também a cor' };
  });
  assert.deepEqual(await safePoll(), { text: 'na verdade, ajuste também a cor' });
  assert.equal(polls, 1);
});

test('recusa também permanece para o próximo turno sem executar a ação', async (t) => {
  const threadId = 'cancellation-mid-turn';
  t.after(() => takePending(threadId));
  let executions = 0;
  await gateTool({ name: 'publicar_sistema', run: async () => { executions++; } }, threadId).run({});
  let queued = { text: 'Não, cancela.' };
  let polls = 0;
  const destructivePoll = async () => { polls++; const value = queued; queued = null; return value; };
  const safePoll = deferIncomingWhileConfirmationPending(threadId, destructivePoll);

  assert.equal(await safePoll(), null);
  assert.equal(polls, 0);
  const nextTurn = await destructivePoll();
  assert.equal(isConfirmation(nextTurn.text), false);
  takePending(threadId); // the start-of-turn gate cancels the pending request
  assert.equal(executions, 0);
});

test('pausa simples de rotina executa direto, mas retomada ou edição continuam gated', async (t) => {
  const ids = ['pause-inline', 'resume-gated', 'pause-plus-edit'];
  t.after(() => ids.forEach((id) => takePending(id)));
  const calls = [];
  const tool = {
    name: 'editar_rotina',
    runWithoutConfirmation: isPauseOnlyRoutineChange,
    preflight: async () => ({ aviso: 'rotina localizada' }),
    run: async (args) => { calls.push(args); return { ok: true }; },
  };

  const paused = await gateTool(tool, ids[0]).run({ id: '823c', ativa: false });
  assert.deepEqual(paused, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(hasPending(ids[0]), false);

  await gateTool(tool, ids[1]).run({ id: '823c', ativa: true });
  assert.equal(calls.length, 1);
  assert.equal(hasPending(ids[1]), true);

  await gateTool(tool, ids[2]).run({ id: '823c', ativa: false, hora: 9 });
  assert.equal(calls.length, 1);
  assert.equal(hasPending(ids[2]), true);
});
