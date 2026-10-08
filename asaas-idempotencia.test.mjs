// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
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
  eq(r.pending, true, 'pending payment stays pending');
  ok(/^brambs-bill-/.test(marcaDoPost(calls, '/v3/bill')), 'the bill POST carries its own mark');
  eq(calls.length, 3, 'the bill happy path makes no extra query');
});

await withFetch([titular, titular, { id: 'pix-1', status: 'DONE', authorized: true, value: 12.5 }], async (calls) => {
  const pending = await prepararPix('marca-pix-feliz');
  const r = JSON.parse(await pending.run());
  eq(r.saiu, true, 'completed Pix stays completed');
  ok(/^brambs-pix-/.test(marcaDoPost(calls, '/v3/transfers')), 'the Pix POST carries its own mark');
  eq(calls.length, 3, 'the Pix happy path makes no extra query');
});

// ── 2. The mark is born with the confirmation, not with the send ──
// This is what makes a retry RECOGNIZABLE: the same confirmed request always carries
// the same identifier, so the operation can be found instead of repeated.
const fonte = readFileSync(new URL('./web/connectors-vault.mjs', import.meta.url), 'utf8');
eq((fonte.match(/const marca = novaMarca\(/g) || []).length, 2, 'both financial actions mint the mark at confirmation');
ok(/executarPagamento\(args, sim, vinculada\.request, vinculada\.rotulo, vinculada\.boundAccount, marca\)/.test(fonte),
  'the bill confirmation passes the mark through to execution');
ok(/executarTransferencia\(args, titular, vinculada\.request, vinculada\.rotulo, vinculada\.boundAccount, marca\)/.test(fonte),
  'the Pix confirmation passes the mark through to execution');

// ── 3. Lost response: looks up by the mark and uses the REAL state, without resending ──
await withFetch([
  boleto, boleto,
  { __cai: 'socket hang up' },
  achadaComAMarca('/v3/bill', { id: 'bill-recuperado', status: 'PENDING', authorized: true, value: 42 }),
], async (calls) => {
  const pending = await prepararBoleto('marca-bill-recupera');
  const r = JSON.parse(await pending.run());
  eq(posts(calls, '/v3/bill').length, 1, 'dropped connection does NOT create a second payment');
  eq(r.id, 'bill-recuperado', 'the payment found by the mark is the one that counts');
  eq(r.incerto, undefined, 'a found operation is not uncertainty');
  eq(r.pending, true, 'real state preserved');
});

await withFetch([
  titular, titular,
  { __cai: 'ECONNRESET' },
  achadaComAMarca('/v3/transfers', { id: 'pix-recuperado', status: 'DONE', authorized: true, value: 12.5, transactionReceiptUrl: 'https://www.asaas.com/comprovantes/rec-1' }),
], async (calls) => {
  const pending = await prepararPix('marca-pix-recupera');
  const r = JSON.parse(await pending.run());
  eq(posts(calls, '/v3/transfers').length, 1, 'dropped connection does NOT create a second Pix');
  eq(r.id, 'pix-recuperado', 'the transfer found by the mark is the one that counts');
  eq(r.saiu, true, 'real state preserved');
  const listagem = calls[calls.length - 1];
  eq(listagem.method, 'GET', 'reconciliation only queries');
  ok(decodeURIComponent(listagem.url).includes('dateCreated[ge]'),
    'the transfer listing uses the date window (Asaas does not filter by mark)');
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
    eq(posts(calls, '/v3/bill').length, 1, `${caso.rotulo}: a single POST`);
    eq(r.incerto, true, `${caso.rotulo}: outcome marked as uncertain`);
    eq(r.pago, false, `${caso.rotulo}: never claims it paid`);
    ok(/^brambs-bill-/.test(r.referencia), `${caso.rotulo}: returns the mark for later verification`);
    const cartao = renderConfirmed(pending, bruto);
    ok(cartao.includes('não tem confirmação verificável'), `${caso.rotulo}: the card does not claim success`);
    ok(cartao.includes('pode ter sido feito'), `${caso.rotulo}: the card warns the payment may have gone out`);
    ok(!/recusou/i.test(cartao), `${caso.rotulo}: transport failure does not become "a Asaas recusou"`);
    ok(!/externalReference|HTTP|__/.test(cartao), `${caso.rotulo}: the warning does not dump jargon`);
  });
}

await withFetch([titular, titular, { __erro: 502, corpo: {} }, { data: [], hasMore: false }], async (calls) => {
  const pending = await prepararPix('marca-pix-incerto');
  const bruto = await pending.run();
  const r = JSON.parse(bruto);
  eq(posts(calls, '/v3/transfers').length, 1, 'uncertain Pix is not resent');
  eq(r.incerto, true, 'uncertain Pix is marked as uncertain');
  eq(r.saiu, false, 'uncertain Pix never claims it went out');
  ok(renderConfirmed(pending, bruto).includes('pode ter saído'), 'the Pix card warns it may have gone out');
});

