// Freio de push repetido de parada por crédito (caso de 28/09/2026). Quando o
// saldo livre não cobre a reserva, cada mensagem que a pessoa manda enquanto
// espera vira um turno que para na hora com o MESMO texto de saldo, e cada um
// disparava um push: 5 notificações iguais no mesmo segundo às 14h25.
// Dois usos: por pessoa, a notificação não se repete em 15 minutos; por
// conversa, a própria resposta de saldo em rajada (mensagens que estavam na
// fila) não é gravada nem enviada de novo por 2 minutos (Marcos, 28/09).
//
// Módulo puro: estado em memória por processo, relógio injetável pra teste.
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
