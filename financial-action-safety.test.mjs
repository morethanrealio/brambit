// Offline guardrail for Asaas financial actions.
// Proves three contracts:
// 1. no financial mutation runs before textual confirmation;
// 2. the Pix key confirmation states the effect and the data exposure;
// 3. an isolated balance is never accepted as proof of a deposit.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asaasTools } from './web/connectors-vault.mjs';
import {
  gateTool, takePending, renderConfirmed, setOwnerText, GATED_TOOLS, IRREVERSIBLE_TOOLS,
} from './web/confirm.mjs';

// Clock fixed at 2026-09-18 (date the fixtures were written): the
// synthetic invoices are due 2026-09-20, a Sunday, and the product's "date already
// passed" rule is real. Without freezing the day, the test turns into a time bomb.
const RealDate = Date;
const FIXED_NOW = RealDate.parse('2026-09-18T15:00:00Z');
const realStart = RealDate.now();
globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW + (RealDate.now() - realStart)])); }
  static now() { return FIXED_NOW + (RealDate.now() - realStart); }
};

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const response = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
});

const originalFetch = globalThis.fetch;
const withFetch = async (answers, fn) => {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    if (!answers.length) throw new Error(`fetch inesperado: ${url}`);
    return response(answers.shift());
  };
  try { return await fn(calls); }
  finally { globalThis.fetch = originalFetch; }
};

const tools = () => asaasTools({ secret: async () => '$aact_hmlg_fixture' });
const named = (list, name) => {
  const tool = list.find((x) => x.name === name);
  assert.ok(tool, `tool ${name} missing`);
  return tool;
};

// The wiring and the gate need to agree. If someone adds an Asaas action and
// forgets one of the two places, this incident comes back.
for (const name of ['asaas_receber_pix', 'asaas_pagar_conta', 'asaas_cancelar_pagamento_conta', 'asaas_transferir_pix', 'asaas_enviar_comprovante_email']) {
  ok(GATED_TOOLS.has(name), `${name} needs to be in the gate`);
  ok(IRREVERSIBLE_TOOLS.has(name), `${name} requires text, a reaction is not enough`);
}
const server = readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
ok(/VAULT_WRITE_TOOLS[\s\S]*asaas_receber_pix/.test(server), 'receiving Pix must be registered through the gated path');
ok(/VAULT_WRITE_TOOLS[\s\S]*asaas_cancelar_pagamento_conta/.test(server), 'cancellation must be registered through the gated path');
// The deterministic card always goes in full at the end of the response; the model's text
// stays above it, but it's the card that ties down the approval (2026-09-29).
ok(/peekPending\(thread\.id\)\?\.confirmationText[\s\S]*if \(deterministicConfirmation\) text = \[[^\n]*, deterministicConfirmation\]/.test(server), 'deterministic financial confirmation closes the response');
ok(/EVERY financial action[\s\S]*asaas_receber_pix[\s\S]*confirmation in TEXT/.test(server), 'prompt requires confirmation for every financial action');
ok(!/asaas_receber_pix:[^\n]*não precisa de confirmação/.test(server), 'prompt does not contain the old exception for receiving Pix');

// Defense in depth: even if someone registers the raw tool by mistake,
// run() cannot do a POST. Only the prepared and confirmed closure can mutate.
await withFetch([], async (calls) => {
  for (const name of ['asaas_receber_pix', 'asaas_pagar_conta', 'asaas_cancelar_pagamento_conta', 'asaas_transferir_pix', 'asaas_enviar_comprovante_email']) {
    const out = JSON.parse(await named(tools(), name).run({
      valor: 10, chave_pix: 'fixture', tipo_chave: 'EVP', linha_digitavel: '123', id: 'bill-fixture',
    }));
    eq(out.ok, false, `${name} called directly must refuse`);
    ok(/confirmação explícita/i.test(out.error), `${name} explains the confirmation`);
  }
  eq(calls.length, 0, 'no network call on the direct call');
});

