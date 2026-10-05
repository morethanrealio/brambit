// Guarda-corpo offline para ações financeiras Asaas.
// Prova três contratos:
// 1. nenhuma mutação financeira roda antes de confirmação textual;
// 2. a confirmação de chave Pix informa o efeito e a exposição de dados;
// 3. saldo isolado nunca é aceito como prova de um depósito.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asaasTools } from './web/connectors-vault.mjs';
import {
  gateTool, takePending, renderConfirmed, setOwnerText, GATED_TOOLS, IRREVERSIBLE_TOOLS,
} from './web/confirm.mjs';

// Relógio fixo em 18/09/2026 (data em que os fixtures foram escritos): os
// boletos sintéticos vencem em 20/09/2026, um domingo, e a regra "data já
// passou" do produto é real. Sem congelar o dia, o teste vira bomba-relógio.
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
  assert.ok(tool, `tool ${name} ausente`);
  return tool;
};

// O wiring e o gate precisam concordar. Se alguém adicionar uma ação Asaas e
// esquecer um dos dois lugares, este incidente volta.
for (const name of ['asaas_receber_pix', 'asaas_pagar_conta', 'asaas_cancelar_pagamento_conta', 'asaas_transferir_pix', 'asaas_enviar_comprovante_email']) {
  ok(GATED_TOOLS.has(name), `${name} precisa estar no gate`);
  ok(IRREVERSIBLE_TOOLS.has(name), `${name} exige texto, reação não basta`);
}
const server = readFileSync(new URL('./web/server.mjs', import.meta.url), 'utf8');
ok(/VAULT_WRITE_TOOLS[\s\S]*asaas_receber_pix/.test(server), 'receber Pix precisa ser registrado pelo caminho gated');
ok(/VAULT_WRITE_TOOLS[\s\S]*asaas_cancelar_pagamento_conta/.test(server), 'cancelamento precisa ser registrado pelo caminho gated');
// O cartão determinístico vai sempre inteiro no fim da resposta; o texto do modelo
// fica acima dele, mas é o cartão que amarra a aprovação (29/09/2026).
ok(/peekPending\(thread\.id\)\?\.confirmationText[\s\S]*if \(deterministicConfirmation\) text = \[[^\n]*, deterministicConfirmation\]/.test(server), 'confirmação financeira determinística fecha a resposta');
ok(/TODA ação financeira[\s\S]*asaas_receber_pix[\s\S]*confirmação por TEXTO/.test(server), 'prompt exige confirmação de toda ação financeira');
ok(!/asaas_receber_pix:[^\n]*não precisa de confirmação/.test(server), 'prompt não contém exceção antiga para receber Pix');

// Defesa em profundidade: mesmo que alguém registre a tool crua por engano,
// run() não pode fazer POST. Só o closure preparado e confirmado pode mutar.
await withFetch([], async (calls) => {
  for (const name of ['asaas_receber_pix', 'asaas_pagar_conta', 'asaas_cancelar_pagamento_conta', 'asaas_transferir_pix', 'asaas_enviar_comprovante_email']) {
    const out = JSON.parse(await named(tools(), name).run({
      valor: 10, chave_pix: 'fixture', tipo_chave: 'EVP', linha_digitavel: '123', id: 'bill-fixture',
    }));
    eq(out.ok, false, `${name} direto deve recusar`);
    ok(/confirmação explícita/i.test(out.error), `${name} explica a confirmação`);
  }
  eq(calls.length, 0, 'nenhuma rede na chamada direta');
});

// O comprovante enviado por e-mail é montado com dados relidos da Asaas e só
// sai depois de confirmação textual. O modelo não escolhe link, valor nem corpo.
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
  ok(proposal.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO'), 'e-mail do comprovante vira proposta');
  const pending = takePending('receipt-email-confirm');
  ok(pending.label.includes('pessoa@example.com') && pending.label.includes('R$ 73,40'), 'cartão mostra destinatário e valor verificados');
  eq(sent.length, 0, 'nenhum e-mail antes da confirmação');
  const result = JSON.parse(await pending.run());
  eq(result.ok, true, 'provedor confirmou o envio');
  eq(sent.length, 1, 'um único e-mail enviado');
  ok(sent[0].subject.includes('R$ 73,40'), 'assunto usa valor da Asaas');
  ok(sent[0].body.includes('https://www.asaas.com/comprovantes/fixture-1'), 'corpo usa link oficial relido');
  eq(calls.map((x) => x.method), ['GET', 'GET'], 'proposta e execução só fazem consultas');
});

