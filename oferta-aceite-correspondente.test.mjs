// Criar uma rotina qualquer não é aceitar a oferta que o assistente fez.
//
// Achado do placar de 18/09: um usuário recebeu no dia 16 uma oferta de "resumo da
// agenda do dia às 7h", nunca respondeu, e no dia 17 criou por conta própria uma
// rotina de triagem de e-mails. A oferta foi fechada como ACEITA de carona,
// porque o fechamento pegava TODA oferta aberta da pessoa. Resultado: a régua
// contava uma conversão que não houve e a pessoa sumia da lista de quem ainda
// não respondeu.
//
// Os casos abaixo são as quatro ofertas fechadas que existiam em produção em
// 18/09: duas aceitações de verdade e duas caronas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ofertaCorresponde, OFERTA_ACEITE_JANELA_MIN } from './web/db.mjs';

const MIN = 60_000;
const base = new Date('2026-09-16T13:19:16Z').getTime();
const oferta = (titulo, offsetMin = 0) => ({ titulo, offered_at: new Date(base + offsetMin * MIN).toISOString() });

test('rotina criada na mesma conversa, logo depois da oferta, é aceitação', () => {
  // Caso real da Bianca: oferta às 18:39, rotina às 18:41.
  const o = oferta('Resumo semanal de gastos');
  assert.equal(ofertaCorresponde(o, { titulo: 'Resumo Semanal de Gastos', criadaEm: base + 2 * MIN }), true);
  // Mesmo com título reescrito pelo assistente, a proximidade basta.
  assert.equal(ofertaCorresponde(o, { titulo: 'Fechamento da semana', criadaEm: base + 2 * MIN }), true);
});

test('fora da janela, só fecha se a rotina falar do mesmo assunto', () => {
  const o = oferta('Resumo matinal da agenda e pendências do dia às 8h');
  const tarde = base + (OFERTA_ACEITE_JANELA_MIN + 1) * MIN;
  assert.equal(ofertaCorresponde(o, { titulo: 'Resumo matinal da agenda e pendências', criadaEm: tarde }), true);
});

test('carona de 16/09: rotina de e-mails não aceita oferta de agenda', () => {
  const o = oferta('resumo da agenda do dia às 7h');
  const umDiaDepois = base + 32 * 60 * MIN;
  assert.equal(ofertaCorresponde(o, { titulo: 'E-mails por destino — manhã', criadaEm: umDiaDepois }), false);
});

test('outra carona: varredura semanal de faturas não aceita lembrete mensal de um boleto', () => {
  const o = oferta('Lembrete mensal no dia 14 para pagar Tokio Marine');
  const cincoDias = base + 5 * 24 * 60 * MIN;
  assert.equal(ofertaCorresponde(o, { titulo: 'Faturas e boletos da semana', criadaEm: cincoDias }), false);
});

test('uma palavra de conteúdo em comum não basta, palavra de ligação não conta', () => {
  const tarde = base + 24 * 60 * MIN;
  // "resumo" sozinho casaria com metade das rotinas do produto.
  assert.equal(ofertaCorresponde(oferta('Resumo da agenda do dia'), { titulo: 'Resumo dos treinos', criadaEm: tarde }), false);
  // Só palavras de ligação em comum ("para", "todos") não dizem nada do assunto.
  assert.equal(ofertaCorresponde(oferta('Aviso para pagar todos os boletos'), { titulo: 'Playlist para todos os dias', criadaEm: tarde }), false);
});

test('acento, caixa e pontuação não atrapalham a correspondência', () => {
  const tarde = base + 24 * 60 * MIN;
  assert.equal(ofertaCorresponde(oferta('Resumo semanal de gastos'), { titulo: 'RESUMO, SEMANAL — gastos!', criadaEm: tarde }), true);
  assert.equal(ofertaCorresponde(oferta('Relatório de pendências'), { titulo: 'relatorio de pendencias', criadaEm: tarde }), true);
});

test('rotina criada ANTES da oferta nunca é a aceitação dela', () => {
  const o = oferta('Resumo semanal de gastos');
  assert.equal(ofertaCorresponde(o, { titulo: 'Qualquer coisa', criadaEm: base - 5 * MIN }), false);
  assert.equal(ofertaCorresponde(null, { titulo: 'x' }), false);
});