// The receipt sent by email is assembled with data re-read from Asaas and only
// goes out after textual confirmation. The model does not choose the link, amount, or body.
await withFetch([
  { id: 'pix-receipt-1', status: 'DONE', value: 73.4, effectiveDate: '2026-09-16', transactionReceiptUrl: 'https://www.asaas.com/comprovantes/fixture-1' },
  { id: 'pix-receipt-1', status: 'DONE', value: 73.4, effectiveDate: '2026-09-16', transactionReceiptUrl: 'https://www.asaas.com/comprovantes/fixture-1' },
], async (calls) => {
  const sent = [];
  const receiptTools = asaasTools({
    secret: async () => '$aact_hmlg_fixture',
    emailDisponivel: async () => 'gmail',
    enviarComprovanteEmail: async (mail) => { sent.push(mail); return { ok: true, id: 'gmail-fixture' }; },
  });
  const gated = gateTool(named(receiptTools, 'asaas_enviar_comprovante_email'), 'receipt-email-confirm');
  setOwnerText('receipt-email-confirm', 'Manda o comprovante para pessoa@example.com');
  const proposal = await gated.run({ tipo: 'pix', id: 'pix-receipt-1', para: 'pessoa@example.com' });
  ok(proposal.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO'), 'the receipt email becomes a proposal');
  const pending = takePending('receipt-email-confirm');
  ok(pending.label.includes('pessoa@example.com') && pending.label.includes('R$ 73,40'), 'card shows verified recipient and amount');
  eq(sent.length, 0, 'no email before confirmation');
  const result = JSON.parse(await pending.run());
  eq(result.ok, true, 'provider confirmed the send');
  eq(sent.length, 1, 'a single email sent');
  ok(sent[0].subject.includes('R$ 73,40'), 'subject uses the Asaas amount');
  ok(sent[0].body.includes('https://www.asaas.com/comprovantes/fixture-1'), 'body uses the re-read official link');
  eq(calls.map((x) => x.method), ['GET', 'GET'], 'proposal and execution only make queries');
});

// If the model swaps a letter in the address, the card flags the divergence.
await withFetch([
  { id: 'pix-receipt-typo', status: 'DONE', value: 10, transactionReceiptUrl: 'https://www.asaas.com/comprovantes/fixture-typo' },
], async () => {
  const receiptTools = asaasTools({
    secret: async () => '$aact_hmlg_fixture',
    emailDisponivel: async () => 'gmail',
    enviarComprovanteEmail: async () => ({ ok: true }),
  });
  setOwnerText('receipt-email-typo', 'Manda para pessoa@example.com');
  const gated = gateTool(named(receiptTools, 'asaas_enviar_comprovante_email'), 'receipt-email-typo');
  await gated.run({ tipo: 'pix', id: 'pix-receipt-typo', para: 'pessoa@exampel.com' });
  const pending = takePending('receipt-email-typo');
  ok(/CONFIRA O ENDEREÇO|CHECK THE ADDRESS|REVISA LA DIRECCIÓN/i.test(pending.label), 'card warns about the diverging address');
});

// Pending status cannot produce an email proposal, let alone a send.
await withFetch([
  { id: 'pix-pending-1', status: 'PENDING', value: 30, transactionReceiptUrl: null },
], async () => {
  let sent = 0;
  const receiptTools = asaasTools({
    secret: async () => '$aact_hmlg_fixture',
    emailDisponivel: async () => 'gmail',
    enviarComprovanteEmail: async () => { sent++; return { ok: true }; },
  });
  const gated = gateTool(named(receiptTools, 'asaas_enviar_comprovante_email'), 'receipt-email-pending');
  const out = await gated.run({ tipo: 'pix', id: 'pix-pending-1', para: 'pessoa@example.com' });
  ok(out.startsWith('NÃO registrei o pedido:'), 'pending operation does not register a send');
  eq(takePending('receipt-email-pending'), undefined, 'does not leave a misleading confirmation pending');
  eq(sent, 0, 'does not send email for a pending operation');
});

// A question wrongly interpreted as an action: the model may call the tool,
// but the code only queries the state and creates a pending request. The POST occurs only
// after the next turn, when the human confirmation is consumed.
await withFetch([
  { data: [] },                              // preparo read-only
  { data: [] },                              // revalidation after the "yes"
  { id: 'key-1', key: 'evp-fixture', status: 'ACTIVE', qrCode: { payload: 'pix-payload' } },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_receber_pix'), 'financial-key-fixture', { mode: 'livre' });
  const proposal = await gated.run({});
  ok(proposal.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO'), 'call becomes a proposal');
  eq(calls.map((x) => x.method), ['GET'], 'only queries before confirmation');
  const pending = takePending('financial-key-fixture');
  ok(pending.label.includes('criar uma chave Pix aleatória'), 'shows the real effect');
  ok(pending.label.includes('nome completo') && pending.label.includes('CPF mascarado'), 'shows the mandatory exposure');
  const result = await pending.run();
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'POST only after confirmation');
  const rendered = renderConfirmed(pending, result);
  ok(rendered.includes('Chave Pix aleatória criada'), 'result says exactly what happened');
  ok(rendered.includes('pix-payload'), 'result delivers the copy-paste code');
});

// If the state changes between proposal and confirmation, nothing is executed based on
// an old card. The person needs to see and confirm a new proposal.
await withFetch([
  { data: [] },
  { data: [{ id: 'key-new', key: 'evp-new', status: 'ACTIVE', qrCode: { payload: 'new' } }] },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_receber_pix'), 'financial-state-change');
  await gated.run({});
  const pending = takePending('financial-state-change');
  const result = JSON.parse(await pending.run());
  eq(result.ok, false, 'state change fails closed');
  ok(/mudou depois da proposta/i.test(result.error), 'explains that the proposal went stale');
  eq(calls.map((x) => x.method), ['GET', 'GET'], 'does not create a key after the change');
});

// If there are two accounts, the credential and the name of the chosen account stay pinned to the
// proposal. The confirmation does not resolve again and cannot migrate to another one.
await withFetch([
  { data: [{ id: 'key-bound', key: 'evp-bound', status: 'ACTIVE', qrCode: { payload: 'pix-bound' } }] },
  { data: [{ id: 'key-bound', key: 'evp-bound', status: 'ACTIVE', qrCode: { payload: 'pix-bound' } }] },
], async (calls) => {
  let accountReads = 0;
  const boundTools = asaasTools({
    secret: async () => { throw new Error('não deve resolver outra credencial'); },
    conta: async () => {
      accountReads++;
      return { key: '$aact_hmlg_bound', rotulo: 'Conta Brambs', ambigua: true };
    },
  });
  const gated = gateTool(named(boundTools, 'asaas_receber_pix'), 'financial-account-binding');
  await gated.run({});
  const pending = takePending('financial-account-binding');
  ok(pending.label.includes('Conta que será usada: Conta Brambs'), 'confirmation identifies the selected account');
  const result = JSON.parse(await pending.run());
  eq(result.conta_usada, 'Conta Brambs', 'result preserves the confirmed account');
  eq(accountReads, 1, 'the account is resolved once at the proposal');
  ok(calls.every((x) => x.headers?.access_token === '$aact_hmlg_bound'), 'all calls use the bound credential');
});

// The payment stays bound to the amount, payee, and due date read from
// Asaas. If any of them changes, the old confirmation does not authorize another invoice.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 89.9, dueDate: '2026-09-20', beneficiaryName: 'Empresa A', beneficiaryCpfCnpj: '***1234', allowChangeValue: false } },
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 99.9, dueDate: '2026-09-20', beneficiaryName: 'Empresa A', beneficiaryCpfCnpj: '***1234', allowChangeValue: false } },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), 'financial-bill-change');
  await gated.run({ linha_digitavel: '123.456' });
  const pending = takePending('financial-bill-change');
  ok(/R\$ 89,90/.test(pending.label) && /Empresa A/.test(pending.label), 'confirmation shows real amount and payee');
  const result = JSON.parse(await pending.run());
  eq(result.ok, false, 'changed bill fails closed');
  ok(/mudou depois da confirmação/i.test(result.error), 'changed bill requires a new check');
  eq(calls.map((x) => x.method), ['POST', 'POST'], 'change blocks the payment POST');
  ok(calls.every((x) => x.url.includes('/v3/bill/simulate')), 'only the read-only simulation was called');
});

