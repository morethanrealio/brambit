import test from 'node:test';
import assert from 'node:assert/strict';
import { reminderHistoryText } from './web/reminder-history.mjs';

const row = { message: 'Synthetic reminder', channel: 'whatsapp', status: 'pending',
  run_at: '2026-09-21T12:00:00Z', repeat_every_min: 1440 };
test('recurring schedule retains the last failed occurrence separately from the next slot', () => {
  const text = reminderHistoryText([{ ...row, last_occurrence: {
    status: 'failed', scheduledAt: '2026-09-20T12:00:00Z',
  } }]);
  assert.match(text, /agendado; previsto para 21\/09\/2026, 09:00/);
  assert.match(text, /Último registro: 20\/09\/2026, 09:00: envio falhou/);
  assert.match(text, /não será repetida automaticamente/);
});
test('acceptance and legacy sent records never promise delivered or read', () => {
  const accepted = reminderHistoryText([{ ...row, status: 'sent', last_occurrence: {
    status: 'accepted', scheduledAt: row.run_at, receiptId: 'private-fixture-id',
  } }], { includeRecent: true });
  assert.match(accepted, /aceito pelo canal; não comprova entrega nem leitura/);
  assert.doesNotMatch(accepted, /private-fixture-id/);
  assert.match(reminderHistoryText([{ ...row, status: 'sent' }]), /registro antigo sem recibo/);
});
test('uncertain outcomes tell the owner to verify before a new send', () => {
  assert.match(reminderHistoryText([{ ...row, status: 'uncertain', last_occurrence: {
    status: 'uncertain', scheduledAt: row.run_at,
  } }]), /confira o canal antes de pedir novo envio/);
});
test('empty results distinguish pending-only and recent history queries', () => {
  assert.match(reminderHistoryText([]), /nenhum lembrete pendente/);
  assert.match(reminderHistoryText([], { includeRecent: true }), /histórico nos últimos 30 dias/);
});
