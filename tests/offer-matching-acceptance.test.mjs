// Creating any routine is not the same as accepting the offer the assistant made.
//
// Finding from the 2026-09-18 scoreboard: a user received, on day 16, an offer of "resumo da
// agenda do dia às 7h", never replied, and on day 17 created an
// email-triage routine on their own. The offer was closed as ACCEPTED as a free ride,
// because the closing logic grabbed EVERY open offer the person had. Result: the
// ruler counted a conversion that never happened, and the person disappeared from the list of
// those who hadn't replied yet.
//
// The cases below are the four closed offers that existed in production on
// 2026-09-18: two genuine acceptances and two free rides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ofertaCorresponde, OFERTA_ACEITE_JANELA_MIN } from '../web/db.mjs';

const MIN = 60_000;
const base = new Date('2026-09-16T13:19:16Z').getTime();
const oferta = (titulo, offsetMin = 0) => ({ titulo, offered_at: new Date(base + offsetMin * MIN).toISOString() });

test('a routine created in the same conversation, right after the offer, is acceptance', () => {
  // Bianca's real case: offer at 18:39, routine at 18:41.
  const o = oferta('Resumo semanal de gastos');
  assert.equal(ofertaCorresponde(o, { titulo: 'Resumo Semanal de Gastos', criadaEm: base + 2 * MIN }), true);
  // Even with the title rewritten by the assistant, the proximity is enough.
  assert.equal(ofertaCorresponde(o, { titulo: 'Fechamento da semana', criadaEm: base + 2 * MIN }), true);
});

test('outside the window, it only closes if the routine talks about the same subject', () => {
  const o = oferta('Resumo matinal da agenda e pendências do dia às 8h');
  const tarde = base + (OFERTA_ACEITE_JANELA_MIN + 1) * MIN;
  assert.equal(ofertaCorresponde(o, { titulo: 'Resumo matinal da agenda e pendências', criadaEm: tarde }), true);
});

test('16/09 free ride: an email routine doesn\'t accept a calendar offer', () => {
  const o = oferta('resumo da agenda do dia às 7h');
  const umDiaDepois = base + 32 * 60 * MIN;
  assert.equal(ofertaCorresponde(o, { titulo: 'E-mails por destino — manhã', criadaEm: umDiaDepois }), false);
});

test('another free ride: a weekly bill sweep doesn\'t accept a monthly reminder for one bill', () => {
  const o = oferta('Lembrete mensal no dia 14 para pagar Tokio Marine');
  const cincoDias = base + 5 * 24 * 60 * MIN;
  assert.equal(ofertaCorresponde(o, { titulo: 'Faturas e boletos da semana', criadaEm: cincoDias }), false);
});

test('one shared content word isn\'t enough, a connector word doesn\'t count', () => {
  const tarde = base + 24 * 60 * MIN;
  // "summary" alone would match half the product's routines.
  assert.equal(ofertaCorresponde(oferta('Resumo da agenda do dia'), { titulo: 'Resumo dos treinos', criadaEm: tarde }), false);
  // Only shared connector words ("para", "todos") don't say anything about the subject.
  assert.equal(ofertaCorresponde(oferta('Aviso para pagar todos os boletos'), { titulo: 'Playlist para todos os dias', criadaEm: tarde }), false);
});

test('accent, case and punctuation don\'t get in the way of matching', () => {
  const tarde = base + 24 * 60 * MIN;
  assert.equal(ofertaCorresponde(oferta('Resumo semanal de gastos'), { titulo: 'RESUMO, SEMANAL — gastos!', criadaEm: tarde }), true);
  assert.equal(ofertaCorresponde(oferta('Relatório de pendências'), { titulo: 'relatorio de pendencias', criadaEm: tarde }), true);
});

test('a routine created BEFORE the offer is never its acceptance', () => {
  const o = oferta('Resumo semanal de gastos');
  assert.equal(ofertaCorresponde(o, { titulo: 'Qualquer coisa', criadaEm: base - 5 * MIN }), false);
  assert.equal(ofertaCorresponde(null, { titulo: 'x' }), false);
});
