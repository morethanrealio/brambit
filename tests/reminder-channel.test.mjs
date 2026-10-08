import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reminderChannelSelection } from '../web/reminder-channel.mjs';
import { actionResult, createActionJournal } from '../web/action-evidence.mjs';

const source = readFileSync(new URL('../web/server.mjs', import.meta.url), 'utf8');
const start = source.indexOf("    name: 'criar_lembrete'");
const literal = '{' + source.slice(start, source.indexOf('\n  });', start)) + '\n}';
function fixture({ kind = 'chat', message = 'Me lembra daqui a dez minutos neste canal', telegram = true, whatsapp = false, email = true, saved = () => true } = {}) {
  const writes = [];
  const deps = { kind, message, routineChannel: null, reminderChannelSelection,
    userId: 'u', agent: { id: 'a' }, thread: { id: 't' }, userTz: 'UTC', recurrenceSchema: {},
    getTelegramBotForDelivery: async () => telegram ? { chat_id: 'tg' } : null,
    waEnabled: () => whatsapp, getWhatsAppLinkForUser: async () => whatsapp ? { wa_phone: 'wa', enabled: true } : null,
    mailEnabled: () => email, getUserById: async () => email ? { email: 'user@example.invalid' } : null,
    resolveReminderWhen: value => new Date(value), parseRecurrence: () => null, randomUUID: () => 'action', actionResult,
    createReminder: async row => { writes.push(row); return saved(writes.length) ? { id: 'r', run_at: row.runAt, channel: row.channel, status: 'pending' } : null; },
  };
  return { tool: new Function(...Object.keys(deps), 'return ' + literal)(...Object.values(deps)), writes };
}
const args = { quando: '2099-10-15T10:00:00Z', mensagem: 'Conferir teste' };

test('chat without delivery and no chosen channel asks, listing only connected channels', async () => {
  const s = fixture(); const result = await s.tool.run(args);
  assert.match(result, /Ainda não consigo entregar lembretes neste canal/);
  assert.match(result, /Telegram e e-mail disponíveis/);
  assert.doesNotMatch(result, /WhatsApp disponível/);
  assert.deepEqual(s.writes, []);
});

test('the channel chosen by the model is used, including from a chat without delivery', async () => {
  // Eval 2026-09-28 (#35): "aqui pelo telegram", said in the web chat, is a request for Telegram.
  const s = fixture({ message: 'me lembra aqui pelo telegram' });
  JSON.parse(await s.tool.run({ ...args, canal: 'telegram' }));
  assert.equal(s.writes.length, 1); assert.equal(s.writes[0].channel, 'telegram');
});

test('a chosen but disconnected channel is refused without writes', async () => {
  const s = fixture({ message: 'Me lembre por email amanhã', telegram: false, email: false });
  const result = await s.tool.run({ ...args, canal: 'email' });
  assert.match(result, /Nada foi agendado/); assert.equal(s.writes.length, 0);
});

test('user can choose a connected alternative and the actual chosen channel is persisted', async () => {
  const s = fixture({ message: 'Pode ser pelo meu e-mail' });
  const result = JSON.parse(await s.tool.run({ ...args, canal: 'email' }));
  assert.equal(s.writes.length, 1); assert.equal(s.writes[0].channel, 'email');
  assert.equal(result.action_evidence.target, 'e-mail');
});

test('without a chosen channel, a supported conversation channel stays there', async () => {
  const s = fixture({ kind: 'whatsapp', whatsapp: true });
  await s.tool.run(args);
  assert.equal(s.writes[0].channel, 'whatsapp');
});

test('selected but disconnected transport is refused without writes', async () => {
  const s = fixture({ message: 'Me lembra por e-mail', email: false });
  assert.match(await s.tool.run({ ...args, canal: 'email' }), /Nada foi agendado/); assert.equal(s.writes.length, 0);
});