// A simple payment request is immediate. Even if the model copies the due date
// into `agendar_para`, the gate removes the scheduling before showing
// the confirmation and before assembling the POST.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 108.45, dueDate: '2026-09-20', beneficiaryName: 'BHub', beneficiaryCpfCnpj: '***1111', allowChangeValue: false } },
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 108.45, dueDate: '2026-09-20', beneficiaryName: 'BHub', beneficiaryCpfCnpj: '***1111', allowChangeValue: false } },
  { id: 'bill-immediate', status: 'PENDING', authorized: true, value: 108.45, scheduleDate: '2026-09-18' },
], async (calls) => {
  const thread = 'financial-bill-immediate';
  setOwnerText(thread, 'Pode pagar o boleto da BHub pra mim?', 'Pode pagar o boleto da BHub pra mim?');
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), thread);
  await gated.run({ linha_digitavel: '123456', agendar_para: '2026-09-20' });
  const pending = takePending(thread);
  eq(pending.args.agendar_para, undefined, 'date inferred by the model is removed');
  ok(/primeira data aceita pela Asaas/i.test(pending.confirmationText), 'confirmation shows the first date accepted by the provider');
  ok(!/Agendada para/.test(pending.confirmationText), 'immediate confirmation does not contain scheduling');
  const result = JSON.parse(await pending.run());
  const create = calls.find((x) => x.url.endsWith('/v3/bill') && x.method === 'POST');
  const body = JSON.parse(create.body);
  eq(body.scheduleDate, '2026-09-18', 'immediate POST fixes the first date accepted in the simulation');
  eq(renderConfirmed(pending, JSON.stringify(result)), 'A Asaas aceitou o pagamento para 18/09/2026. Ele ainda aguarda processamento bancário; avisarei aqui quando concluir.', 'PENDING on the confirmed date says when it will be processed');
});

// Without the official minimum date, the platform fails closed: it doesn't let
// Asaas silently pick the due date or create a payment other than the confirmed one.
await withFetch([
  { bankSlipInfo: { value: 108.45, dueDate: '2026-09-20', beneficiaryName: 'BHub', beneficiaryCpfCnpj: '***1111', allowChangeValue: false } },
], async (calls) => {
  const thread = 'financial-bill-missing-minimum-date';
  setOwnerText(thread, 'Pague este boleto agora.', 'Pague este boleto agora.');
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), thread);
  const result = await gated.run({ linha_digitavel: '123456' });
  ok(result.startsWith('NÃO registrei o pedido:'), 'missing minimum date fails before confirmation');
  ok(/primeira data.*não propus o pagamento/i.test(result), 'error explains that no payment was proposed');
  eq(takePending(thread), undefined, 'does not leave an impossible confirmation pending');
  eq(calls.filter((x) => x.url.endsWith('/v3/bill') && x.method === 'POST').length, 0, 'does not send the payment without the official date');
});

// Scheduling only survives when the current request states it literally. If it falls
// on a weekend, the code itself shows the next-business-day rule.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 108.45, dueDate: '2026-09-20', beneficiaryName: 'BHub', beneficiaryCpfCnpj: '***1111', allowChangeValue: false } },
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 108.45, dueDate: '2026-09-20', beneficiaryName: 'BHub', beneficiaryCpfCnpj: '***1111', allowChangeValue: false } },
], async (calls) => {
  const schedules = [];
  const scheduleTools = asaasTools({
    secret: async () => '$aact_hmlg_fixture',
    criarAgendamentoBoleto: async (s) => {
      schedules.push(s);
      return { id: 'local-schedule-1', status: 'scheduled', execute_on: s.executeOn };
    },
  });
  const thread = 'financial-bill-scheduled';
  setOwnerText(thread, 'Agende o pagamento para 20/09/2026.', 'Agende o pagamento para 20/09/2026.');
  const gated = gateTool(named(scheduleTools, 'asaas_pagar_conta'), thread);
  await gated.run({ linha_digitavel: '123456', agendar_para: '2026-09-20' });
  const pending = takePending(thread);
  eq(pending.args.agendar_para, '2026-09-20', 'explicit date stays bound');
  ok(/Agendada para 20\/09\/2026/.test(pending.confirmationText), 'confirmation shows the requested date');
  ok(/próximo dia útil, 21\/09\/2026/.test(pending.confirmationText), 'weekend shows the bank processing');
  const result = JSON.parse(await pending.run());
  eq(result.agendado, true, 'scheduling is confirmed as a local schedule');
  eq(schedules[0].executeOn, '2026-09-20', 'local schedule preserves the explicit date');
  eq(calls.filter((x) => x.url.endsWith('/v3/bill') && x.method === 'POST').length, 0, 'future schedule does not create a payment at Asaas');
  eq(calls.filter((x) => x.url.includes('/v3/bill/simulate')).length, 2, 'bill is checked at proposal and at confirmation');
});

