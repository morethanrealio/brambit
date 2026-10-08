// Tests the cadence of the "your credits ran out" notice inside a scheduled routine.
// Rule (09/09/2026): 1 notice per WEEK and per PERSON. In silenced runs the
// routine still runs, without calling the model, at zero cost.
// Pure, offline, no database. Run with: node rotina-aviso-credito.test.mjs

import { deveAvisarRotinaSemCredito, ROUTINE_CREDIT_WARN_MS } from './web/rotina-aviso-credito.mjs';

let ok = 0, fail = 0;
const t = (nome, cond) => { if (cond) { ok++; console.log('  ok  ', nome); } else { fail++; console.log('  FALHA', nome); } };

const AGORA = Date.parse('2026-09-09T12:00:00Z');
const atras = (ms) => new Date(AGORA - ms).toISOString();
const DIA = 86400_000;
const CICLO = '2026-09-01';

// 1) Primeira vez: nunca avisou essa pessoa -> avisa.
t('sem marca nenhuma, avisa',
  deveAvisarRotinaSemCredito({ marca: null, periodStart: CICLO, agora: AGORA }) === true);
t('marca vazia, avisa',
  deveAvisarRotinaSemCredito({ marca: {}, periodStart: CICLO, agora: AGORA }) === true);

// 2) Within the window, same cycle -> silence. This is the case the fix targets:
// a daily routine delivered one notice per day (42 in 30 days in the DB).
t('avisou há 2 dias no mesmo ciclo, cala',
  deveAvisarRotinaSemCredito({ marca: { at: atras(2 * DIA), period: CICLO }, periodStart: CICLO, agora: AGORA }) === false);
t('avisou há 6d23h no mesmo ciclo, ainda cala',
  deveAvisarRotinaSemCredito({ marca: { at: atras(ROUTINE_CREDIT_WARN_MS - 3600_000), period: CICLO }, periodStart: CICLO, agora: AGORA }) === false);

// 3) Passou a semana -> avisa de novo.
t('avisou há exatamente 7 dias, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(ROUTINE_CREDIT_WARN_MS), period: CICLO }, periodStart: CICLO, agora: AGORA }) === true);
t('avisou há 8 dias, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(8 * DIA), period: CICLO }, periodStart: CICLO, agora: AGORA }) === true);

// 4) Credit cycle rolled over: whoever topped up and ran out again days later
// needs to know, even within the 7 days.
t('ciclo novo dentro da janela, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(2 * DIA), period: '2026-08-01' }, periodStart: CICLO, agora: AGORA }) === true);
t('marca sem period, com ciclo conhecido, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(2 * DIA) }, periodStart: CICLO, agora: AGORA }) === true);

// 5) Corrupted mark or no date -> notify (err on the side of notifying, not staying silent).
t('at inválido, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: 'ontem', period: CICLO }, periodStart: CICLO, agora: AGORA }) === true);
t('at ausente, avisa',
  deveAvisarRotinaSemCredito({ marca: { period: CICLO }, periodStart: CICLO, agora: AGORA }) === true);

// 6) No periodStart (couldn't read the cycle): decides by the window alone, doesn't notify for no reason.
t('sem periodStart e dentro da janela, cala',
  deveAvisarRotinaSemCredito({ marca: { at: atras(2 * DIA), period: CICLO }, agora: AGORA }) === false);
t('sem periodStart e fora da janela, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(8 * DIA), period: CICLO }, agora: AGORA }) === true);

// 7) No argument at all: must not blow up, notifies.
t('chamada sem argumentos, avisa', deveAvisarRotinaSemCredito() === true);

// 8) The window is the agreed-upon week.
t('janela = 7 dias', ROUTINE_CREDIT_WARN_MS === 7 * DIA);

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
