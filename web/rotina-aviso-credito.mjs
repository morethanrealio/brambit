// ── Cadence of the "your credits ran out" notice INSIDE a scheduled routine ──
// Rule (09/09/2026): 1 notice per WEEK and per PERSON, not per routine and not
// per run. Before it was one notice per trigger, so whoever had a daily
// routine got one a day until topping up (42 notices in 30 days in the base).
// In silenced runs the routine still runs and costs nothing: the allowance
// gate stops the model before any call.
// Lives outside plans.mjs because it doesn't depend on a plan: it applies to
// any spend port that says "ran out" (credits in a plugin, USD cap in the core).
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