// "On the due date" uses the date verified in the simulation, without asking the user to
// retype what's already on the invoice and without letting the model invent it.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 35, dueDate: '2026-09-20', beneficiaryName: 'Empresa Vencimento', beneficiaryCpfCnpj: '***5555', allowChangeValue: false } },
], async (calls) => {
  const thread = 'financial-bill-schedule-missing';
  setOwnerText(thread, 'Paga no vencimento.', 'Paga no vencimento.');
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), thread);
  const out = await gated.run({ linha_digitavel: '123456' });
  ok(out.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO'), 'verified due date generates a proposal');
  const pending = takePending(thread);
  eq(pending.args.agendar_para, '2026-09-20', 'date comes from the due date returned by Asaas');
  eq(pending.args.__agendar_no_vencimento, undefined, 'internal marker does not reach the pending item');
  ok(/próximo dia útil, 21\/09\/2026/.test(pending.confirmationText), 'the business-day rule also applies on the due date');
  eq(calls.length, 1, 'a single official simulation resolves the due date');
});

// A generic scheduling request without a date or reference to the due date requires
// clarification before querying or proposing anything.
await withFetch([], async (calls) => {
  const thread = 'financial-bill-schedule-no-date';
  setOwnerText(thread, 'Agende esse pagamento.', 'Agende esse pagamento.');
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), thread);
  const out = await gated.run({ linha_digitavel: '123456' });
  ok(out.startsWith('NÃO registrei o pedido:'), 'generic scheduling without a date asks for clarification');
  eq(takePending(thread), undefined, 'does not create a confirmation with an invented date');
  eq(calls.length, 0, 'does not query the bill before resolving the date');
});

// A schedule that is still local only is cancelled without calling Asaas.
await withFetch([], async (calls) => {
  let cancelled = 0;
  const localTools = asaasTools({
    secret: async () => '$aact_hmlg_local_cancel',
    obterAgendamentoBoleto: async (id) => id === 'schedule-local-1' ? {
      id, status: 'scheduled', execute_on: '2026-09-25', expected_hash: 'hash-1',
      payload: { valor: 88, resumo_confirmado: { valor: 88, beneficiario: 'Empresa Local' } },
    } : null,
    cancelarAgendamentoBoleto: async (id, hash) => {
      cancelled++;
      return id === 'schedule-local-1' && hash === 'hash-1' ? { id, status: 'cancelled' } : null;
    },
  });
  const gated = gateTool(named(localTools, 'asaas_cancelar_pagamento_conta'), 'financial-local-cancel');
  await gated.run({ id: 'schedule-local-1' });
  const pending = takePending('financial-local-cancel');
  ok(/não exige aprovação externa/.test(pending.label), 'local cancellation explains the flow without Asaas');
  const result = JSON.parse(await pending.run());
  eq(result.cancelado, true, 'local cancellation completes in the conversation');
  eq(cancelled, 1, 'local cancellation happens once');
  eq(calls.length, 0, 'local cancellation does not call Asaas');
});

// Cancellation is another confirmed action: two reads bind the state, and the
// mutable endpoint is called exactly once after textual acceptance.
await withFetch([
  { id: 'bill-cancel-1', status: 'PENDING', value: 108.45, scheduleDate: '2026-09-21', dueDate: '2026-09-20', description: 'BHub', canBeCancelled: true },
  { id: 'bill-cancel-1', status: 'PENDING', value: 108.45, scheduleDate: '2026-09-21', dueDate: '2026-09-20', description: 'BHub', canBeCancelled: true },
  { id: 'bill-cancel-1', status: 'CANCELLED', value: 108.45, scheduleDate: '2026-09-21', dueDate: '2026-09-20' },
], async (calls) => {
  const saved = [];
  const cancelTools = asaasTools({
    secret: async () => '$aact_hmlg_cancel',
    registrarOperacao: async (op) => { saved.push(op); },
  });
  const gated = gateTool(named(cancelTools, 'asaas_cancelar_pagamento_conta'), 'financial-bill-cancel');
  await gated.run({ id: 'bill-cancel-1' });
  const pending = takePending('financial-bill-cancel');
  ok(/R\$ 108,45/.test(pending.confirmationText) && /21\/09\/2026/.test(pending.confirmationText), 'cancellation shows real amount and date');
  const result = JSON.parse(await pending.run());
  eq(result.cancelado, true, 'only CANCELLED is shown as cancelled');
  eq(saved.at(-1).comprovanteEntregue, true, 'inline conclusion deduplicates the webhook');
  eq(calls.filter((x) => x.method === 'POST' && x.url.endsWith('/v3/bill/bill-cancel-1/cancel')).length, 1, 'cancellation makes a single POST');
  const again = JSON.parse(await pending.run());
  eq(again.ok, false, 'a consumed confirmation does not repeat the cancellation');
  eq(calls.length, 3, 'reuse does not call Asaas again');
});

