// ── Cadence of the "your credits ran out" notice INSIDE a scheduled routine ──
// Rule (09/09/2026): 1 notice per WEEK and per PERSON, not per routine and not
// per run. Before it was one notice per trigger, so whoever had a daily
// routine got one a day until topping up (42 notices in 30 days in the base).
// In silenced runs the routine still runs and costs nothing: the allowance
// gate stops the model before any call.
// Lives outside plans.mjs because it doesn't depend on a plan: it applies to
// any spend port that says "ran out" (credits in a plugin, USD cap in the core).
export const ROUTINE_CREDIT_WARN_MS = 7 * 86400_000;

// Decides whether the scheduled routine should DELIVER the warning now. `marca` is what's
// stored for this person ({ at, period }) or null/{} the first time.
// Warns when: it never warned, the marker is corrupted, the window has passed, or
// the credit cycle turned over (whoever renewed and ran out again days later needs
// to know, even within the 7 days).
export function deveAvisarRotinaSemCredito({ marca, periodStart = null, agora = Date.now(), janelaMs = ROUTINE_CREDIT_WARN_MS } = {}) {
  const at = Date.parse(marca?.at || '');
  if (!Number.isFinite(at)) return true;
  if (periodStart && marca?.period !== periodStart) return true;
  return agora - at >= janelaMs;
}
