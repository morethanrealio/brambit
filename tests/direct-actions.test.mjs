import test from 'node:test';
import assert from 'node:assert/strict';
import { gateTool, hasPending, takePending } from '../web/confirm.mjs';
import { turnGate } from '../web/direct-actions.mjs';

// The owner's own action runs when asked; anything that reaches another person,
// or a channel where the owner is not the one typing, keeps the card.
function calendar(threadId, calls) {
  return gateTool({ name: 'calendar_create', run: async (args) => { calls.push(args); return { ok: true }; } }, threadId);
}

test('an event with no guests runs directly in the owner chat; guests, other channels and team assistants keep the card', async (t) => {
  const ids = ['direct-solo', 'direct-guests', 'direct-email', 'direct-team'];
  t.after(() => ids.forEach((id) => takePending(id)));
  const calls = [];
  const event = { summary: 'Dentist', start: '2026-10-22T14:00:00' };

  assert.deepEqual(await turnGate(calendar(ids[0], calls), { kind: 'telegram', threadId: ids[0] }).run(event), { ok: true });
  assert.equal(hasPending(ids[0]), false);

  await turnGate(calendar(ids[1], calls), { kind: 'chat', threadId: ids[1] }).run({ ...event, attendees: 'ana@example.com' });
  await turnGate(calendar(ids[2], calls), { kind: 'email', threadId: ids[2] }).run(event);
  await turnGate(calendar(ids[3], calls), { kind: 'chat', threadId: ids[3], agentCategory: 'grupo' }).run(event);
  assert.equal(calls.length, 1);
  for (const id of ids.slice(1)) assert.equal(hasPending(id), true, id);
});

test('a note runs directly only in a Space the owner has to themselves', async (t) => {
  const ids = ['note-private', 'note-shared', 'note-lookup-failed'];
  t.after(() => ids.forEach((id) => takePending(id)));
  const calls = [];
  const note = { name: 'anotar_no_espaco', run: async (args) => { calls.push(args); return { ok: true }; } };
  const spaces = [async () => true, async () => false, async () => { throw new Error('db down'); }];

  for (const [i, privateSpace] of spaces.entries()) {
    await turnGate(note, { kind: 'chat', threadId: ids[i], privateSpace }).run({ espaco: 'trip', texto: 'passport' });
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(ids.map(hasPending), [false, true, true]);
});

// The app tools reach the turn already wrapped (addGated). Asking who can open
// the app gives the login back, so only the owner gets it without a card;
// locking, a new password and opening the app to anyone always wait for one.
test('checking an app\'s access runs directly only for the owner; changing it always keeps the card', async (t) => {
  const ids = ['access-check', 'access-lock', 'access-new-password', 'access-open', 'access-email', 'access-team'];
  t.after(() => ids.forEach((id) => takePending(id)));
  const calls = [];
  const state = { ok: true, acesso: 'privado', credenciais: { usuario: 'planner', senha: 'example-pass' } };
  const access = (threadId) => gateTool({ name: 'definir_acesso_sistema', run: async (args) => { calls.push(args); return state; } }, threadId);
  const app = { nome_do_sistema: 'planner' };

  assert.deepEqual(await turnGate(access(ids[0]), { kind: 'telegram', threadId: ids[0] }).run(app), state);
  assert.equal(hasPending(ids[0]), false);

  await turnGate(access(ids[1]), { kind: 'telegram', threadId: ids[1] }).run({ ...app, acesso: 'privado' });
  await turnGate(access(ids[2]), { kind: 'chat', threadId: ids[2] }).run({ ...app, acesso: 'privado', nova_senha: true });
  await turnGate(access(ids[3]), { kind: 'whatsapp', threadId: ids[3] }).run({ ...app, acesso: 'publico', confirmo_publico: true });
  await turnGate(access(ids[4]), { kind: 'email', threadId: ids[4] }).run(app);
  await turnGate(access(ids[5]), { kind: 'chat', threadId: ids[5], agentCategory: 'grupo' }).run(app);
  assert.equal(calls.length, 1);
  for (const id of ids.slice(1)) assert.equal(hasPending(id), true, id);
});
