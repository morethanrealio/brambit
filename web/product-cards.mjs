// A tool retry repairs missing media; it must not send the same offer twice.
// Keep this state within one turn, shared by all explicit selections and retries.
export const PRODUCT_RECOMMENDATION_CONTRACT = [
  'PRODUCTS: treat the user\'s requirements (model, variant, function, connectors, size, quantity and price ceiling) as mandatory. A change of budget or size keeps the other requirements from the conversation.',
  'Recommend only offers that the source shows meet the requirements. If only one fits, deliver one; do not pad the list with incompatible alternatives. A missing feature counts as unconfirmed, not as approved.',
  'Price, seller, stock, image and variant belong to the offer that was checked. When the store, link or variant changes, check these data and the ceiling again; do not carry over the price or availability of another offer. Keep uncalculated shipping separate from the observed price.',
  'Do not infer simultaneous power, compatibility, safety, quality or reputation from the product name or advertised power alone. Attribute listing claims to their source; point out what still needs checking when it decides the purchase.',
  'Only say you can buy after the tool proves that capability for the exact store and offer. If there is no support, say plainly that the purchase has to be completed on the website; do not expose internal platform names or promise Pix without confirmation.',
  'Cards without a photo have already been delivered: do not repeat mostrar_produtos to fix media. End with a short recommendation grounded in the requirements and sources, without repeating every card.',
].join('\n');

export function productOfferKey(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    // Preserve seller/variant/catalog parameters. Tracking is not offer identity.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

export function createProductCards({ attachments, onAttachment, imageServed, productImageFromPage, cacheProductImage }) {
  const delivered = new Set();
  let queue = Promise.resolve();
  async function render(products) {
    const seen = new Set();
    const list = [];
    let duplicates = 0;
    for (const p of Array.isArray(products) ? products.slice(0, 10) : []) {
      const key = productOfferKey(p?.link);
      if (!key) continue;
      if (delivered.has(key) || seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      list.push({ p, key });
    }
    // Resolve every image before emitting any card. Image failures degrade to a
    // usable title/link; they do not fail midway through an already-sent batch.
    const cards = await Promise.all(list.map(async ({ p, key }) => {
      const link = String(p.link).trim();
      const card = { type: 'card', title: String(p.nome || '').slice(0, 120) || undefined,
        url: link, buttonText: 'Ver produto' };
      if (p.detalhe) card.body = String(p.detalhe).slice(0, 300);
      let image = null;
      const given = String(p.imagem || '').trim();
      try { if (/^https?:\/\//.test(given) && await imageServed(given)) image = given; } catch {}
      if (!image) {
        try {
          const fallback = await productImageFromPage(link);
          if (fallback && await imageServed(fallback)) image = fallback;
        } catch {}
      }
      if (image) {
        try { const cached = await cacheProductImage(image, link); if (cached) card.image = cached; } catch {}
      }
      return { card, key };
    }));
    for (const { card, key } of cards) {
      delivered.add(key);
      attachments.push(card);
      try { onAttachment?.(card); } catch {}
    }
    return { count: cards.length, duplicates, withoutImage: cards.filter(({ card }) => !card.image).length };
  }
  function enqueue(products) {
    const pending = queue.then(() => render(products));
    queue = pending.catch(() => {});
    return pending;
  }
  return {
    render: enqueue,
    tool: {
      name: 'mostrar_produtos',
      description: 'Mostra a seleção de produtos como cards com título, foto quando disponível e botão de compra. Passe uma única lista das ofertas que atendem às exigências do usuário. Use nome, link e imagem reais da mesma oferta. Não invente imagens. Falha de foto gera card sem foto; não reenvie o item. ' + PRODUCT_RECOMMENDATION_CONTRACT,
      parameters: { type: 'object', properties: { produtos: { type: 'array', maxItems: 10,
        items: { type: 'object', properties: {
          nome: { type: 'string' }, link: { type: 'string', description: 'URL da oferta/variante exata.' },
          imagem: { type: 'string', description: 'URL exata recebida na fonte; omita se indisponível.' },
          detalhe: { type: 'string', description: 'Preço e loja desta oferta; somente características comprovadas.' },
        }, required: ['nome', 'link'] } } }, required: ['produtos'] },
      run: async ({ produtos } = {}) => {
        const result = await enqueue(produtos);
        if (!result.count && !result.duplicates) return 'Nenhum produto com link válido foi apresentado. Confira as URLs das ofertas.';
        if (!result.count) return 'Essas ofertas já estão no chat. Não foram reenviadas; continue com a resposta ao usuário.';
        return `Apresentei ${result.count} produto(s) como cards.${result.withoutImage ? ` ${result.withoutImage} sem foto, com título e link utilizáveis. A ausência da foto não exige correção nem reenvio.` : ''}${result.duplicates ? ' Ofertas repetidas foram ignoradas.' : ''} Não repita links nem cards; explique brevemente a recomendação.`;
      },
    },
  };
}