// A state/canBeCancelled change between proposal and confirmation fails closed.
await withFetch([
  { id: 'bill-cancel-stale', status: 'PENDING', value: 20, scheduleDate: '2026-09-21', canBeCancelled: true },
  { id: 'bill-cancel-stale', status: 'BANK_PROCESSING', value: 20, scheduleDate: '2026-09-21', canBeCancelled: false },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_cancelar_pagamento_conta'), 'financial-bill-cancel-stale');
  await gated.run({ id: 'bill-cancel-stale' });
  const result = JSON.parse(await takePending('financial-bill-cancel-stale').run());
  eq(result.ok, false, 'changed state invalidates the confirmation');
  eq(calls.filter((x) => x.method === 'POST').length, 0, 'changed state does not send a cancellation');
});

// If the API accepts the cancellation but still returns PENDING, the response is
// honest and there is a single GET reconciliation; the POST is never repeated.
await withFetch([
  { id: 'bill-cancel-pending', status: 'PENDING', value: 44, scheduleDate: '2026-09-21', canBeCancelled: true },
  { id: 'bill-cancel-pending', status: 'PENDING', value: 44, scheduleDate: '2026-09-21', canBeCancelled: true },
  { id: 'bill-cancel-pending', status: 'PENDING', value: 44, scheduleDate: '2026-09-21', canBeCancelled: true },
  { id: 'bill-cancel-pending', status: 'CANCELLED', value: 44, scheduleDate: '2026-09-21' },
], async (calls) => {
  const saved = [];
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    eq(ms, 60_000, 'cancellation reconciliation runs once at 60 seconds');
    timers.push(Promise.resolve().then(fn));
    return { unref() {} };
  };
  try {
    const cancelTools = asaasTools({
      secret: async () => '$aact_hmlg_cancel_pending',
      registrarOperacao: async (op) => { saved.push(op); },
      obterOperacao: async () => ({ status: 'PENDING' }),
      aguardarOperacao: async () => null,
    });
    const gated = gateTool(named(cancelTools, 'asaas_cancelar_pagamento_conta'), 'financial-bill-cancel-pending');
    await gated.run({ id: 'bill-cancel-pending' });
    const pending = takePending('financial-bill-cancel-pending');
    const result = JSON.parse(await pending.run());
    eq(result.pending, true, 'cancellation not yet confirmed stays pending');
    ok(/cancelamento foi solicitado/.test(result.aviso), 'response does not claim cancellation before CANCELLED');
    await Promise.all(timers);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  eq(calls.filter((x) => x.method === 'POST' && x.url.endsWith('/cancel')).length, 1, 'pending cancellation does not repeat the POST');
  eq(calls.filter((x) => x.method === 'GET' && x.url.endsWith('/v3/bill/bill-cancel-pending')).length, 3, 'two validations and a single reconciliation query the id');
  eq(saved.at(-1).status, 'CANCELLED', 'reconciliation persists the late confirmation');
  eq(saved.at(-1).comprovanteEntregue, false, 'late confirmation is left for the outbox to notify');
});

// A payment accepted as PENDING follows the same asynchronous contract as Pix. If
// BILL_PAID arrives within the short wait, the turn delivers the receipt without repeating the
// POST; the final record deduplicates the later notification.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 120, dueDate: '2026-09-20', beneficiaryName: 'Empresa Assíncrona', beneficiaryCpfCnpj: '***8888', allowChangeValue: false } },
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 120, dueDate: '2026-09-20', beneficiaryName: 'Empresa Assíncrona', beneficiaryCpfCnpj: '***8888', allowChangeValue: false } },
  { id: 'bill-async-paid', status: 'PENDING', authorized: true, value: 120, scheduleDate: '2026-09-18' },
], async (calls) => {
  const saved = [];
  let waits = 0;
  const asyncTools = asaasTools({
    secret: async () => '$aact_hmlg_bill_async',
    registrarOperacao: async (op) => { saved.push(op); },
    aguardarOperacao: async (id, timeoutMs) => {
      waits++;
      eq(id, 'bill-async-paid', 'payment wait uses the id returned by the POST');
      eq(timeoutMs, 10_000, 'payment also waits at most ten seconds');
      return {
        provider_operation_id: id,
        status: 'PAID',
        value: 120,
        receipt_url: 'https://www.asaas.com/comprovantes/bill-async-paid',
      };
    },
  });
  const gated = gateTool(named(asyncTools, 'asaas_pagar_conta'), 'financial-bill-async-paid');
  await gated.run({ linha_digitavel: '123456', valor: 120 });
  const pending = takePending('financial-bill-async-paid');
  const result = JSON.parse(await pending.run());
  eq(waits, 1, 'payment waits a single time');
  eq(result.status, 'PAID', 'observed webhook closes the payment within the turn');
  eq(result.pago, true, 'PAID is presented as a completed payment');
  eq(result.comprovante, 'https://www.asaas.com/comprovantes/bill-async-paid', 'turn includes the payment receipt');
  eq(saved.length, 2, 'records PENDING and PAID without creating another payment');
  eq(saved.at(-1).comprovanteEntregue, true, 'inline receipt deduplicates the later notification');
  eq(calls.filter((x) => x.url.includes('/v3/bill') && !x.url.includes('/simulate')).length, 1, 'payment makes a single creation POST');
  const rendered = renderConfirmed(pending, JSON.stringify(result));
  ok(rendered.includes('Pagamento') && rendered.includes('/bill-async-paid'), 'turn delivers conclusion and payment receipt');
});

