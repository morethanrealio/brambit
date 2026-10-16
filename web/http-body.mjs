// IncomingMessage can abort before end and emit error afterwards. Keep the
// error listener until close, including after settlement of the body promise.
export function readRaw(req) {
  return new Promise((resolve, reject) => {
    let chunks = [], settled = false;
    const incomplete = () => Object.assign(new Error('Corpo da requisição interrompido.'), { code: 'REQUEST_BODY_INTERRUPTED' });
    function finish(error) {
      if (settled) return;
      settled = true;
      const body = error ? null : Buffer.concat(chunks); chunks = [];
      req.off('data', onData); req.off('end', onEnd); req.off('aborted', onAbort);
      if (error) reject(error); else resolve(body);
    }
    function onData(chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
    function onEnd() { finish(); }
    function onAbort() { finish(incomplete()); }
    function onError() { finish(incomplete()); }
    function onClose() { if (!settled) finish(incomplete()); req.off('error', onError); req.off('close', onClose); }
    req.on('data', onData); req.once('end', onEnd); req.once('aborted', onAbort);
    req.on('error', onError); req.once('close', onClose);
    if (req.destroyed || req.aborted || req.readableEnded) { finish(incomplete()); if(req.closed)onClose(); }
  });
}

export async function readBody(req) {
  const raw = await readRaw(req);
  // Preserve the existing empty/malformed JSON contract; stream failures reject.
  try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { return {}; }
}
