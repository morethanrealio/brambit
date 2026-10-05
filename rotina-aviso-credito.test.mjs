// Teste da cadência do aviso "seus créditos acabaram" dentro de rotina agendada.
// Regra (Marcos, 09/09/2026): 1 aviso por SEMANA e por PESSOA. Nas execuções
// silenciadas a rotina roda mesmo assim, sem chamar modelo, custo zero.
// Puro, offline, sem banco. Roda com: node rotina-aviso-credito.test.mjs

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

// 2) Dentro da janela, mesmo ciclo -> silêncio. É o caso que o conserto ataca:
// rotina diária levava um aviso por dia (42 em 30 dias na base).
t('avisou há 2 dias no mesmo ciclo, cala',
  deveAvisarRotinaSemCredito({ marca: { at: atras(2 * DIA), period: CICLO }, periodStart: CICLO, agora: AGORA }) === false);
t('avisou há 6d23h no mesmo ciclo, ainda cala',
  deveAvisarRotinaSemCredito({ marca: { at: atras(ROUTINE_CREDIT_WARN_MS - 3600_000), period: CICLO }, periodStart: CICLO, agora: AGORA }) === false);

// 3) Passou a semana -> avisa de novo.
t('avisou há exatamente 7 dias, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(ROUTINE_CREDIT_WARN_MS), period: CICLO }, periodStart: CICLO, agora: AGORA }) === true);
t('avisou há 8 dias, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(8 * DIA), period: CICLO }, periodStart: CICLO, agora: AGORA }) === true);

// 4) Ciclo de crédito virou: quem recarregou e estourou de novo dias depois
// precisa saber, mesmo dentro dos 7 dias.
t('ciclo novo dentro da janela, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(2 * DIA), period: '2026-08-01' }, periodStart: CICLO, agora: AGORA }) === true);
t('marca sem period, com ciclo conhecido, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(2 * DIA) }, periodStart: CICLO, agora: AGORA }) === true);

// 5) Marca corrompida ou sem data -> avisa (errar pro lado de avisar, não de calar).
t('at inválido, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: 'ontem', period: CICLO }, periodStart: CICLO, agora: AGORA }) === true);
t('at ausente, avisa',
  deveAvisarRotinaSemCredito({ marca: { period: CICLO }, periodStart: CICLO, agora: AGORA }) === true);

// 6) Sem periodStart (não deu pra ler o ciclo): decide só pela janela, não avisa à toa.
t('sem periodStart e dentro da janela, cala',
  deveAvisarRotinaSemCredito({ marca: { at: atras(2 * DIA), period: CICLO }, agora: AGORA }) === false);
t('sem periodStart e fora da janela, avisa',
  deveAvisarRotinaSemCredito({ marca: { at: atras(8 * DIA), period: CICLO }, agora: AGORA }) === true);

// 7) Sem argumento nenhum: não pode explodir, avisa.
t('chamada sem argumentos, avisa', deveAvisarRotinaSemCredito() === true);

// 8) A janela é a semana combinada.
t('janela = 7 dias', ROUTINE_CREDIT_WARN_MS === 7 * DIA);

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
