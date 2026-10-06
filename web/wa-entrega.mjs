// Espera a Meta dizer se uma mensagem chegou (webhook de status), pras saídas do
// atendimento público. Serve pra duas coisas:
//  - ordem: mensagem com imagem (carrossel, foto) é processada mais devagar pela
//    Meta, e o texto mandado logo depois chega ANTES dela; a saída seguinte só
//    sai depois da entrega (ou do tempo-limite, pra não travar a conversa);
//  - reprovação tardia: a Meta aceita com HTTP 200 e reprova depois; quem
//    espera fica sabendo e pode mandar o texto de reserva.
// Status que chega antes de alguém esperar fica guardado um minuto.
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

// Resolve 'delivered', 'failed' ou 'timeout'.
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
