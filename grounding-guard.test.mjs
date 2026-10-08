import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGrounding, groundingRetryPrompt, applyGroundingFallback } from './web/grounding-guard.mjs';
import { definirMarca } from './web/marca.mjs';

// The POSITIVE cases below are reduced transcripts of real user
// conversations (frustration findings from group 1, 2026-09-18). Each one is a
// response that was delivered asserting a fact that no tool had
// consulted. The NEGATIVE cases exist to prove that the guard doesn't bite a
// legitimate response: a false positive here turns into a pointless rewrite and a removed
// snippet from a good conversation, which is worse than the bug it fixes.

const kinds = r => r.findings.map(f => f.kind).sort();

test('invented coupon: codes that did not come from any lookup', () => {
  const texto = 'Achei estes cupons da Testani Casa:\n- TESTANI10 (10% off)\n- CASA15 (15% na primeira compra)';
  const r = checkGrounding(texto, { toolOutputs: [], toolCounts: {} });
  assert.deepEqual(kinds(r), ['cupom_nao_consultado', 'cupom_nao_consultado']);
  assert.deepEqual(r.findings.map(f => f.dado).sort(), ['CASA15', 'TESTANI10']);
});

test('a coupon that came from search passes', () => {
  const texto = 'Achei este cupom: TESTANI10 (10% off)';
  const r = checkGrounding(texto, { toolOutputs: ['{"resultados":[{"titulo":"Cupom TESTANI10 ativo"}]}'] });
  assert.deepEqual(kinds(r), []);
});

test('signed source without reading the source', () => {
  const texto = 'Reflexão do dia: a fé move.\n\nFonte: Canção Nova';
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), ['fonte_nao_lida']);
  // same signature, now with the page actually read in the turn
  const lido = checkGrounding(texto, { toolOutputs: ['Canção Nova — reflexão diária ...'] });
  assert.deepEqual(kinds(lido), []);
});

test('source signature decorated with markdown', () => {
  // How a real routine actually delivered it: in italics. The old
  // anchor only caught the raw line, so a made-up source slipped through.
  for (const linha of ['*Fonte: Canção Nova*', '**Fonte:** Canção Nova', '- Fonte: Canção Nova', '> Fonte: Canção Nova']) {
    const texto = `Oração do dia.\n\n${linha}`;
    assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), ['fonte_nao_lida'], linha);
    assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: ['Canção Nova — quaresma de São Miguel'] })), [], linha);
  }
});

test('price claimed as researched without any lookup', () => {
  const texto = 'Fiz um levantamento com base em preços reais: ida e volta por R$ 3.378, R$ 3.404 e R$ 3.322.';
  const r = checkGrounding(texto, { toolOutputs: [] });
  assert.equal(r.findings.length, 3);
  assert.ok(r.findings.every(f => f.kind === 'preco_sem_consulta'));
});

test('a genuinely researched price passes, and the owner balance with no research claim is left untouched', () => {
  const comBusca = checkGrounding('Fiz um levantamento com base em preços reais: R$ 3.378.', {
    toolOutputs: ['{"voos":[{"preco":"R$3378,00","cia":"Acme Air"}]}'],
  });
  assert.deepEqual(kinds(comBusca), []);
  const semAlegacao = checkGrounding('Somando o que você me passou, dá R$ 3.378 no total.', { toolOutputs: [] });
  assert.deepEqual(kinds(semAlegacao), []);
});

test("owner's balance and plan stated without checking credit", () => {
  const texto = 'Seu plano é o Pro, com 8.000 de franquia e 4.941 créditos disponíveis.';
  assert.deepEqual(kinds(checkGrounding(texto, { toolCounts: {} })), ['saldo_sem_consulta']);
  assert.deepEqual(kinds(checkGrounding(texto, { toolCounts: { consultar_creditos: 1 }, toolOutputs: ['plano pro 8000 4941'] })), []);
  // Level 1: the platform delivered the real balance in the turn's context, so
  // answering with it is correct, not invention.
  assert.deepEqual(kinds(checkGrounding(texto, { toolCounts: {}, creditDelivered: true })), []);
});

test('link whose domain never appeared in a lookup', () => {
  const texto = 'Vale ler: https://www.bessemer.com/atlas/estado-do-cloud-2026';
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), ['link_nao_consultado']);
  // domain returned by the search
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: ['... bessemer.com/atlas ...'] })), []);
  // a link the owner THEMSELVES sent is not our invention
  assert.deepEqual(kinds(checkGrounding(texto, { ownerText: 'olha esse https://www.bessemer.com/atlas/x' })), []);
  // the platform's own domain (brand config) comes from the system prompt
  const link = 'Entra em https://minhamarca.example/habilidades';
  assert.deepEqual(kinds(checkGrounding(link, { toolOutputs: [] })), ['link_nao_consultado']);
  definirMarca({ hostsCitaveis: ['minhamarca.example'] });
  try { assert.deepEqual(kinds(checkGrounding(link, { toolOutputs: [] })), []); } finally { definirMarca(); }
});