// If the window ends still in PENDING, the conversation reports processing instead
// of failure, and the webhook can close it later.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 55, dueDate: '2026-09-20', beneficiaryName: 'Empresa Pendente', beneficiaryCpfCnpj: '***9999', allowChangeValue: false } },
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 55, dueDate: '2026-09-20', beneficiaryName: 'Empresa Pendente', beneficiaryCpfCnpj: '***9999', allowChangeValue: false } },
  { id: 'bill-async-pending', status: 'PENDING', authorized: true, value: 55, scheduleDate: '2026-09-21' },
], async () => {
  const pendingTools = asaasTools({
    secret: async () => '$aact_hmlg_bill_pending',
    registrarOperacao: async () => {},
    aguardarOperacao: async () => null,
  });
  const gated = gateTool(named(pendingTools, 'asaas_pagar_conta'), 'financial-bill-async-pending');
  await gated.run({ linha_digitavel: '654321', valor: 55 });
  const pending = takePending('financial-bill-async-pending');
  const result = JSON.parse(await pending.run());
  eq(result.pending, true, 'payment preserves the real PENDING');
  eq(result.data_processamento_divergente, true, 'result records the deviation of the date returned by the provider');
  eq(renderConfirmed(pending, JSON.stringify(result)), 'A Asaas aceitou o pagamento, mas informou processamento em 21/09/2026, diferente de 18/09/2026 que você confirmou. Ele ainda não foi pago. Não repita o pedido; avisarei aqui quando o status mudar.', 'PENDING explains the real date without claiming payment');
});

// Without a webhook inside the window, there is exactly one GET reconciliation at 60s.
// It updates the state for the outbox to deliver; it never repeats the financial POST.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 70, dueDate: '2026-09-20', beneficiaryName: 'Empresa Reconciliação', beneficiaryCpfCnpj: '***0000', allowChangeValue: false } },
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 70, dueDate: '2026-09-20', beneficiaryName: 'Empresa Reconciliação', beneficiaryCpfCnpj: '***0000', allowChangeValue: false } },
  { id: 'bill-reconcile-once', status: 'PENDING', authorized: true, value: 70, scheduleDate: '2026-09-18' },
  { id: 'bill-reconcile-once', status: 'PAID', authorized: true, value: 70, transactionReceiptUrl: 'https://www.asaas.com/comprovantes/bill-reconcile-once' },
], async (calls) => {
  const saved = [];
  const timers = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    eq(ms, 60_000, 'payment reconciliation runs once at 60 seconds');
    timers.push(Promise.resolve().then(fn));
    return { unref() {} };
  };
  try {
    const reconcileTools = asaasTools({
      secret: async () => '$aact_hmlg_bill_reconcile',
      registrarOperacao: async (op) => { saved.push(op); },
      obterOperacao: async () => ({ status: 'PENDING' }),
      aguardarOperacao: async () => null,
    });
    const gated = gateTool(named(reconcileTools, 'asaas_pagar_conta'), 'financial-bill-reconcile-once');
    await gated.run({ linha_digitavel: '777777', valor: 70 });
    const pending = takePending('financial-bill-reconcile-once');
    const result = JSON.parse(await pending.run());
    eq(result.pending, true, 'turn ends in processing before the reconciliation');
    await Promise.all(timers);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  eq(calls.filter((x) => x.url.includes('/v3/bill') && !x.url.includes('/simulate') && x.method === 'POST').length, 1, 'reconciliation does not repeat the POST');
  eq(calls.filter((x) => x.url.includes('/v3/bill/bill-reconcile-once') && x.method === 'GET').length, 1, 'reconciliation makes a single GET by id');
  eq(saved.at(-1).status, 'PAID', 'reconciliation persists the final state');
  eq(saved.at(-1).comprovanteEntregue, false, 'reconciled state is left for the outbox to notify in the conversation');
});

// The transfer stays bound to the actual account holder queried, not just to the key
// typed by the model. A different holder invalidates the authorization.
await withFetch([
  {
    key: 'fixture-current-shape', type: 'EVP', ispb: '12345678', ispbName: 'Banco Atual',
    owner: { name: 'Pessoa no contrato atual', cpfCnpj: '***.555.666-**' },
    financialInstitution: { id: 'bank-current', name: 'Banco Atual', code: '999' },
  },
  {
    key: 'fixture-current-shape', type: 'EVP', ispb: '12345678', ispbName: 'Banco Atual',
    owner: { name: 'Pessoa no contrato atual', cpfCnpj: '***.555.666-**' },
    financialInstitution: { id: 'bank-current', name: 'Banco Atual', code: '999' },
  },
  { id: 'pix-current-shape', status: 'PENDING', authorized: true, value: 10 },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_transferir_pix'), 'financial-pix-current-owner-shape');
  const proposal = await gated.run({ valor: 10, chave_pix: 'fixture-current-shape', tipo_chave: 'EVP' });
  ok(proposal.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO'), 'current Asaas shape generates a proposal');
  const pending = takePending('financial-pix-current-owner-shape');
  ok(pending.label.includes('Pessoa no contrato atual'), 'proposal reads owner.name from the current contract');
  ok(pending.label.includes('***.555.666-**'), 'proposal reads owner.cpfCnpj from the current contract');
  ok(pending.label.includes('Banco Atual'), 'proposal reads financialInstitution.name from the current contract');
  eq(calls.map((x) => x.method), ['GET'], 'current shape only queries before confirmation');
  const result = JSON.parse(await pending.run());
  eq(result.pending, true, 'current shape preserves the real state of the created Pix');
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'current shape revalidates the holder before the single POST');
  const rendered = renderConfirmed(pending, JSON.stringify(result));
  eq(rendered, 'O Pix está em processamento. Avisarei aqui quando concluir.', 'known PENDING does not turn into uncertain failure');
});

