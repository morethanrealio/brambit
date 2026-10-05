// A tool retry repairs missing media; it must not send the same offer twice.
// Keep this state within one turn, shared by all explicit selections and retries.
export const PRODUCT_RECOMMENDATION_CONTRACT = [
  'PRODUTOS: trate as exigências do usuário (modelo, variante, função, conectores, tamanho, quantidade e teto) como obrigatórias. Uma alteração de orçamento ou tamanho preserva as demais exigências da conversa.',
  'Recomende somente ofertas que atendem às exigências demonstradas pela fonte. Se há apenas uma adequada, entregue uma; não complete a lista com alternativas incompatíveis. Característica ausente é não confirmada, não aprovação.',
  'Preço, vendedor, estoque, imagem e variante pertencem à oferta consultada. Ao mudar loja, link ou variante, confira novamente esses dados e o teto; não transfira o preço ou a disponibilidade de outra oferta. Separe frete não calculado do preço observado.',
  'Não deduza potência simultânea, compatibilidade, segurança, qualidade ou reputação apenas do nome comercial ou potência anunciada. Atribua alegações do anúncio à fonte; destaque o que falta verificar quando isso decide a compra.',
  'Só diga que consegue comprar após a ferramenta comprovar essa capacidade para a loja e oferta exatas. Se não houver suporte, diga diretamente que a compra precisa ser finalizada no site; não exponha nomes de plataformas internas nem prometa Pix sem confirmação.',
  'Cards sem foto já foram entregues: não repita mostrar_produtos para corrigir mídia. Termine com recomendação curta, sustentada pelas exigências e fontes, sem repetir todos os cards.',
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
