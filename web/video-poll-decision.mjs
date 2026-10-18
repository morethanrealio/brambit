// Video poller decisions for when delivery did NOT work. Deliberately kept out of
// server.mjs: no database or network comes in here, only the rule, and that's why
// it can be really tested.
//
// Context from finding #25: every minute the poller picks up every job with status
// 'queued' or 'processing'. When the worker finishes, it downloads the mp4, uploads it to the
// bucket and charges for it. If any step there failed, the job STAYED active, so on the
// next pass the poller would download and upload the whole video again, and again,
// forever. Worse: the owner can only have 1 video in progress at a time, so they
// could never request another one.

// After that, persisting stops being a retry and becomes a loop. A render of up to
// 15s takes minutes, not half an hour.
export const LIMITE_ENTREGA_MS = 30 * 60 * 1000;

// What to do when billing returned "didn't charge" (settled:false).
export function decidirCobrancaNaoConcluida(reason) {
  const motivo = String(reason || '');
  // These two mean the job has already left the active queue through another path
  // (it was already finalized, or it disappeared). There is no loop: the next tick won't pick it up anymore.
  if (motivo === 'already_final' || motivo === 'not_found') return { acao: 'seguir' };
  // The '*_needs_review' ones are DETERMINISTIC: there's already a charge tied
  // to this job and we refuse to charge again. Trying again in a minute gives
  // exactly the same result, forever. So it's taken out of the queue with its own
  // status, which is what a human needs to see to decide, without charging anything.
  return { acao: 'revisar', erro: `cobranca suspensa para revisao: ${motivo || 'motivo desconhecido'}` };
}

// What to do when downloading/saving/charging THREW an error. A network failure or a bucket
// hiccup deserves a retry; a failure that persists for half an hour doesn't.
export function decidirFalhaNaEntrega({ idadeMs, limiteMs = LIMITE_ENTREGA_MS, mensagem = '' } = {}) {
  const idade = Number(idadeMs);
  const texto = String(mensagem ?? '').slice(0, 300) || 'erro desconhecido';
  // Age that's impossible to compute (created_at null/corrupted) counts as overflow:
  // without a reliable clock there's no way to guarantee the loop ends, and an infinite loop
  // is exactly what this function exists to prevent.
  if (!Number.isFinite(idade)) return { acao: 'desistir', erro: `falha na entrega (sem data do pedido): ${texto}` };
  if (idade < limiteMs) return { acao: 'tentar_de_novo' };
  return { acao: 'desistir', erro: `falha na entrega apos ${Math.round(idade / 60000)} min: ${texto}` };
}
