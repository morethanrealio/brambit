// Brake on repeated pushes for credit stops (case of 28/09/2026). When the
// free balance doesn't cover the reserve, each message the person sends while
// waiting becomes a turn that stops at once with the SAME balance text, and
// each one fired a push: 5 identical notifications in the same second at 14:25.
// Two uses: per person, the notification doesn't repeat within 15 minutes; per
// conversation, the balance reply itself in a burst (queued messages) is not
// saved or sent again for 2 minutes (28/09).
//
// Pure module: in-memory state per process, injectable clock for tests.
export const CREDIT_PUSH_WINDOW_MS = 15 * 60 * 1000;
export const CREDIT_REPLY_WINDOW_MS = 2 * 60 * 1000;

export function createRepeatPushGuard({ windowMs = CREDIT_PUSH_WINDOW_MS, now = () => Date.now() } = {}) {
  const last = new Map();
  return {
    // true = pode mandar. Mesmo escopo (pessoa ou conversa) + mesmo motivo +
    // mesmo texto dentro da janela = repetido, não manda.
    allow(scopeId, reason, text) {
      const key = `${scopeId}|${reason}|${String(text || '').trim()}`;
      const t = now();
      for (const [k, at] of last) if (t - at >= windowMs) last.delete(k);
      if (last.has(key)) return false;
      last.set(key, t);
      return true;
    },
  };
}
