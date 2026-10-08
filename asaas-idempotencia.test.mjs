// A retry can't pay twice (finding #10), and the card has to tell the
// truth about what happened (findings #11, #12 and #13).
//
// Asaas has no idempotency header on /v3/bill nor on /v3/transfers.
// What it has is `externalReference`: an identifier of OURS that goes in the POST
// and comes back on every read. So the contract proven here is:
//   1. every financial POST carries its own mark;
//   2. the mark is born together with the confirmation, not at send time;
//   3. when the outcome is uncertain (connection dropped, server error), the code
//      LOOKS UP the operation by the mark before responding with anything;
//   4. not finding it becomes explicit uncertainty, never "nothing happened";
//   5. a validation refusal (HTTP 400/429) stays a refusal, without a lookup.
// All offline: no call leaves this process.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asaasTools } from './web/connectors-vault.mjs';
import { gateTool, takePending, renderConfirmed } from './web/confirm.mjs';

let checks = 0;
const ok = (value, label) => { assert.ok(value, label); checks++; };
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };

const originalFetch = globalThis.fetch;
// Each response can be: a body (HTTP 200), `{ __erro: <status>, corpo }`,
// `{ __cai: 'motivo' }` (connection dies before any response) or a function
// that receives the calls already made and returns the body (to build the reconciliation
// listing with the SAME mark the POST just sent).
const withFetch = async (answers, fn) => {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({
      url: String(url),
      method: opts.method || 'GET',
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    if (!answers.length) throw new Error(`fetch inesperado: ${url}`);
    const resposta = answers.shift();
    if (resposta && resposta.__cai) throw new Error(resposta.__cai);
    const status = resposta && resposta.__erro ? resposta.__erro : 200;
    const corpo = resposta && resposta.__erro
      ? (resposta.corpo || {})
      : (typeof resposta === 'function' ? resposta(calls) : resposta);
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(corpo) };
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
const posts = (calls, caminho) => calls.filter((c) => c.method === 'POST' && c.url.split('?')[0].endsWith(caminho));
const marcaDoPost = (calls, caminho) => posts(calls, caminho)[0]?.body?.externalReference;
// Returns the operation that already exists on Asaas's side, stamped with the mark the
// lost POST carried. It's the "the request arrived, it was the response that got lost" scenario.
const achadaComAMarca = (caminho, dados) => (calls) => ({
  data: [{ ...dados, externalReference: marcaDoPost(calls, caminho) }],
  hasMore: false,
});

const boleto = {
  bankSlipInfo: {
    value: 42, dueDate: '2026-09-22', beneficiaryName: 'Empresa Estável',
    beneficiaryCpfCnpj: '***1234', allowChangeValue: false,
  },
  // Asaas's real simulation returns the first accepted date; without it the product
  // refuses to propose the payment (doesn't let Asaas take over the due date).
  minimumScheduleDate: '2026-09-22',
};
const titular = { name: 'Pessoa Estável', cpfCnpj: '***3333', institutionName: 'Banco C' };

const prepararBoleto = async (thread) => {
  const gated = gateTool(named(tools(), 'asaas_pagar_conta'), thread);
  await gated.run({ linha_digitavel: '999' });
  return takePending(thread);
};
const prepararPix = async (thread) => {
  const gated = gateTool(named(tools(), 'asaas_transferir_pix'), thread);
  await gated.run({ valor: 12.5, chave_pix: 'stable-key', tipo_chave: 'EVP' });
  return takePending(thread);
};

// ── 1. Every financial POST goes out stamped, and the happy path doesn't gain a single extra call ──
await withFetch([boleto, boleto, { id: 'bill-1', status: 'PENDING', authorized: true, value: 42 }], async (calls) => {
  const pending = await prepararBoleto('marca-bill-feliz');
  const r = JSON.parse(await pending.run());
  eq(r.pending, true, 'pagamento pendente segue pendente');
  ok(/^brambs-bill-/.test(marcaDoPost(calls, '/v3/bill')), 'o POST do boleto leva marca própria');
  eq(calls.length, 3, 'caminho feliz do boleto não faz consulta extra');
});

await withFetch([titular, titular, { id: 'pix-1', status: 'DONE', authorized: true, value: 12.5 }], async (calls) => {
  const pending = await prepararPix('marca-pix-feliz');
  const r = JSON.parse(await pending.run());
  eq(r.saiu, true, 'Pix concluído segue concluído');
  ok(/^brambs-pix-/.test(marcaDoPost(calls, '/v3/transfers')), 'o POST do Pix leva marca própria');
  eq(calls.length, 3, 'caminho feliz do Pix não faz consulta extra');
});

// ── 2. The mark is born with the confirmation, not with the send ──
// This is what makes a retry RECOGNIZABLE: the same confirmed request always carries
// the same identifier, so the operation can be found instead of repeated.
const fonte = readFileSync(new URL('./web/connectors-vault.mjs', import.meta.url), 'utf8');
eq((fonte.match(/const marca = novaMarca\(/g) || []).length, 2, 'as duas ações financeiras mintam a marca na confirmação');
ok(/executarPagamento\(args, sim, vinculada\.request, vinculada\.rotulo, vinculada\.boundAccount, marca\)/.test(fonte),
  'a confirmação do boleto repassa a marca pra execução');
ok(/executarTransferencia\(args, titular, vinculada\.request, vinculada\.rotulo, vinculada\.boundAccount, marca\)/.test(fonte),
  'a confirmação do Pix repassa a marca pra execução');

// ── 3. Lost response: looks up by the mark and uses the REAL state, without resending ──
await withFetch([
  boleto, boleto,
  { __cai: 'socket hang up' },
  achadaComAMarca('/v3/bill', { id: 'bill-recuperado', status: 'PENDING', authorized: true, value: 42 }),
], async (calls) => {
  const pending = await prepararBoleto('marca-bill-recupera');
  const r = JSON.parse(await pending.run());
  eq(posts(calls, '/v3/bill').length, 1, 'conexão caída NÃO gera um segundo pagamento');
  eq(r.id, 'bill-recuperado', 'o pagamento encontrado pela marca é o que vale');
  eq(r.incerto, undefined, 'operação encontrada não é incerteza');
  eq(r.pending, true, 'estado real preservado');
});

await withFetch([
  titular, titular,
  { __cai: 'ECONNRESET' },
  achadaComAMarca('/v3/transfers', { id: 'pix-recuperado', status: 'DONE', authorized: true, value: 12.5, transactionReceiptUrl: 'https://www.asaas.com/comprovantes/rec-1' }),
], async (calls) => {
  const pending = await prepararPix('marca-pix-recupera');
  const r = JSON.parse(await pending.run());
  eq(posts(calls, '/v3/transfers').length, 1, 'conexão caída NÃO gera um segundo Pix');
  eq(r.id, 'pix-recuperado', 'a transferência encontrada pela marca é a que vale');
  eq(r.saiu, true, 'estado real preservado');
  const listagem = calls[calls.length - 1];
  eq(listagem.method, 'GET', 'a reconciliação só consulta');
  ok(decodeURIComponent(listagem.url).includes('dateCreated[ge]'),
    'a listagem de transferências usa a janela de data (a Asaas não filtra por marca)');
});

// ── 4. Not finding it becomes explicit uncertainty, never "nothing happened" ──
for (const caso of [
  { rotulo: 'erro de servidor', resposta: { __erro: 500, corpo: { __raw: 'Internal Server Error' } } },
  { rotulo: 'tempo esgotado', resposta: { __erro: 408, corpo: {} } },
  { rotulo: 'conexão caída', resposta: { __cai: 'network timeout' } },
]) {
  await withFetch([boleto, boleto, caso.resposta, { data: [], hasMore: false }], async (calls) => {
    const pending = await prepararBoleto(`marca-bill-incerto-${caso.rotulo}`);
    const bruto = await pending.run();
    const r = JSON.parse(bruto);
    eq(posts(calls, '/v3/bill').length, 1, `${caso.rotulo}: um único POST`);
    eq(r.incerto, true, `${caso.rotulo}: desfecho marcado como incerto`);
    eq(r.pago, false, `${caso.rotulo}: nunca afirma que pagou`);
    ok(/^brambs-bill-/.test(r.referencia), `${caso.rotulo}: devolve a marca pra conferência posterior`);
    const cartao = renderConfirmed(pending, bruto);
    ok(cartao.includes('não tem confirmação verificável'), `${caso.rotulo}: o cartão não afirma sucesso`);
    ok(cartao.includes('pode ter sido feito'), `${caso.rotulo}: o cartão avisa que o pagamento pode ter saído`);
    ok(!/recusou/i.test(cartao), `${caso.rotulo}: falha de transporte não vira "a Asaas recusou"`);
    ok(!/externalReference|HTTP|__/.test(cartao), `${caso.rotulo}: o aviso não despeja jargão`);
  });
}

await withFetch([titular, titular, { __erro: 502, corpo: {} }, { data: [], hasMore: false }], async (calls) => {
  const pending = await prepararPix('marca-pix-incerto');
  const bruto = await pending.run();
  const r = JSON.parse(bruto);
  eq(posts(calls, '/v3/transfers').length, 1, 'Pix incerto não é reenviado');
  eq(r.incerto, true, 'Pix incerto é marcado como incerto');
  eq(r.saiu, false, 'Pix incerto nunca afirma que saiu');
  ok(renderConfirmed(pending, bruto).includes('pode ter saído'), 'o cartão do Pix avisa que ele pode ter saído');
});

// An operation from ANOTHER request in the same window can't be mistaken for ours.
await withFetch([
  boleto, boleto,
  { __cai: 'socket hang up' },
  { data: [{ id: 'bill-de-outra-pessoa', status: 'PAID', externalReference: 'brambs-bill-outro-pedido' }], hasMore: false },
], async () => {
  const pending = await prepararBoleto('marca-bill-nao-confunde');
  const r = JSON.parse(await pending.run());
  eq(r.incerto, true, 'marca diferente não conta como a nossa operação');
  eq(r.id, undefined, 'não adota o id de outro pagamento');
});

// ── 5. A refusal stays a refusal: in that case the money did NOT go out ──
for (const caso of [
  { status: 400, corpo: { errors: [{ description: 'Boleto já pago' }] }, rotulo: 'validação' },
  { status: 429, corpo: { __raw: 'Too Many Requests' }, rotulo: 'excesso de chamadas' },
]) {
  await withFetch([boleto, boleto, { __erro: caso.status, corpo: caso.corpo }], async (calls) => {
    const pending = await prepararBoleto(`marca-bill-recusa-${caso.status}`);
    const r = JSON.parse(await pending.run());
    eq(r.ok, false, `${caso.rotulo}: recusa é recusa`);
    ok(/A Asaas recusou/.test(r.error), `${caso.rotulo}: explica que quem recusou foi a Asaas`);
    eq(calls.length, 3, `${caso.rotulo}: recusa não dispara reconciliação`);
  });
}

// ── #11 — "Pix sent" only when the Pix really went out (already fixed on main) ──
await withFetch([titular, titular, { id: 'pix-nao-autorizado', status: 'PENDING', authorized: false, value: 12.5 }], async () => {
  const pending = await prepararPix('pix-sem-autorizacao');
  const bruto = await pending.run();
  const r = JSON.parse(bruto);
  eq(r.saiu, false, 'Pix esperando autorização não saiu');
  eq(r.pending, true, 'Pix esperando autorização fica pendente');
  ok(/ainda NÃO saiu/.test(r.aviso), 'o resultado diz que o Pix ainda não saiu');
  const cartao = renderConfirmed(pending, bruto);
  ok(!/enviado/i.test(cartao), 'o cartão não anuncia Pix enviado');
  ok(cartao.includes('autorização'), 'o cartão diz o que falta: autorizar');
});

await withFetch([boleto, boleto, { id: 'bill-nao-autorizado', status: 'PENDING', authorized: false, value: 42 }], async () => {
  const pending = await prepararBoleto('bill-sem-autorizacao');
  const cartao = renderConfirmed(pending, await pending.run());
  ok(!/confirmado pela Asaas/.test(cartao), 'o cartão não anuncia pagamento confirmado');
  ok(cartao.includes('autorização'), 'o cartão diz que falta autorizar');
});

// ── #12 and #13 — completed action delivers proof, and the card stops saying "no confirmation" ──
await withFetch([boleto, boleto, {
  id: 'bill-pago', status: 'PAID', authorized: true, value: 42,
  paymentDate: '2026-09-17', transactionReceiptUrl: 'https://www.asaas.com/comprovantes/bill-pago',
}], async () => {
  const pending = await prepararBoleto('bill-com-comprovante');
  const bruto = await pending.run();
  const r = JSON.parse(bruto);
  eq(r.pago, true, 'boleto pago é pago');
  eq(r.comprovante, 'https://www.asaas.com/comprovantes/bill-pago', 'o resultado devolve o comprovante');
  const cartao = renderConfirmed(pending, bruto);
  ok(!cartao.includes('confirmação verificável'), 'pagamento concluído não aparece como sem confirmação');
  ok(cartao.includes('https://www.asaas.com/comprovantes/bill-pago'), 'o cartão entrega o link do comprovante');
});

await withFetch([titular, titular, {
  id: 'pix-feito', status: 'DONE', authorized: true, value: 12.5,
  transactionReceiptUrl: 'https://www.asaas.com/comprovantes/pix-feito',
}], async () => {
  const pending = await prepararPix('pix-com-comprovante');
  const bruto = await pending.run();
  const r = JSON.parse(bruto);
  eq(r.comprovante, 'https://www.asaas.com/comprovantes/pix-feito', 'o Pix concluído devolve o comprovante');
  const cartao = renderConfirmed(pending, bruto);
  ok(!cartao.includes('confirmação verificável'), 'Pix concluído não aparece como sem confirmação');
  ok(cartao.includes('https://www.asaas.com/comprovantes/pix-feito'), 'o cartão entrega o link do comprovante');
});

console.log(`PASS ${checks}: marca de idempotência, reconciliação por marca e cartão honesto; offline only.`);
