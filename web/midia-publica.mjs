// Porta de mídia publicada (C2, passo 11a2). O /api/media só serve a key de
// outra pessoa se algum plugin disser que o dono a publicou (a Comunidade
// registra os anexos de post do feed). Na versão aberta ninguém registra e o
// proxy fica só do dono.
export function createMidiaPublica() {
  const fontes = [];
  return {
    registrar(fn) {
      if (typeof fn !== 'function') throw Error('Fonte de mídia publicada sem função');
      fontes.push(fn);
    },
    async publicada(key) {
      for (const f of fontes) if (await f(key)) return true;
      return false;
    },
  };
}
