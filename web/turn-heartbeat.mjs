export const TURN_HEARTBEAT_TEXT = 'Ainda estou trabalhando nisso, já te respondo.';

// Agenda um único recibo de andamento e devolve uma função idempotente que
// encerra o relógio. Se o envio já começou, finish() espera ele terminar para a
// resposta final não ultrapassar o recibo no canal.
export function startTurnHeartbeat({ afterMs = 60000, send, onError = () => {} }) {
  const delay = Number(afterMs);
  let finished = false;
  let sendPromise = null;
  const timer = Number.isFinite(delay) && delay > 0 ? setTimeout(() => {
    if (finished) return;
    sendPromise = Promise.resolve()
      .then(send)
      .catch((e) => { onError(e); });
  }, delay) : null;

  return async function finishTurnHeartbeat() {
    finished = true;
    if (timer) clearTimeout(timer);
    if (sendPromise) await sendPromise;
  };
}
