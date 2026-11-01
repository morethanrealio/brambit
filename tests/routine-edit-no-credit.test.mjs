import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoCreditEditRoutineTool } from '../web/routine-edit-no-credit.mjs';
import { createRoutineSelect } from '../web/routine-select.mjs';

// The no-credit routine-management turn (server.mjs) now carries a narrow
// editar_rotina. These cover the field building, the no-op guard, resume, channel
// validation and the confirmation snapshot the full tool also enforces.

const { routineCadence, resolveRoutine } = createRoutineSelect({ userTz: 'America/Sao_Paulo' });

function harness(row, overrides = {}) {
  const calls = { update: [] };
  const base = {
    userId: 'u1',
    listRoutines: async () => (row ? [row] : []),
    updateRoutine: async (id, userId, fields) => { calls.update.push({ id, userId, fields }); return { ok: true, routine: { ...row, ...fields } }; },
    resolveRoutine,
    routineCadence,
    ...overrides,
  };
  return { calls, tool: createNoCreditEditRoutineTool(base) };
}

const ROUTINE = { id: 'abcd1234', title: 'resumo diário', hour: 7, minute: 0, days: 'daily', channel: 'whatsapp', enabled: true };

test('pause runs without a card; any other change is gated', () => {
  const { tool } = harness(ROUTINE);
  assert.equal(tool.runWithoutConfirmation({ ativa: false, titulo: 'x' }), true);
  assert.equal(tool.runWithoutConfirmation({ hora: 9 }), false);
  assert.equal(tool.runWithoutConfirmation({ ativa: true }), false);
});

test('a time change builds the fields and applies only what differs', async () => {
  const { calls, tool } = harness(ROUTINE);
  const out = await tool.run({ titulo: 'resumo', hora: 9 });
  assert.equal(out.ok, true);
  assert.equal(calls.update.length, 1);
  // minute already 0, so it's stripped as a no-op; only the hour is written.
  assert.deepEqual(calls.update[0].fields, { hour: 9 });
  assert.match(out.saida, /Agora roda/);
});

test('resume sets enabled true', async () => {
  const { calls, tool } = harness({ ...ROUTINE, enabled: false });
  const out = await tool.run({ titulo: 'resumo', ativa: true });
  assert.equal(out.ok, true);
  assert.equal(calls.update[0].fields.enabled, true);
});

test('a channel change to the same channel is a no-op, not a false receipt', async () => {
  const { calls, tool } = harness(ROUTINE);
  const out = await tool.run({ titulo: 'resumo', canal: 'whatsapp' });
  assert.equal(out.ok, false);
  assert.match(out.error, /Nada mudou/);
  assert.equal(calls.update.length, 0);
});

test('switching the channel to app maps to none', async () => {
  const { calls, tool } = harness(ROUTINE);
  const out = await tool.run({ titulo: 'resumo', canal: 'app' });
  assert.equal(out.ok, true);
  assert.equal(calls.update[0].fields.channel, 'none');
});

test('an unknown channel is refused', async () => {
  const { tool } = harness(ROUTINE);
  const out = await tool.run({ titulo: 'resumo', canal: 'sms' });
  assert.equal(out.ok, false);
  assert.match(out.error, /não reconhecido/);
});

test('no change passed is refused', async () => {
  const { tool } = harness(ROUTINE);
  const out = await tool.run({ titulo: 'resumo' });
  assert.equal(out.ok, false);
  assert.match(out.error, /nenhuma mudança/);
});

test('no routines to edit is reported', async () => {
  const { tool } = harness(null);
  const out = await tool.run({ titulo: 'resumo' });
  assert.equal(out.ok, false);
  assert.match(out.error, /nenhuma rotina/);
});

test('normalizeConfirmationArgs binds the id and an expected snapshot', async () => {
  const { tool } = harness(ROUTINE);
  const norm = await tool.normalizeConfirmationArgs({ titulo: 'resumo', hora: 9 });
  assert.equal(norm.args.id, ROUTINE.id);
  assert.ok(norm.args.expected, 'carries a confirmation snapshot');
});

test('preflight refuses an invalid hour before any card', async () => {
  const { tool } = harness(ROUTINE);
  const pf = await tool.preflight({ titulo: 'resumo', hora: 99 });
  assert.ok(pf.erro);
  assert.match(pf.erro, /Hora inválida/);
});

test('preflight catches a routine that changed since the proposal', async () => {
  const { tool } = harness(ROUTINE);
  const pf = await tool.preflight({ titulo: 'resumo', hora: 9, expected: { hour: 5 } });
  assert.ok(pf.erro);
  assert.match(pf.erro, /mudou desde a proposta/);
});