// If the webhook closes the operation within the short wait, the turn itself
// delivers DONE and the receipt without repeating the POST. The final record marked as
// delivered prevents the asynchronous notification from duplicating the message.
await withFetch([
  { name: 'Pessoa Assíncrona', cpfCnpj: '***7777', institutionName: 'Banco E' },
  { name: 'Pessoa Assíncrona', cpfCnpj: '***7777', institutionName: 'Banco E' },
  { id: 'pix-async-done', status: 'PENDING', authorized: true, value: 20 },
], async (calls) => {
  const saved = [];
  let waits = 0;
  const asyncTools = asaasTools({
    secret: async () => '$aact_hmlg_async',
    registrarOperacao: async (op) => { saved.push(op); },
    aguardarOperacao: async (id, timeoutMs) => {
      waits++;
      eq(id, 'pix-async-done', 'wait uses the real id returned by the POST');
      eq(timeoutMs, 10_000, 'inline wait has a ten-second ceiling');
      return {
        provider_operation_id: id,
        status: 'DONE',
        value: 20,
        receipt_url: 'https://www.asaas.com/comprovantes/pix-async-done',
      };
    },
  });
  const gated = gateTool(named(asyncTools, 'asaas_transferir_pix'), 'financial-pix-async-done');
  await gated.run({ valor: 20, chave_pix: 'async-key', tipo_chave: 'EVP' });
  const pending = takePending('financial-pix-async-done');
  const result = JSON.parse(await pending.run());
  eq(waits, 1, 'waits a single time');
  eq(result.status, 'DONE', 'observed webhook closes the turn state');
  eq(result.saiu, true, 'DONE is presented as the Pix having gone through');
  eq(result.comprovante, 'https://www.asaas.com/comprovantes/pix-async-done', 'response includes the receipt persisted by the webhook');
  eq(saved.length, 2, 'records initial and final state without a new transfer');
  eq(saved.at(-1).comprovanteEntregue, true, 'inline response deduplicates the later notification');
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'wait does not make another POST nor external polling');
  const rendered = renderConfirmed(pending, JSON.stringify(result));
  ok(rendered.includes('PIX de R$ 20 enviado') && rendered.includes('/pix-async-done'), 'turn delivers success and receipt');
});

// Transport uncertainty remains different from an accepted PENDING: the renderer
// keeps the no-repeat notice in that case.
{
  const p = { name: 'asaas_transferir_pix', args: { valor: 20, chave_pix: 'fixture' } };
  const out = renderConfirmed(p, JSON.stringify({
    ok: true, pending: true, incerto: true, saiu: false,
    aviso: 'O resultado é incerto. Não repita.',
  }));
  ok(out.includes('não tem confirmação verificável') && out.includes('Não repita'), 'real uncertainty is not softened into normal processing');
}

await withFetch([
  { key: 'fixture-unknown-shape', type: 'EVP', owner: {}, financialInstitution: {} },
], async () => {
  const gated = gateTool(named(tools(), 'asaas_transferir_pix'), 'financial-pix-unknown-owner-shape');
  const out = await gated.run({ valor: 10, chave_pix: 'fixture-unknown-shape', tipo_chave: 'EVP' });
  ok(out.startsWith('NÃO registrei o pedido:'), 'shape without a holder does not generate a proposal');
  ok(/não prova que a chave esteja inválida ou não cadastrada/i.test(out), 'unknown shape does not invent an invalid key');
  eq(takePending('financial-pix-unknown-owner-shape'), undefined, 'shape without a holder does not leave a pending confirmation');
});

await withFetch([
  { name: 'Pessoa A', cpfCnpj: '***1111', institutionName: 'Banco A' },
  { name: 'Pessoa B', cpfCnpj: '***2222', institutionName: 'Banco B' },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_transferir_pix'), 'financial-pix-owner-change');
  await gated.run({ valor: 15, chave_pix: 'fixture-key', tipo_chave: 'EVP' });
  const pending = takePending('financial-pix-owner-change');
  ok(/R\$ 15,00/.test(pending.label) && /Pessoa A/.test(pending.label), 'confirmation shows real amount and holder');
  const result = JSON.parse(await pending.run());
  eq(result.ok, false, 'changed holder fails closed');
  ok(/titularidade[\s\S]*mudou/i.test(result.error), 'changed holder requires a new check');
  eq(calls.map((x) => x.method), ['GET', 'GET'], 'change blocks the transfer POST');
  ok(calls.every((x) => x.url.includes('/v3/pix/addressKeys/external')), 'only the holder lookup was called');
});

// With the same real data on revalidation, the POST occurs exactly once and the
// state returned by the provider is preserved without turning a pending into a success.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 42, dueDate: '2026-09-22', beneficiaryName: 'Empresa Estável', allowChangeValue: false } },
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 42, dueDate: '2026-09-22', beneficiaryName: 'Empresa Estável', allowChangeValue: false } },
  { id: 'bill-1', status: 'PENDING', authorized: true, value: 42, scheduleDate: '2026-09-18' },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), 'financial-bill-stable');
  await gated.run({ linha_digitavel: '999' });
  const pending = takePending('financial-bill-stable');
  const result = JSON.parse(await pending.run());
  eq(result.pending, true, 'pending payment stays pending');
  eq(result.pago, false, 'pending payment does not turn into paid');
  eq(calls.map((x) => x.url.split('/v3')[1].split('?')[0]), ['/bill/simulate', '/bill/simulate', '/bill'], 'payment is only created after revalidation');
  const again = JSON.parse(await pending.run());
  eq(again.ok, false, 'the same confirmation does not execute the payment twice');
  eq(calls.length, 3, 'reusing the confirmation makes no new call');
});

