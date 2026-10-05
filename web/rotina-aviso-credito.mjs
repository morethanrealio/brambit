// ── Cadência do aviso "seus créditos acabaram" DENTRO de rotina agendada ──
// Regra do Marcos (09/09/2026): 1 aviso por SEMANA e por PESSOA, não por rotina
// e não por execução. Antes era um aviso a cada disparo, então quem tinha rotina
// diária levava um por dia até recarregar (foram 42 avisos em 30 dias na base).
// Nas execuções silenciadas a rotina roda mesmo assim e não custa nada: o portão
// de franquia barra o modelo antes de qualquer chamada.
// Fica fora de plans.mjs porque não depende de plano: vale pra qualquer porta de
// gasto que diga "acabou" (crédito no Brambs, teto em US$ na versão aberta).
export const ROUTINE_CREDIT_WARN_MS = 7 * 86400_000;

// Decide se a rotina agendada deve ENTREGAR o aviso agora. `marca` é o que está
// gravado pra essa pessoa ({ at, period }) ou null/{} na primeira vez.
// Avisa quando: nunca avisou, a marca está corrompida, passou a janela, ou o
// ciclo de crédito virou (quem renovou e estourou de novo dias depois precisa
// saber, mesmo dentro dos 7 dias).
export function deveAvisarRotinaSemCredito({ marca, periodStart = null, agora = Date.now(), janelaMs = ROUTINE_CREDIT_WARN_MS } = {}) {
  const at = Date.parse(marca?.at || '');
  if (!Number.isFinite(at)) return true;
  if (periodStart && marca?.period !== periodStart) return true;
  return agora - at >= janelaMs;
}
