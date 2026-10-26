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