await withFetch([
  { name: 'Pessoa Estável', cpfCnpj: '***3333', institutionName: 'Banco C' },
  { name: 'Pessoa Estável', cpfCnpj: '***3333', institutionName: 'Banco C' },
  { id: 'pix-1', status: 'DONE', authorized: true, value: 12.5 },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_transferir_pix'), 'financial-pix-stable');
  await gated.run({ valor: 12.5, chave_pix: 'stable-key', tipo_chave: 'EVP' });
  const pending = takePending('financial-pix-stable');
  const result = JSON.parse(await pending.run());
  eq(result.ok, true, 'completed Pix keeps proven success');
  eq(result.saiu, true, 'only DONE status indicates the Pix went through');
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'transfer is only created after revalidating the holder');
});

// Before the financial POST, the managed payment account sets up the webhook that
// delivers the receipt. The account bound to the confirmation also goes to the record.
await withFetch([
  { name: 'Pessoa Webhook', cpfCnpj: '***4444', institutionName: 'Banco D' },
  { name: 'Pessoa Webhook', cpfCnpj: '***4444', institutionName: 'Banco D' },
  { id: 'pix-webhook-1', status: 'PENDING', authorized: true, value: 19 },
], async (calls) => {
  let prepared = null;
  let preparedAfterCalls = null;
  let saved = null;
  const receiptReadyTools = asaasTools({
    secret: async () => { throw new Error('a conta vinculada deve prevalecer'); },
    conta: async () => ({
      key: '$aact_hmlg_receipt', rotulo: 'Conta Brambs', ambigua: false,
      contaBrambs: true, accountId: 'acc-webhook-1',
    }),
    garantirWebhookComprovante: async (bound) => {
      prepared = bound;
      preparedAfterCalls = calls.length;
    },
    registrarOperacao: async (op) => { saved = op; },
  });
  const gated = gateTool(named(receiptReadyTools, 'asaas_transferir_pix'), 'financial-pix-receipt-ready');
  await gated.run({ valor: 19, chave_pix: 'receipt-key', tipo_chave: 'EVP' });
  const pending = takePending('financial-pix-receipt-ready');
  const result = JSON.parse(await pending.run());
  eq(result.pending, true, 'pending Pix stays without a false success');
  eq(preparedAfterCalls, 2, 'webhook is prepared after revalidation and before the POST');
  eq(prepared.accountId, 'acc-webhook-1', 'webhook uses the account bound to the confirmation');
  eq(saved.accountId, 'acc-webhook-1', 'operation record preserves the real account');
  eq(saved.id, 'pix-webhook-1', 'record uses the id returned by Asaas');
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'no extra mutation before the financial POST');
});

// Current balance is only a snapshot, never proof of a deposit.
await withFetch([{ balance: 365 }], async () => {
  const data = JSON.parse(await named(tools(), 'asaas_saldo').run());
  eq(data.saldo, 365);
  eq(data.confirma_deposito_especifico, false);
  ok(/saldo atual isolado não prova/i.test(data.aviso), 'balance carries an explicit evidentiary limit');
});

const extrato = (rows) => ({ data: rows });
// Without the amount informed, even a single recent credit remains a candidate, not
// confirmation. This is exactly the case where the agent previously claimed "it worked".
await withFetch([extrato([{ id: 'ft-1', type: 'PIX_TRANSACTION_CREDIT', value: 365, date: '2026-09-16' }])], async () => {
  const data = JSON.parse(await named(tools(), 'asaas_verificar_recebimento_pix').run({ desde: '2026-09-16' }));
  eq(data.confirmado, false);
  eq(data.motivo, 'valor_nao_informado');
  eq(data.creditos_pix_recentes.length, 1);
});

// With the amount and a single Pix entry in the statement, there is deterministic evidence.
await withFetch([extrato([
  { id: 'ft-1', type: 'PIX_TRANSACTION_CREDIT', value: 365, date: '2026-09-16' },
  { id: 'fee-1', type: 'PIX_TRANSACTION_CREDIT_FEE', value: -1, date: '2026-09-16' },
])], async () => {
  const data = JSON.parse(await named(tools(), 'asaas_verificar_recebimento_pix').run({ valor: 365, desde: '2026-09-16' }));
  eq(data.confirmado, true);
  eq(data.evidencia.id, 'ft-1');
});

// Two equal credits are ambiguous, so they do not confirm which one was the test.
await withFetch([extrato([
  { id: 'ft-1', type: 'PIX_TRANSACTION_CREDIT', value: 20, date: '2026-09-16' },
  { id: 'ft-2', type: 'PIX_TRANSACTION_CREDIT', value: 20, date: '2026-09-16' },
])], async () => {
  const data = JSON.parse(await named(tools(), 'asaas_verificar_recebimento_pix').run({ valor: 20, desde: '2026-09-16' }));
  eq(data.confirmado, false);
  eq(data.motivo, 'mais_de_um_lancamento_compativel');
});

console.log(`PASS ${checks}: confirmação financeira, consentimento Pix e verificação de depósito; offline only.`);