// Se o modelo trocar uma letra do endereço, o cartão denuncia a divergência.
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
  ok(/CONFIRA O ENDEREÇO|CHECK THE ADDRESS|REVISA LA DIRECCIÓN/i.test(pending.label), 'cartão avisa endereço divergente');
});

// Status pendente não pode produzir nem proposta de e-mail, muito menos envio.
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
  ok(out.startsWith('NÃO registrei o pedido:'), 'operação pendente não registra envio');
  eq(takePending('receipt-email-pending'), undefined, 'não deixa confirmação enganosa pendente');
  eq(sent, 0, 'não envia e-mail de operação pendente');
});

// Pergunta interpretada indevidamente como ação: o modelo pode chamar a tool,
// mas o código só consulta o estado e cria uma pendência. O POST ocorre apenas
// depois do turno seguinte, quando a confirmação humana é consumida.
await withFetch([
  { data: [] },                              // preparo read-only
  { data: [] },                              // revalidação depois do "sim"
  { id: 'key-1', key: 'evp-fixture', status: 'ACTIVE', qrCode: { payload: 'pix-payload' } },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_receber_pix'), 'financial-key-fixture', { mode: 'livre' });
  const proposal = await gated.run({});
  ok(proposal.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO'), 'chamada vira proposta');
  eq(calls.map((x) => x.method), ['GET'], 'antes da confirmação só consulta');
  const pending = takePending('financial-key-fixture');
  ok(pending.label.includes('criar uma chave Pix aleatória'), 'mostra o efeito real');
  ok(pending.label.includes('nome completo') && pending.label.includes('CPF mascarado'), 'mostra a exposição obrigatória');
  const result = await pending.run();
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'POST só depois da confirmação');
  const rendered = renderConfirmed(pending, result);
  ok(rendered.includes('Chave Pix aleatória criada'), 'resultado diz exatamente o que ocorreu');
  ok(rendered.includes('pix-payload'), 'resultado entrega o copia-e-cola');
});

// Se o estado mudar entre proposta e confirmação, nada é executado com base
// num cartão velho. A pessoa precisa ver e confirmar uma nova proposta.
await withFetch([
  { data: [] },
  { data: [{ id: 'key-new', key: 'evp-new', status: 'ACTIVE', qrCode: { payload: 'new' } }] },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_receber_pix'), 'financial-state-change');
  await gated.run({});
  const pending = takePending('financial-state-change');
  const result = JSON.parse(await pending.run());
  eq(result.ok, false, 'mudança de estado falha fechado');
  ok(/mudou depois da proposta/i.test(result.error), 'explica que a proposta ficou velha');
  eq(calls.map((x) => x.method), ['GET', 'GET'], 'não cria chave depois da mudança');
});

// Se há duas contas, a credencial e o nome da conta escolhida ficam presos à
// proposta. A confirmação não resolve de novo e não pode migrar para outra.
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
  ok(pending.label.includes('Conta que será usada: Conta Brambs'), 'confirmação identifica a conta selecionada');
  const result = JSON.parse(await pending.run());
  eq(result.conta_usada, 'Conta Brambs', 'resultado preserva a conta confirmada');
  eq(accountReads, 1, 'conta é resolvida uma vez na proposta');
  ok(calls.every((x) => x.headers?.access_token === '$aact_hmlg_bound'), 'todas as chamadas usam a credencial vinculada');
});

// O pagamento fica vinculado a valor, beneficiário e vencimento lidos na
// Asaas. Se qualquer um mudar, a confirmação antiga não autoriza outro boleto.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 89.9, dueDate: '2026-09-20', beneficiaryName: 'Empresa A', beneficiaryCpfCnpj: '***1234', allowChangeValue: false } },
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 99.9, dueDate: '2026-09-20', beneficiaryName: 'Empresa A', beneficiaryCpfCnpj: '***1234', allowChangeValue: false } },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), 'financial-bill-change');
  await gated.run({ linha_digitavel: '123.456' });
  const pending = takePending('financial-bill-change');
  ok(/R\$ 89,90/.test(pending.label) && /Empresa A/.test(pending.label), 'confirmação mostra valor e beneficiário reais');
  const result = JSON.parse(await pending.run());
  eq(result.ok, false, 'boleto alterado falha fechado');
  ok(/mudou depois da confirmação/i.test(result.error), 'boleto alterado exige nova conferência');
  eq(calls.map((x) => x.method), ['POST', 'POST'], 'mudança impede o POST de pagamento');
  ok(calls.every((x) => x.url.includes('/v3/bill/simulate')), 'só a simulação read-only foi chamada');
});