// An operation from ANOTHER request in the same window can't be mistaken for ours.
await withFetch([
  boleto, boleto,
  { __cai: 'socket hang up' },
  { data: [{ id: 'bill-de-outra-pessoa', status: 'PAID', externalReference: 'brambs-bill-outro-pedido' }], hasMore: false },
], async () => {
  const pending = await prepararBoleto('marca-bill-nao-confunde');
  const r = JSON.parse(await pending.run());
  eq(r.incerto, true, 'a different mark does not count as our operation');
  eq(r.id, undefined, 'does not adopt the id of another payment');
});

// ── 5. A refusal stays a refusal: in that case the money did NOT go out ──
for (const caso of [
  { status: 400, corpo: { errors: [{ description: 'Boleto já pago' }] }, rotulo: 'validação' },
  { status: 429, corpo: { __raw: 'Too Many Requests' }, rotulo: 'excesso de chamadas' },
]) {
  await withFetch([boleto, boleto, { __erro: caso.status, corpo: caso.corpo }], async (calls) => {
    const pending = await prepararBoleto(`marca-bill-recusa-${caso.status}`);
    const r = JSON.parse(await pending.run());
    eq(r.ok, false, `${caso.rotulo}: a refusal is a refusal`);
    ok(/A Asaas recusou/.test(r.error), `${caso.rotulo}: explains that Asaas was the one who refused`);
    eq(calls.length, 3, `${caso.rotulo}: a refusal does not trigger reconciliation`);
  });
}

// ── #11 — "Pix sent" only when the Pix really went out (already fixed on main) ──
await withFetch([titular, titular, { id: 'pix-nao-autorizado', status: 'PENDING', authorized: false, value: 12.5 }], async () => {
  const pending = await prepararPix('pix-sem-autorizacao');
  const bruto = await pending.run();
  const r = JSON.parse(bruto);
  eq(r.saiu, false, 'Pix awaiting authorization did not go out');
  eq(r.pending, true, 'Pix awaiting authorization stays pending');
  ok(/ainda NÃO saiu/.test(r.aviso), 'the result says the Pix has not gone out yet');
  const cartao = renderConfirmed(pending, bruto);
  ok(!/enviado/i.test(cartao), 'the card does not announce Pix sent');
  ok(cartao.includes('autorização'), 'the card says what is missing: authorize');
});

await withFetch([boleto, boleto, { id: 'bill-nao-autorizado', status: 'PENDING', authorized: false, value: 42 }], async () => {
  const pending = await prepararBoleto('bill-sem-autorizacao');
  const cartao = renderConfirmed(pending, await pending.run());
  ok(!/confirmado pela Asaas/.test(cartao), 'the card does not announce confirmed payment');
  ok(cartao.includes('autorização'), 'the card says authorization is still needed');
});

// ── #12 and #13 — completed action delivers proof, and the card stops saying "no confirmation" ──
await withFetch([boleto, boleto, {
  id: 'bill-pago', status: 'PAID', authorized: true, value: 42,
  paymentDate: '2026-09-17', transactionReceiptUrl: 'https://www.asaas.com/comprovantes/bill-pago',
}], async () => {
  const pending = await prepararBoleto('bill-com-comprovante');
  const bruto = await pending.run();
  const r = JSON.parse(bruto);
  eq(r.pago, true, 'a paid bill is paid');
  eq(r.comprovante, 'https://www.asaas.com/comprovantes/bill-pago', 'the result returns the receipt');
  const cartao = renderConfirmed(pending, bruto);
  ok(!cartao.includes('confirmação verificável'), 'completed payment does not show as unconfirmed');
  ok(cartao.includes('https://www.asaas.com/comprovantes/bill-pago'), 'the card delivers the receipt link');
});

await withFetch([titular, titular, {
  id: 'pix-feito', status: 'DONE', authorized: true, value: 12.5,
  transactionReceiptUrl: 'https://www.asaas.com/comprovantes/pix-feito',
}], async () => {
  const pending = await prepararPix('pix-com-comprovante');
  const bruto = await pending.run();
  const r = JSON.parse(bruto);
  eq(r.comprovante, 'https://www.asaas.com/comprovantes/pix-feito', 'the completed Pix returns the receipt');
  const cartao = renderConfirmed(pending, bruto);
  ok(!cartao.includes('confirmação verificável'), 'completed Pix does not show as unconfirmed');
  ok(cartao.includes('https://www.asaas.com/comprovantes/pix-feito'), 'the card delivers the receipt link');
});

console.log(`PASS ${checks}: marca de idempotência, reconciliação por marca e cartão honesto; offline only.`);
