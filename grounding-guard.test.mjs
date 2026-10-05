import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGrounding, groundingRetryPrompt, applyGroundingFallback } from './web/grounding-guard.mjs';
import { definirMarca } from './web/marca.mjs';

// Os casos POSITIVOS abaixo são transcrições reduzidas de conversas reais de
// usuários (achados de frustração do grupo 1, 18/09/2026). Cada um é uma
// resposta que foi entregue afirmando um fato que nenhuma ferramenta tinha
// consultado. Os casos NEGATIVOS existem pra provar que o freio não morde
// resposta legítima: falso positivo aqui vira repasse à toa e trecho removido
// de conversa boa, que é pior do que o bug que ele conserta.

const kinds = r => r.findings.map(f => f.kind).sort();

test('cupom inventado: códigos que não vieram de nenhuma consulta', () => {
  const texto = 'Achei estes cupons da Testani Casa:\n- TESTANI10 (10% off)\n- CASA15 (15% na primeira compra)';
  const r = checkGrounding(texto, { toolOutputs: [], toolCounts: {} });
  assert.deepEqual(kinds(r), ['cupom_nao_consultado', 'cupom_nao_consultado']);
  assert.deepEqual(r.findings.map(f => f.dado).sort(), ['CASA15', 'TESTANI10']);
});

test('cupom que veio da busca passa', () => {
  const texto = 'Achei este cupom: TESTANI10 (10% off)';
  const r = checkGrounding(texto, { toolOutputs: ['{"resultados":[{"titulo":"Cupom TESTANI10 ativo"}]}'] });
  assert.deepEqual(kinds(r), []);
});

test('fonte assinada sem leitura da fonte', () => {
  const texto = 'Reflexão do dia: a fé move.\n\nFonte: Canção Nova';
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), ['fonte_nao_lida']);
  // mesma assinatura, agora com a página realmente lida no turno
  const lido = checkGrounding(texto, { toolOutputs: ['Canção Nova — reflexão diária ...'] });
  assert.deepEqual(kinds(lido), []);
});

test('assinatura de fonte decorada com markdown', () => {
  // Como uma rotina real entregava de verdade: em itálico. A âncora
  // antiga só pegava a linha crua, então a fonte inventada passava batido.
  for (const linha of ['*Fonte: Canção Nova*', '**Fonte:** Canção Nova', '- Fonte: Canção Nova', '> Fonte: Canção Nova']) {
    const texto = `Oração do dia.\n\n${linha}`;
    assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), ['fonte_nao_lida'], linha);
    assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: ['Canção Nova — quaresma de São Miguel'] })), [], linha);
  }
});

test('preço afirmado como pesquisado sem nenhuma consulta', () => {
  const texto = 'Fiz um levantamento com base em preços reais: ida e volta por R$ 3.378, R$ 3.404 e R$ 3.322.';
  const r = checkGrounding(texto, { toolOutputs: [] });
  assert.equal(r.findings.length, 3);
  assert.ok(r.findings.every(f => f.kind === 'preco_sem_consulta'));
});

test('preço pesquisado de verdade passa, e conta do dono sem alegação de pesquisa não é tocada', () => {
  const comBusca = checkGrounding('Fiz um levantamento com base em preços reais: R$ 3.378.', {
    toolOutputs: ['{"voos":[{"preco":"R$3378,00","cia":"LATAM"}]}'],
  });
  assert.deepEqual(kinds(comBusca), []);
  const semAlegacao = checkGrounding('Somando o que você me passou, dá R$ 3.378 no total.', { toolOutputs: [] });
  assert.deepEqual(kinds(semAlegacao), []);
});