test('selection only validates the proposed channel; it does not reread the owner text', () => {
  assert.equal(reminderChannelSelection({ kind: 'chat', requested: 'telegram' }).channel, 'telegram');
  assert.equal(reminderChannelSelection({ kind: 'chat', requested: 'e-mail' }).channel, 'email');
  assert.equal(reminderChannelSelection({ kind: 'chat', requested: 'slack' }).channel, null);
  assert.equal(reminderChannelSelection({ kind: 'chat' }).channel, null);
  assert.equal(reminderChannelSelection({ kind: 'email' }).channel, 'email');
  assert.equal(reminderChannelSelection({ kind: 'routine', routineChannel: 'telegram' }).channel, 'telegram');
});

// Test from 2026-10-02: in the web chat, the 1st call without a channel is
// refused before saving; the model redoes it with the e-mail channel and succeeds. The
// final reply said "Pronto. Não consegui confirmar isso agora..." on top of the
// scheduled reminder. Refusal before saving = correct failure, and the 2nd attempt for the
// SAME reminder replaces it. Uncertainty after saving remains visible.
const unknownPt = 'Não consegui confirmar isso agora';
const failedPt = 'A ação não foi concluída';
async function turn(s, calls) {
  const j = createActionJournal(); const refs = [];
  for (const a of calls) refs.push(JSON.parse(j.toolResult({ id: 'c', name: 'criar_lembrete', args: a }, await s.tool.run(a))).confirmation_ref);
  return { j, refs };
}
const ruffy = { quando: '2099-10-02T23:17:00Z', mensagem: 'teste de rotina.' };

test('pre-write refusal is a structured failure; the model still reads the same text', async () => {
  const s = fixture(); const d = JSON.parse(await s.tool.run(ruffy));
  assert.equal(d.ok, false); assert.match(d.error, /^Ainda não consigo entregar lembretes neste canal\. Nada foi agendado\./);
  assert.equal(s.writes.length, 0);
});

test('a refused attempt redone successfully in the same turn does not leak into the reply', async () => {
  for (const text of ['Pronto. Lembrete agendado para as 23h17 no seu e-mail.', 'Pronto.', 'Pronto. REF2', 'REF1 REF2']) {
    const s = fixture(); const { j, refs } = await turn(s, [ruffy, { ...ruffy, canal: 'email' }]);
    const out = j.finish(text.replace('REF1', refs[0]).replace('REF2', refs[1]));
    assert.equal(s.writes.length, 1);
    assert.match(out, /Lembrete agendado, não enviado\. Destino: e-mail/);
    assert.ok(!out.includes(unknownPt), out); assert.ok(!out.includes(failedPt), out);
    assert.equal(j.entries.length, 2); assert.equal(j.entries[0].state, 'failed'); // evidence preserved
  }
});

test('a refusal never becomes success when there is no successful retry', async () => {
  const s = fixture(); const { j } = await turn(s, [ruffy]);
  const out = j.finish('Pronto. Lembrete agendado para as 23h17.');
  assert.ok(!/Lembrete agendado/.test(out), out); assert.match(out, new RegExp(failedPt));
});

test('a refused DIFFERENT reminder stays visible next to another success', async () => {
  const s = fixture(); const { j } = await turn(s, [ruffy, { quando: '2099-10-03T08:00:00Z', mensagem: 'Outro lembrete', canal: 'email' }]);
  const out = j.finish('Pronto.');
  assert.match(out, /Lembrete agendado/); assert.match(out, new RegExp(failedPt));
});

test('uncertainty after the write is not hidden by a later success', async () => {
  // 1st save without proof (createReminder without id): it may have saved; the 2nd succeeds.
  const s = fixture({ saved: n => n > 1 }); const { j } = await turn(s, [{ ...ruffy, canal: 'email' }, { ...ruffy, canal: 'email' }]);
  const out = j.finish('Pronto.');
  assert.equal(s.writes.length, 2); assert.match(out, /Lembrete agendado/); assert.match(out, new RegExp(unknownPt));
});