// Pedido simples de pagamento é imediato. Mesmo que o modelo copie a data de
// vencimento para `agendar_para`, o gate remove o agendamento antes de mostrar
// a confirmação e antes de montar o POST.
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
  eq(pending.args.agendar_para, undefined, 'data inferida pelo modelo é removida');
  ok(/primeira data aceita pela Asaas/i.test(pending.confirmationText), 'confirmação mostra a primeira data aceita pelo provedor');
  ok(!/Agendada para/.test(pending.confirmationText), 'confirmação imediata não contém agendamento');
  const result = JSON.parse(await pending.run());
  const create = calls.find((x) => x.url.endsWith('/v3/bill') && x.method === 'POST');
  const body = JSON.parse(create.body);
  eq(body.scheduleDate, '2026-09-18', 'POST imediato fixa a primeira data aceita na simulação');
  eq(renderConfirmed(pending, JSON.stringify(result)), 'A Asaas aceitou o pagamento para 18/09/2026. Ele ainda aguarda processamento bancário; avisarei aqui quando concluir.', 'PENDING na data confirmada informa quando será processado');
});

// Sem a data mínima oficial, o Brambs falha fechado: não deixa a Asaas escolher
// silenciosamente o vencimento nem cria um pagamento diferente do confirmado.
await withFetch([
  { bankSlipInfo: { value: 108.45, dueDate: '2026-09-20', beneficiaryName: 'BHub', beneficiaryCpfCnpj: '***1111', allowChangeValue: false } },
], async (calls) => {
  const thread = 'financial-bill-missing-minimum-date';
  setOwnerText(thread, 'Pague este boleto agora.', 'Pague este boleto agora.');
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), thread);
  const result = await gated.run({ linha_digitavel: '123456' });
  ok(result.startsWith('NÃO registrei o pedido:'), 'ausência da data mínima falha antes da confirmação');
  ok(/primeira data.*não propus o pagamento/i.test(result), 'erro explica que nenhum pagamento foi proposto');
  eq(takePending(thread), undefined, 'não deixa uma confirmação impossível pendente');
  eq(calls.filter((x) => x.url.endsWith('/v3/bill') && x.method === 'POST').length, 0, 'não envia o pagamento sem a data oficial');
});

// Agendamento só sobrevive quando o pedido atual o diz literalmente. Se cair
// num fim de semana, o próprio código mostra a regra do próximo dia útil.
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
  eq(pending.args.agendar_para, '2026-09-20', 'data explícita fica vinculada');
  ok(/Agendada para 20\/09\/2026/.test(pending.confirmationText), 'confirmação mostra a data pedida');
  ok(/próximo dia útil, 21\/09\/2026/.test(pending.confirmationText), 'fim de semana mostra o processamento bancário');
  const result = JSON.parse(await pending.run());
  eq(result.agendado, true, 'agendamento é confirmado como agenda local');
  eq(schedules[0].executeOn, '2026-09-20', 'agenda local preserva a data explícita');
  eq(calls.filter((x) => x.url.endsWith('/v3/bill') && x.method === 'POST').length, 0, 'agendamento futuro não cria pagamento na Asaas');
  eq(calls.filter((x) => x.url.includes('/v3/bill/simulate')).length, 2, 'boleto é conferido na proposta e na confirmação');
});

