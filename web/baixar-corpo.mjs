// Lê o corpo de uma resposta HTTP (fetch) com TETO de bytes, sem sair do relógio
// de quem chamou.
//
// Por que existe (achado #26): um prazo que cobre só o começo do download não é
// prazo. E prazo sozinho também não basta: um corpo que chega devagarinho, mas
// nunca acaba, respeita qualquer deadline chunk a chunk e ainda assim enche a
// memória do processo. Então são as duas coisas juntas: a leitura roda dentro do
// AbortSignal de quem chamou (quem corta o tempo é ele) e para na hora em que
// passa do tamanho combinado.
//
// Fica em módulo separado de propósito: aqui não entra rede de verdade, só a
// regra de leitura, e por isso dá pra testar com um corpo falso.
export async function lerCorpoComTeto(res, maxBytes, rotulo = 'download') {
  const teto = Number(maxBytes);
  if (!Number.isFinite(teto) || teto <= 0) throw new Error(`${rotulo}: teto de bytes inválido`);

  // Content-Length é uma DICA do servidor (pode faltar, pode mentir). Quando vem
  // e já estoura, nem começa a baixar: erra barato em vez de errar caro.
  const anunciado = Number(res?.headers?.get?.('content-length'));
  if (Number.isFinite(anunciado) && anunciado > teto) {
    throw new Error(`${rotulo}: corpo anunciado de ${anunciado} bytes passa do teto de ${teto}`);
  }

  const corpo = res?.body;
  if (!corpo || typeof corpo[Symbol.asyncIterator] !== 'function') {
    // Resposta sem stream iterável. Aqui o teto só dá pra conferir depois, mas o
    // AbortSignal de quem chamou continua valendo: o prazo não se perde.
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
      // Larga o socket em vez de deixá-lo despejando bytes no vazio.
      try { await corpo.cancel?.(); } catch { /* stream já travado pelo for-await */ }
      throw new Error(`${rotulo}: corpo passou do teto de ${teto} bytes, download cortado`);
    }
    partes.push(pedaco);
  }
  return Buffer.concat(partes, total);
}
