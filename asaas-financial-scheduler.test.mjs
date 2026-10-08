import assert from 'node:assert/strict';
import { asaasAuthorizationHash, asaasBillScheduleHash } from './web/connectors-vault.mjs';
import { createAsaasFinancialScheduler, processAsaasWithdrawalAuthorization } from './web/asaas-financial-scheduler.mjs';

let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const ok = (v, label) => { assert.ok(v, label); checks++; };

const bill = {
  object: 'bill', id: 'bill-auth-1', status: 'PENDING', value: 42,
  identificationField: '123456789', dueDate: '2026-09-25', scheduleDate: '2026-09-18',
  description: 'Conta teste', awaitingCriticalActionAuthorization: true,
};

{
  let called = 0;
  const r = await processAsaasWithdrawalAuthorization({
    payload: { type: 'BILL', bill }, token: 'wrong', expectedToken: 'secret',
    decide: async () => { called++; return { approved: true }; },
  });
  eq(r.httpStatus, 401, 'wrong token gets 401');
  eq(r.body.status, 'REFUSED', 'wrong token never approves');
  eq(called, 0, 'wrong token does not query intent');
}

{
  const expected = asaasAuthorizationHash({ type: 'BILL', bill });
  const r = await processAsaasWithdrawalAuthorization({
    payload: { type: 'BILL', bill }, token: 'secret', expectedToken: 'secret',
    decide: async (d) => ({ approved: d.providerOperationId === bill.id && d.payloadHash === expected }),
  });
  eq(r.body.status, 'APPROVED', 'exact payload and known intent are approved');
}

{
  const r = await processAsaasWithdrawalAuthorization({
    payload: { type: 'BILL', bill: { ...bill, value: 4200 } }, token: 'secret', expectedToken: 'secret',
    decide: async () => ({ approved: false, reason: 'payload_mismatch' }),
  });
  eq(r.body.status, 'REFUSED', 'divergent value is refused');
  ok(/payload_mismatch/.test(r.body.refuseReason), 'refusal is auditable');
}

const args = { linha_digitavel: '123.456.789', valor: 42, descricao: 'Conta teste' };
const simulation = {
  minimumScheduleDate: '2026-09-18',
  bankSlipInfo: {
    value: 42, dueDate: '2026-09-25', beneficiaryName: 'Empresa Teste',
    beneficiaryCpfCnpj: '12345678000199', allowChangeValue: true, minValue: 1, maxValue: 100,
  }, fee: 0,
};
const summary = {
  valor: 42, vencimento: '2026-09-25', beneficiario: 'Empresa Teste',
  cpf_cnpj_beneficiario: '12345678000199', empresa: null, vencido: false,
  permite_alterar_valor: true, valor_min: 1, valor_max: 100, taxa_asaas: 0,
  data_minima_pagamento: '2026-09-18',
};
const row = {
  id: 'schedule-1', owner_user_id: 'owner-1', agent_id: 'agent-1', thread_id: 'thread-1',
  account_id: 'account-1', origin_channel: 'web', execute_on: '2026-09-18',
  payload: args, expected_hash: asaasBillScheduleHash(args, summary), external_reference: 'brambs-bill-fixed',
};

{
  const calls = [];
  const finished = [];
  const intents = [];
  const operations = [];
  const scheduler = createAsaasFinancialScheduler({
    claimDue: async () => [],
    finish: async (id, data) => { finished.push({ id, ...data }); return { id, status: data.status }; },
    getCredential: async () => ({ key: 'fixture', accountId: 'account-1', contaBrambs: true }),
    ensureWebhook: async () => {},
    saveIntent: async (owner, data) => { intents.push({ owner, ...data }); },
    saveOperation: async (owner, data) => { operations.push({ owner, ...data }); },
    notify: async () => {},
    requestForCredential: async (_key, path, opts = {}) => {
      calls.push({ path, opts });
      if (path === '/v3/bill/simulate') return simulation;
      if (path === '/v3/bill') return { ...bill, externalReference: 'brambs-bill-fixed' };
      throw new Error(`request inesperado: ${path}`);
    },
  });
  await scheduler.processOne(row);
  eq(calls.map((c) => c.path), ['/v3/bill/simulate', '/v3/bill'], 'execution double checks and makes one POST');
  const posted = calls.at(-1).opts.body;
  eq(posted.scheduleDate, '2026-09-18', 'worker fixes the first date accepted by the day simulation');
  eq(posted.externalReference, 'brambs-bill-fixed', 'POST preserves the schedule idempotency key');
  eq(intents.length, 1, 'real response creates an authorization intent');
  eq(intents[0].providerOperationId, bill.id, 'intent is linked to the Asaas id');
  eq(operations.length, 1, 'operation is linked to the original conversation');
  eq(finished.at(-1).status, 'awaiting_authorization', 'official critical authorization field is recognized');
}

{
  const changed = structuredClone(simulation);
  changed.bankSlipInfo.beneficiaryName = 'Outra Empresa';
  const calls = [];
  const finished = [];
  const scheduler = createAsaasFinancialScheduler({
    claimDue: async () => [], finish: async (_id, data) => finished.push(data),
    getCredential: async () => ({ key: 'fixture', accountId: 'account-1' }),
    requestForCredential: async (_key, path) => { calls.push(path); return changed; },
    saveIntent: async () => { throw new Error('não deveria'); },
    saveOperation: async () => { throw new Error('não deveria'); },
    notify: async () => {},
  });
  await scheduler.processOne(row);
  eq(calls, ['/v3/bill/simulate'], 'change blocks before the POST');
  eq(finished.at(-1).status, 'needs_review', 'change requires a new human review');
}

console.log(`PASS ${checks}: agenda interna e autorização de saque Asaas; offline only.`);