// "No vencimento" usa a data verificada na simulação, sem pedir ao usuário que
// redigite o que já está no boleto e sem deixar o modelo inventá-la.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 35, dueDate: '2026-09-20', beneficiaryName: 'Empresa Vencimento', beneficiaryCpfCnpj: '***5555', allowChangeValue: false } },
], async (calls) => {
  const thread = 'financial-bill-schedule-missing';
  setOwnerText(thread, 'Paga no vencimento.', 'Paga no vencimento.');
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), thread);
  const out = await gated.run({ linha_digitavel: '123456' });
  ok(out.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO'), 'vencimento verificado gera proposta');
  const pending = takePending(thread);
  eq(pending.args.agendar_para, '2026-09-20', 'data vem do vencimento devolvido pela Asaas');
  eq(pending.args.__agendar_no_vencimento, undefined, 'marcador interno não chega à pendência');
  ok(/próximo dia útil, 21\/09\/2026/.test(pending.confirmationText), 'regra de dia útil também vale no vencimento');
  eq(calls.length, 1, 'uma única simulação oficial resolve o vencimento');
});

// Pedido genérico de agendamento sem data nem referência ao vencimento exige
// esclarecimento antes de consultar ou propor qualquer coisa.
await withFetch([], async (calls) => {
  const thread = 'financial-bill-schedule-no-date';
  setOwnerText(thread, 'Agende esse pagamento.', 'Agende esse pagamento.');
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), thread);
  const out = await gated.run({ linha_digitavel: '123456' });
  ok(out.startsWith('NÃO registrei o pedido:'), 'agendamento genérico sem data pede esclarecimento');
  eq(takePending(thread), undefined, 'não cria confirmação com data inventada');
  eq(calls.length, 0, 'não consulta o boleto antes de resolver a data');
});

// Agendamento Brambs ainda local é cancelado sem chamar o endpoint da Asaas.
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
  ok(/não exige aprovação externa/.test(pending.label), 'cancelamento local explica a jornada sem Asaas');
  const result = JSON.parse(await pending.run());
  eq(result.cancelado, true, 'cancelamento local conclui na conversa');
  eq(cancelled, 1, 'cancelamento local acontece uma vez');
  eq(calls.length, 0, 'cancelamento local não chama a Asaas');
});

// Cancelamento é outra ação confirmada: duas leituras vinculam o estado, e o
// endpoint mutável é chamado uma única vez depois do aceite textual.
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
  ok(/R\$ 108,45/.test(pending.confirmationText) && /21\/09\/2026/.test(pending.confirmationText), 'cancelamento mostra valor e data reais');
  const result = JSON.parse(await pending.run());
  eq(result.cancelado, true, 'só CANCELLED é apresentado como cancelado');
  eq(saved.at(-1).comprovanteEntregue, true, 'conclusão inline deduplica o webhook');
  eq(calls.filter((x) => x.method === 'POST' && x.url.endsWith('/v3/bill/bill-cancel-1/cancel')).length, 1, 'cancelamento faz um único POST');
  const again = JSON.parse(await pending.run());
  eq(again.ok, false, 'confirmação consumida não repete cancelamento');
  eq(calls.length, 3, 'reuso não chama a Asaas novamente');
});

// Mudança de estado/canBeCancelled entre proposta e confirmação falha fechado.
await withFetch([
  { id: 'bill-cancel-stale', status: 'PENDING', value: 20, scheduleDate: '2026-09-21', canBeCancelled: true },
  { id: 'bill-cancel-stale', status: 'BANK_PROCESSING', value: 20, scheduleDate: '2026-09-21', canBeCancelled: false },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_cancelar_pagamento_conta'), 'financial-bill-cancel-stale');
  await gated.run({ id: 'bill-cancel-stale' });
  const result = JSON.parse(await takePending('financial-bill-cancel-stale').run());
  eq(result.ok, false, 'estado alterado invalida a confirmação');
  eq(calls.filter((x) => x.method === 'POST').length, 0, 'estado alterado não envia cancelamento');
});

// Se a API aceitar o cancelamento mas ainda devolver PENDING, a resposta é
// honesta e há uma única reconciliação GET; o POST nunca é repetido.
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
    eq(ms, 60_000, 'reconciliação do cancelamento roda uma vez aos 60 segundos');
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
    eq(result.pending, true, 'cancelamento ainda não confirmado fica pendente');
    ok(/cancelamento foi solicitado/.test(result.aviso), 'resposta não afirma cancelamento antes de CANCELLED');
    await Promise.all(timers);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  eq(calls.filter((x) => x.method === 'POST' && x.url.endsWith('/cancel')).length, 1, 'cancelamento pendente não repete o POST');
  eq(calls.filter((x) => x.method === 'GET' && x.url.endsWith('/v3/bill/bill-cancel-pending')).length, 3, 'duas validações e uma única reconciliação consultam o id');
  eq(saved.at(-1).status, 'CANCELLED', 'reconciliação persiste a confirmação tardia');
  eq(saved.at(-1).comprovanteEntregue, false, 'confirmação tardia fica para a outbox avisar');
});