test('attachment summary without reading the file at all', () => {
  const texto = 'Segue o fichamento do documento que você mandou, com os pontos principais.';
  assert.deepEqual(kinds(checkGrounding(texto, { hadAttachment: true, toolCounts: {} })), ['arquivo_nao_lido']);
  assert.deepEqual(kinds(checkGrounding(texto, { hadAttachment: true, toolCounts: { ler_arquivo: 1 } })), []);
  // without an attachment in the turn, the sentence is about something else
  assert.deepEqual(kinds(checkGrounding(texto, { hadAttachment: false })), []);
  // A PDF without a text layer (logo, artwork, scanned) becomes an image-page in the
  // library and is read by ver_midia. If ver_midia didn't count as a read,
  // the guard would bite a response that genuinely consulted the attachment.
  assert.deepEqual(kinds(checkGrounding(texto, { hadAttachment: true, toolCounts: { ver_midia: 1 } })), []);
});

test('a plain reply is left untouched', () => {
  const texto = 'Boa! Posso montar isso pra você. Quer que eu comece pela lista de convidados?';
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), []);
  assert.deepEqual(kinds(checkGrounding('', {})), []);
});

test('an uppercase word outside a coupon context does not become a finding', () => {
  const texto = 'O PDF está anexo e o CNPJ confere.';
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), []);
});

test('the handoff instruction names the missing tool', () => {
  const { findings } = checkGrounding('Fonte: Canção Nova', { toolOutputs: [] });
  const p = groundingRetryPrompt(findings);
  assert.match(p, /buscar_web/);
  assert.match(p, /não invente/i);
});

test('the low-level net removes the unsupported line and never returns silence', () => {
  const texto = 'Aqui vai o resumo.\nFonte: Canção Nova';
  const { findings } = checkGrounding(texto, { toolOutputs: [] });
  const out = applyGroundingFallback(texto, findings);
  assert.ok(!out.includes('Canção Nova'));
  assert.ok(out.includes('Aqui vai o resumo.'));
  assert.ok(out.trim().length > 0);
  // text that WAS only the claim doesn't disappear entirely
  const so = applyGroundingFallback('Fonte: Canção Nova', findings);
  assert.ok(so.trim().length > 0);
});

// Calibration 2026-10-06: 186 real triggers in prod, no invention
// confirmed. One representative of each cause of false positive; each one has
// to pass, and the made-up case next to it keeps getting caught.
test('calibration: what has a source is not flagged', () => {
  const sem = (texto, ctx) => assert.deepEqual(kinds(checkGrounding(texto, ctx)), [], texto);
  // an accented word doesn't turn into a code ("DESCART"), "promoções" doesn't open a coupon window
  sem('*2) DESCARTÁVEIS* — propaganda, promoções, newsletter', { toolOutputs: [] });
  // line that denies the coupon
  sem('Não achei nenhum cupom ativo pra TESTANI hoje.', { toolOutputs: [] });
  // piece of address and email in the coupon line
  sem('Cupom: veja em https://loja.example/promo?utm=VERAO2026 ou fale com VENDAS@loja.example', { toolOutputs: ['loja.example'] });
  // routine material delivered by the platform to the model counts as a source
  sem('Promo do remetente MAPFRE no cupom da semana', { toolOutputs: ['De: MAPFRE comunicação'] });
  // brand-host subdomain and local address
  definirMarca({ hostsCitaveis: ['minhamarca.example'] });
  try { sem('Seu app: https://joana.minhamarca.example/planner/', { toolOutputs: [] }); } finally { definirMarca(); }
  sem('Use http://localhost:3000/callback no cadastro.', { toolOutputs: [] });
  // link montado a partir de id lido (e-mail)
  sem('Abrir: https://mail.google.com/mail/#all/1a0b54264c258800', { toolOutputs: ['{"id":"1a0b54264c258800"}'] });
  // calculation made on top of a queried value (2 passes; there and back)
  sem('Cotei agora: R$ 4.240 para duas pessoas, R$ 4.760 ida e volta.', { toolOutputs: ['{"preco":"R$ 2.120"} volta R$ 2.640'] });
  // prose around the source list when there was a consultation
  sem('Fontes: INSS (gov.br), G1, consultados agora.', { toolOutputs: ['inss gov br'], toolCounts: { buscar_web: 1 } });
  // still catches: price unrelated to what was consulted, made-up coupon and link
  assert.deepEqual(kinds(checkGrounding('Cotei agora: R$ 9.999.', { toolOutputs: ['{"preco":"R$ 2.120"}'] })), ['preco_sem_consulta']);
  assert.deepEqual(kinds(checkGrounding('Cupom: VERAO2026', { toolOutputs: [] })), ['cupom_nao_consultado']);
  assert.deepEqual(kinds(checkGrounding('Veja https://inventado.example/abc', { toolOutputs: [] })), ['link_nao_consultado']);
});

test('handoff instruction is an internal review, nothing leaks to the person', () => {
  const { findings } = checkGrounding('Cupom: VERAO2026', { toolOutputs: [] });
  for (const lang of ['pt-BR', 'en', 'es']) {
    const p = groundingRetryPrompt(findings, lang);
    assert.match(p, /VERAO2026/);
    assert.match(p, /(n[ãa]o v[êe]|not see|no ve)/i, lang);
  }
});