test('saldo e plano do dono afirmados sem consultar crédito', () => {
  const texto = 'Seu plano é o Pro, com 8.000 de franquia e 4.941 créditos disponíveis.';
  assert.deepEqual(kinds(checkGrounding(texto, { toolCounts: {} })), ['saldo_sem_consulta']);
  assert.deepEqual(kinds(checkGrounding(texto, { toolCounts: { consultar_creditos: 1 }, toolOutputs: ['plano pro 8000 4941'] })), []);
  // Nível 1: a plataforma entregou o saldo real no contexto do turno, então
  // responder com ele é o certo, não invenção.
  assert.deepEqual(kinds(checkGrounding(texto, { toolCounts: {}, creditDelivered: true })), []);
});

test('link cujo domínio nunca apareceu numa consulta', () => {
  const texto = 'Vale ler: https://www.bessemer.com/atlas/estado-do-cloud-2026';
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), ['link_nao_consultado']);
  // domínio devolvido pela busca
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: ['... bessemer.com/atlas ...'] })), []);
  // link que o PRÓPRIO dono mandou não é invenção nossa
  assert.deepEqual(kinds(checkGrounding(texto, { ownerText: 'olha esse https://www.bessemer.com/atlas/x' })), []);
  // domínio da própria plataforma (config da marca) vem do system prompt
  const link = 'Entra em https://minhamarca.example/habilidades';
  assert.deepEqual(kinds(checkGrounding(link, { toolOutputs: [] })), ['link_nao_consultado']);
  definirMarca({ hostsCitaveis: ['minhamarca.example'] });
  try { assert.deepEqual(kinds(checkGrounding(link, { toolOutputs: [] })), []); } finally { definirMarca(); }
});

test('fichamento de anexo sem nenhuma leitura do arquivo', () => {
  const texto = 'Segue o fichamento do documento que você mandou, com os pontos principais.';
  assert.deepEqual(kinds(checkGrounding(texto, { hadAttachment: true, toolCounts: {} })), ['arquivo_nao_lido']);
  assert.deepEqual(kinds(checkGrounding(texto, { hadAttachment: true, toolCounts: { ler_arquivo: 1 } })), []);
  // sem anexo no turno, a frase é sobre outra coisa
  assert.deepEqual(kinds(checkGrounding(texto, { hadAttachment: false })), []);
  // PDF sem camada de texto (logo, arte, escaneado) vira página-imagem na
  // biblioteca e é lido por ver_midia. Se ver_midia não contasse como leitura,
  // o freio morderia uma resposta que consultou o anexo de verdade.
  assert.deepEqual(kinds(checkGrounding(texto, { hadAttachment: true, toolCounts: { ver_midia: 1 } })), []);
});

test('resposta comum não é tocada', () => {
  const texto = 'Boa! Posso montar isso pra você. Quer que eu comece pela lista de convidados?';
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), []);
  assert.deepEqual(kinds(checkGrounding('', {})), []);
});

test('palavra maiúscula fora de contexto de cupom não vira achado', () => {
  const texto = 'O PDF está anexo e o CNPJ confere.';
  assert.deepEqual(kinds(checkGrounding(texto, { toolOutputs: [] })), []);
});

test('instrução de repasse nomeia a ferramenta que faltou', () => {
  const { findings } = checkGrounding('Fonte: Canção Nova', { toolOutputs: [] });
  const p = groundingRetryPrompt(findings);
  assert.match(p, /buscar_web/);
  assert.match(p, /não invente/i);
});

test('rede de baixo remove a linha sem base e nunca devolve silêncio', () => {
  const texto = 'Aqui vai o resumo.\nFonte: Canção Nova';
  const { findings } = checkGrounding(texto, { toolOutputs: [] });
  const out = applyGroundingFallback(texto, findings);
  assert.ok(!out.includes('Canção Nova'));
  assert.ok(out.includes('Aqui vai o resumo.'));
  assert.ok(out.trim().length > 0);
  // texto que ERA só a afirmação não some por inteiro
  const so = applyGroundingFallback('Fonte: Canção Nova', findings);
  assert.ok(so.trim().length > 0);
});