// Pagamento aceito como PENDING segue o mesmo contrato assíncrono do Pix. Se
// BILL_PAID chegar na espera curta, o turno entrega o comprovante sem repetir o
// POST; o registro final deduplica a notificação posterior.
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
      eq(id, 'bill-async-paid', 'espera do pagamento usa o id retornado pelo POST');
      eq(timeoutMs, 10_000, 'pagamento também aguarda no máximo dez segundos');
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
  eq(waits, 1, 'pagamento aguarda uma única vez');
  eq(result.status, 'PAID', 'webhook observado fecha o pagamento no turno');
  eq(result.pago, true, 'PAID é apresentado como pagamento concluído');
  eq(result.comprovante, 'https://www.asaas.com/comprovantes/bill-async-paid', 'turno inclui comprovante do pagamento');
  eq(saved.length, 2, 'registra PENDING e PAID sem criar outro pagamento');
  eq(saved.at(-1).comprovanteEntregue, true, 'comprovante inline deduplica aviso posterior');
  eq(calls.filter((x) => x.url.includes('/v3/bill') && !x.url.includes('/simulate')).length, 1, 'pagamento faz um único POST de criação');
  const rendered = renderConfirmed(pending, JSON.stringify(result));
  ok(rendered.includes('Pagamento') && rendered.includes('/bill-async-paid'), 'turno entrega conclusão e comprovante do pagamento');
});

// Se a janela terminar ainda em PENDING, a conversa informa processamento em
// vez de falha e o webhook poderá fechá-la depois.
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
  eq(result.pending, true, 'pagamento preserva o PENDING real');
  eq(result.data_processamento_divergente, true, 'resultado registra o desvio da data devolvida pelo provedor');
  eq(renderConfirmed(pending, JSON.stringify(result)), 'A Asaas aceitou o pagamento, mas informou processamento em 21/09/2026, diferente de 18/09/2026 que você confirmou. Ele ainda não foi pago. Não repita o pedido; avisarei aqui quando o status mudar.', 'PENDING explica a data real sem afirmar pagamento');
});

// Sem webhook dentro da janela, há exatamente uma reconciliação GET aos 60s.
// Ela atualiza o estado para a outbox entregar; jamais repete o POST financeiro.
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
    eq(ms, 60_000, 'reconciliação do pagamento roda uma vez aos 60 segundos');
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
    eq(result.pending, true, 'turno termina em processamento antes da reconciliação');
    await Promise.all(timers);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  eq(calls.filter((x) => x.url.includes('/v3/bill') && !x.url.includes('/simulate') && x.method === 'POST').length, 1, 'reconciliação não repete o POST');
  eq(calls.filter((x) => x.url.includes('/v3/bill/bill-reconcile-once') && x.method === 'GET').length, 1, 'reconciliação faz um único GET por id');
  eq(saved.at(-1).status, 'PAID', 'reconciliação persiste o estado final');
  eq(saved.at(-1).comprovanteEntregue, false, 'estado reconciliado fica para a outbox avisar na conversa');
});

// A transferência fica vinculada ao titular real consultado, não só à chave
// digitada pelo modelo. Titularidade diferente invalida a autorização.
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
  ok(proposal.startsWith('AÇÃO PENDENTE DE CONFIRMAÇÃO'), 'shape atual da Asaas gera proposta');
  const pending = takePending('financial-pix-current-owner-shape');
  ok(pending.label.includes('Pessoa no contrato atual'), 'proposta lê owner.name do contrato atual');
  ok(pending.label.includes('***.555.666-**'), 'proposta lê owner.cpfCnpj do contrato atual');
  ok(pending.label.includes('Banco Atual'), 'proposta lê financialInstitution.name do contrato atual');
  eq(calls.map((x) => x.method), ['GET'], 'shape atual só consulta antes da confirmação');
  const result = JSON.parse(await pending.run());
  eq(result.pending, true, 'shape atual preserva o estado real do Pix criado');
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'shape atual revalida titular antes do único POST');
  const rendered = renderConfirmed(pending, JSON.stringify(result));
  eq(rendered, 'O Pix está em processamento. Avisarei aqui quando concluir.', 'PENDING conhecido não vira falha incerta');
});

