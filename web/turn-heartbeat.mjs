export const TURN_HEARTBEAT_TEXT = 'Ainda estou trabalhando nisso, já te respondo.';

// Schedules a single progress receipt and returns an idempotent function that
// stops the clock. If the send has already started, finish() waits for it to finish so the
// final reply doesn't overtake the receipt on the channel.
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
