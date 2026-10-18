// Published-media port (C2, step 11a2). /api/media only serves another person's
// key if some plugin says the owner published it (the Comunidade
// registers the feed post attachments). In the open version nobody registers, and the
// proxy stays owner-only.
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