// Se o webhook fechar a operação dentro da espera curta, o próprio turno
// entrega DONE e comprovante sem repetir o POST. O registro final marcado como
// entregue impede a notificação assíncrona de duplicar a mensagem.
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
      eq(id, 'pix-async-done', 'espera usa o id real retornado pelo POST');
      eq(timeoutMs, 10_000, 'espera inline tem teto de dez segundos');
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
  eq(waits, 1, 'aguarda uma única vez');
  eq(result.status, 'DONE', 'webhook observado fecha o estado do turno');
  eq(result.saiu, true, 'DONE é apresentado como Pix efetivado');
  eq(result.comprovante, 'https://www.asaas.com/comprovantes/pix-async-done', 'resposta inclui comprovante persistido pelo webhook');
  eq(saved.length, 2, 'registra estado inicial e estado final sem nova transferência');
  eq(saved.at(-1).comprovanteEntregue, true, 'resposta inline deduplica o aviso posterior');
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'espera não faz outro POST nem polling externo');
  const rendered = renderConfirmed(pending, JSON.stringify(result));
  ok(rendered.includes('PIX de R$ 20 enviado') && rendered.includes('/pix-async-done'), 'turno entrega sucesso e comprovante');
});

// Incerteza de transporte continua diferente de PENDING aceito: o renderer
// mantém o aviso de não repetição nesse caso.
{
  const p = { name: 'asaas_transferir_pix', args: { valor: 20, chave_pix: 'fixture' } };
  const out = renderConfirmed(p, JSON.stringify({
    ok: true, pending: true, incerto: true, saiu: false,
    aviso: 'O resultado é incerto. Não repita.',
  }));
  ok(out.includes('não tem confirmação verificável') && out.includes('Não repita'), 'incerteza real não é suavizada como processamento normal');
}

await withFetch([
  { key: 'fixture-unknown-shape', type: 'EVP', owner: {}, financialInstitution: {} },
], async () => {
  const gated = gateTool(named(tools(), 'asaas_transferir_pix'), 'financial-pix-unknown-owner-shape');
  const out = await gated.run({ valor: 10, chave_pix: 'fixture-unknown-shape', tipo_chave: 'EVP' });
  ok(out.startsWith('NÃO registrei o pedido:'), 'shape sem titular não gera proposta');
  ok(/não prova que a chave esteja inválida ou não cadastrada/i.test(out), 'shape desconhecido não inventa chave inválida');
  eq(takePending('financial-pix-unknown-owner-shape'), undefined, 'shape sem titular não deixa confirmação pendente');
});

await withFetch([
  { name: 'Pessoa A', cpfCnpj: '***1111', institutionName: 'Banco A' },
  { name: 'Pessoa B', cpfCnpj: '***2222', institutionName: 'Banco B' },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_transferir_pix'), 'financial-pix-owner-change');
  await gated.run({ valor: 15, chave_pix: 'fixture-key', tipo_chave: 'EVP' });
  const pending = takePending('financial-pix-owner-change');
  ok(/R\$ 15,00/.test(pending.label) && /Pessoa A/.test(pending.label), 'confirmação mostra valor e titular reais');
  const result = JSON.parse(await pending.run());
  eq(result.ok, false, 'titular alterado falha fechado');
  ok(/titularidade[\s\S]*mudou/i.test(result.error), 'titular alterado exige nova conferência');
  eq(calls.map((x) => x.method), ['GET', 'GET'], 'mudança impede o POST de transferência');
  ok(calls.every((x) => x.url.includes('/v3/pix/addressKeys/external')), 'só a consulta de titularidade foi chamada');
});

