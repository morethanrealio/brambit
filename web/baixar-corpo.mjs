// Reads the body of an HTTP response (fetch) with a byte CAP, without leaving the
// caller's clock.
//
// Why this exists (finding #26): a deadline that only covers the start of the
// download is not a deadline. And a deadline alone isn't enough either: a body
// that arrives very slowly, but never ends, respects any chunk-by-chunk deadline
// and still fills up the process's memory. So it's both things together: the
// read runs inside the caller's AbortSignal (the caller is the one who cuts the
// time) and stops the moment it passes the agreed size.
//
// Lives in a separate module on purpose: no real network comes in here, just the
// reading rule, so it can be tested with a fake body.
export async function lerCorpoComTeto(res, maxBytes, rotulo = 'download') {
  const teto = Number(maxBytes);
  if (!Number.isFinite(teto) || teto <= 0) throw new Error(`${rotulo}: teto de bytes inválido`);

  // Content-Length is a HINT from the server (it may be missing, it may lie). When it
  // comes and already overflows, don't even start downloading: fail cheap instead of failing expensive.
  const anunciado = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(anunciado) && anunciado > teto) {
    throw new Error(`${rotulo}: corpo anunciado de ${anunciado} bytes passa do teto de ${teto}`);
  }

  const corpo = res?.body;
  if (!corpo || typeof corpo[Symbol.asyncIterator] !== 'function') {
    // Response without an iterable stream. Here the cap can only be checked afterward, but
    // the caller's AbortSignal still applies: the deadline isn't lost.
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > teto) throw new Error(`${rotulo}: corpo de ${buffer.length} bytes passa do teto de ${teto}`);
    return buffer;
  }

  const partes = [];
  let total = 0;
  for await (const parte of corpo) {
    const pedaco = Buffer.from(parte);
    total += pedaco.length;
    if (total > teto) {
      // Drops the socket instead of leaving it dumping bytes into the void.
      try { await corpo.cancel?.(); } catch { /* stream already locked by the for-await */ }
      throw new Error(`${rotulo}: corpo passou do teto de ${teto} bytes, download cortado`);
    }
    partes.push(pedaco);
  }
  return Buffer.concat(partes, total);
}
