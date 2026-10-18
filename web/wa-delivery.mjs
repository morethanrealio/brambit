// Waits for Meta to say whether a message arrived (status webhook), for the outputs of
// public-facing support. Serves two purposes:
//  - ordering: a message with an image (carousel, photo) is processed more slowly by
//    Meta, and text sent right after it arrives BEFORE it; the next output only
//    goes out after delivery (or after the timeout, so as not to stall the conversation);
//  - late rejection: Meta accepts with HTTP 200 and rejects afterwards; whoever
//    waits finds out and can send the fallback text.
// A status that arrives before anyone is waiting is kept for one minute.
const esperando = new Map(); // wamid -> [resolve]
const recentes = new Map();  // wamid -> {status, em}
const RECENTE_MS = 60_000;

const FINAIS = new Set(['delivered', 'read', 'failed']);

export function avisarEntrega(wamid, status) {
  const s = String(status || '');
  if (!wamid || !FINAIS.has(s)) return;
  const fila = esperando.get(wamid);
  if (fila) { esperando.delete(wamid); for (const r of fila) r(s === 'failed' ? 'failed' : 'delivered'); return; }
  const agora = Date.now();
  for (const [k, v] of recentes) if (agora - v.em > RECENTE_MS) recentes.delete(k); else break;
  recentes.set(wamid, { status: s === 'failed' ? 'failed' : 'delivered', em: agora });
}

// Resolves 'delivered', 'failed' or 'timeout'.
export function esperarEntrega(wamid, ms) {
  const r = recentes.get(wamid);
  if (r) { recentes.delete(wamid); return Promise.resolve(r.status); }
  if (!wamid || !(ms > 0)) return Promise.resolve('timeout');
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      const fila = esperando.get(wamid)?.filter((f) => f !== fim);
      if (fila?.length) esperando.set(wamid, fila); else esperando.delete(wamid);
      resolve('timeout');
    }, ms);
    t.unref?.();
    const fim = (s) => { clearTimeout(t); resolve(s); };
    esperando.set(wamid, [...(esperando.get(wamid) || []), fim]);
  });
}