// Com os mesmos dados reais na revalidação, o POST ocorre uma única vez e o
// estado retornado pelo provedor é preservado sem transformar pendência em êxito.
await withFetch([
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 42, dueDate: '2026-09-22', beneficiaryName: 'Empresa Estável', allowChangeValue: false } },
  { minimumScheduleDate: '2026-09-18', bankSlipInfo: { value: 42, dueDate: '2026-09-22', beneficiaryName: 'Empresa Estável', allowChangeValue: false } },
  { id: 'bill-1', status: 'PENDING', authorized: true, value: 42, scheduleDate: '2026-09-18' },
], async (calls) => {
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), 'financial-bill-stable');
  await gated.run({ linha_digitavel: '999' });
  const pending = takePending('financial-bill-stable');
  const result = JSON.parse(await pending.run());
  eq(result.pending, true, 'pagamento pendente continua pendente');
  eq(result.pago, false, 'pagamento pendente não vira pago');
  eq(calls.map((x) => x.url.split('/v3')[1].split('?')[0]), ['/bill/simulate', '/bill/simulate', '/bill'], 'pagamento só é criado após revalidação');
  const again = JSON.parse(await pending.run());
  eq(again.ok, false, 'mesma confirmação não executa pagamento duas vezes');
  eq(calls.length, 3, 'reuso da confirmação não faz nova chamada');
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
  eq(result.ok, true, 'Pix concluído mantém sucesso comprovado');
  eq(result.saiu, true, 'somente status DONE indica que o Pix saiu');
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'transferência só é criada após revalidar o titular');
});

// Antes do POST financeiro, a Conta Brambs prepara o webhook que entregará o
// comprovante. A mesma conta vinculada à confirmação também vai para o registro.
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
  eq(result.pending, true, 'Pix pendente continua sem falso sucesso');
  eq(preparedAfterCalls, 2, 'webhook é preparado depois da revalidação e antes do POST');
  eq(prepared.accountId, 'acc-webhook-1', 'webhook usa a conta vinculada à confirmação');
  eq(saved.accountId, 'acc-webhook-1', 'registro da operação preserva a conta real');
  eq(saved.id, 'pix-webhook-1', 'registro usa o id devolvido pela Asaas');
  eq(calls.map((x) => x.method), ['GET', 'GET', 'POST'], 'nenhuma mutação extra antes do POST financeiro');
});

// Saldo atual é só uma fotografia, nunca prova de depósito.
await withFetch([{ balance: 365 }], async () => {
  const data = JSON.parse(await named(tools(), 'asaas_saldo').run());
  eq(data.saldo, 365);
  eq(data.confirma_deposito_especifico, false);
  ok(/saldo atual isolado não prova/i.test(data.aviso), 'saldo traz limite probatório explícito');
});

const extrato = (rows) => ({ data: rows });
// Sem o valor informado, até um único crédito recente continua candidato, não
// confirmação. É exatamente o caso em que antes o agente afirmou "deu certo".
await withFetch([extrato([{ id: 'ft-1', type: 'PIX_TRANSACTION_CREDIT', value: 365, date: '2026-09-16' }])], async () => {
  const data = JSON.parse(await named(tools(), 'asaas_verificar_recebimento_pix').run({ desde: '2026-09-16' }));
  eq(data.confirmado, false);
  eq(data.motivo, 'valor_nao_informado');
  eq(data.creditos_pix_recentes.length, 1);
});

// Com valor e um único lançamento Pix no extrato, há evidência determinística.
await withFetch([extrato([
  { id: 'ft-1', type: 'PIX_TRANSACTION_CREDIT', value: 365, date: '2026-09-16' },
  { id: 'fee-1', type: 'PIX_TRANSACTION_CREDIT_FEE', value: -1, date: '2026-09-16' },
])], async () => {
  const data = JSON.parse(await named(tools(), 'asaas_verificar_recebimento_pix').run({ valor: 365, desde: '2026-09-16' }));
  eq(data.confirmado, true);
  eq(data.evidencia.id, 'ft-1');
});

// Dois créditos iguais são ambíguos, portanto não confirmam qual foi o teste.
await withFetch([extrato([
  { id: 'ft-1', type: 'PIX_TRANSACTION_CREDIT', value: 20, date: '2026-09-16' },
  { id: 'ft-2', type: 'PIX_TRANSACTION_CREDIT', value: 20, date: '2026-09-16' },
])], async () => {
  const data = JSON.parse(await named(tools(), 'asaas_verificar_recebimento_pix').run({ valor: 20, desde: '2026-09-16' }));
  eq(data.confirmado, false);
  eq(data.motivo, 'mais_de_um_lancamento_compativel');
});

console.log(`PASS ${checks}: confirmação financeira, consentimento Pix e verificação de depósito; offline only.`);
