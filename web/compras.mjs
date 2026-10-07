import { randomUUID } from 'node:crypto';
import {recoverOrderPix} from './checkout-recovery.mjs';
import { paymentRequest, checkoutFailure, pixCodeDiagnostic } from './checkout-payment.mjs';
// ── Buying in an online store through the assistant (analyze, build cart, place) ──
//
// The owner sends a product LINK and the assistant buys it for them, as a
// GUEST at the store. Proven live on 25/08 (a VTEX store, a real paid order)
// with ZERO merchant credentials: the whole journey runs on the public VTEX
// storefront, with one cookie jar shared from start to end.
//
// TWO PLATFORMS, and they do NOT reach the same point (probe 25/08):
//   - VTEX    → can go all the way: its checkout is a documented public API.
//   - Shopify → can read the product, compute shipping and build the cart, but
//               checkout is its closed app. Placing via API would need the
//               MERCHANT's token, exactly what this journey avoids. So on
//               Shopify the delivery is a checkout LINK with the cart already
//               built and the total on the table: the last tap is the owner's.
// Nuvemshop was left out: no JSON catalog and a bot challenge on writes.
//
// What is REVERSIBLE (charges nothing, creates no order) runs directly:
//   - analisar_produto  → what it is, sizes in stock, price, coupon, shipping
//   - montar_carrinho   → real cart with profile, address, shipping and best coupon
//   - save/view purchase profile (OPTIONAL, encrypted in the vault)
// What is IRREVERSIBLE goes through the confirm.mjs gate:
//   - fechar_pedido     → creates the order in the store and returns the Pix to pay
// Splitting build and place isn't cosmetic: the owner can only approve a total
// that exists, and a total only exists after shipping and coupon.
//
// The vault profile is OPTIONAL (decided 25/08): whoever didn't save one gives
// the data on the spot and the model passes it in `comprador`. Saving just
// avoids asking for the CPF on every purchase.

import { addConnection, getConnectionByProvider, updateConnectionSecret, checkoutRecoveryStore } from './db.mjs';
import { encryptSecret, decryptSecret, vaultEnabled } from './vault.mjs';

const PROVIDER = 'perfil_compra';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CART_TTL_MS = 40 * 60_000;   // carrinho VTEX morre sozinho; 40min é folga suficiente
const MAX_CUPONS = 4;              // testar cupom é 1 request cada; teto pra não virar loop

// `${userId}:${carrinhoId}` -> { host, orderFormId, jar, ... } (memória, igual runner.mjs)
const CARTS = new Map();


// ── cookie jar (fetch não tem jar; sem ele o checkout VTEX quebra) ──────────
function absorb(jar, res) {
  const list = res.headers.getSetCookie?.() || [];
  for (const c of list) {
    const pair = String(c).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
function jarHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(url, { jar, method = 'GET', body, timeout = 25_000 } = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar) { const c = jarHeader(jar); if (c) headers.Cookie = c; }
  let res;
  try {
    res = await fetch(url, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    // Loja que não responde (Cloudflare, timeout) tem que virar erro honesto e
    // não retry infinito: já vimos www.farmrio.com.br pendurar no POST /items.
    throw new Error(`a loja não respondeu (${e?.name === 'TimeoutError' ? 'timeout' : e?.message || e})`);
  }
  if (jar) absorb(jar, res);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* HTML/vazio */ }
  // `url` é a URL FINAL: loja Shopify redireciona www→apex (visto na farmrio) e o
  // cookie do carrinho nasce no destino. Montar link no host errado perde o carrinho.
  return { status: res.status, ok: res.ok, json, text, url: res.url || url };
}

// ── util ───────────────────────────────────────────────────────────────────
const dig = (s) => String(s ?? '').replace(/\D+/g, '');
// Loja Shopify que vende pra fora cobra na moeda dela (a farmrio devolveu frete em
// USD pro CEP brasileiro), então o valor nunca é "R$" por suposição.
const brl = (cents, moeda = 'BRL') => (moeda === 'BRL'
  ? `R$ ${(Number(cents || 0) / 100).toFixed(2).replace('.', ',')}`
  : `${moeda} ${(Number(cents || 0) / 100).toFixed(2)}`);
// Mesma coisa pra valor já em unidade (o catálogo devolve preço em reais/dólares,
// o checkout devolve em centavos).
const val = (n, moeda = 'BRL') => brl(Math.round(Number(n || 0) * 100), moeda);
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

function maskCpf(cpf) {
  const d = dig(cpf);
  return d.length === 11 ? `${d.slice(0, 3)}.***.***-${d.slice(9)}` : '(inválido)';
}
function fone(t) {
  const d = dig(t);
  if (d.length < 10) return null;
  return '+55' + d.slice(-11);
}
function prazo(estimate) {
  const m = /^(\d+)(bd|d|h|m)$/.exec(String(estimate || ''));
  if (!m) return String(estimate || '');
  const n = Number(m[1]);
  if (m[2] === 'bd') return n === 1 ? '1 dia útil' : `${n} dias úteis`;
  if (m[2] === 'd') return `${n} dia${n === 1 ? '' : 's'}`;
  if (m[2] === 'h') return `${n}h`;
  return `${n}min`;
}

// Shopify quer a província pelo NOME por extenso: com "SC" ela devolve lista de
// frete VAZIA, com "Santa Catarina" devolve as opções (testado na farmrio 25/08).
// A faixa de CEP → UF é tabela fixa dos Correios, então isso sai do próprio CEP
// sem precisar perguntar mais nada ao dono nem depender de serviço externo.
const FAIXAS_CEP = [
  [1000, 19999, 'SP'], [20000, 28999, 'RJ'], [29000, 29999, 'ES'], [30000, 39999, 'MG'],
  [40000, 48999, 'BA'], [49000, 49999, 'SE'], [50000, 56999, 'PE'], [57000, 57999, 'AL'],
  [58000, 58999, 'PB'], [59000, 59999, 'RN'], [60000, 63999, 'CE'], [64000, 64999, 'PI'],
  [65000, 65999, 'MA'], [66000, 68899, 'PA'], [68900, 68999, 'AP'], [69000, 69299, 'AM'],
  [69300, 69399, 'RR'], [69400, 69899, 'AM'], [69900, 69999, 'AC'], [70000, 72799, 'DF'],
  [72800, 72999, 'GO'], [73000, 73699, 'DF'], [73700, 76799, 'GO'], [76800, 76999, 'RO'],
  [77000, 77999, 'TO'], [78000, 78899, 'MT'], [79000, 79999, 'MS'], [80000, 87999, 'PR'],
  [88000, 89999, 'SC'], [90000, 99999, 'RS'],
];
const NOME_UF = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão',
  MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará',
  PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro',
  RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};
function ufDoCep(cep) {
  const d = dig(cep);
  if (d.length !== 8) return null;
  const p = Number(d.slice(0, 5));
  return FAIXAS_CEP.find(([a, b]) => p >= a && p <= b)?.[2] || null;
}

// Slug do produto a partir da URL do PDP VTEX: /<slug>/p
function slugDaUrl(u) {
  const parts = new URL(u).pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  const i = parts.lastIndexOf('p');
  if (i > 0) return decodeURIComponent(parts[i - 1]);
  return decodeURIComponent(parts[parts.length - 1]);
}

// Cupons ANUNCIADOS na própria página. O VTEX guarda isso em clusterHighlights
// (mapa id->nome, ex: {"3292":"Use o Cupom: EXTRA20"}); às vezes também nos
// productClusters. Achado ao vivo: EXTRA20 (-R$10) venceu PRIMEIRA15 (-R$7,50).
function cuponsAnunciados(p) {
  const fontes = [
    ...Object.values(p?.clusterHighlights || {}),
    ...Object.values(p?.productClusters || {}),
  ].map(String);
  const out = new Set();
  for (const t of fontes) {
    const m = /cupom[:\s"']*([A-Z0-9][A-Z0-9_-]{3,24})/i.exec(t);
    if (m) out.add(m[1].toUpperCase());
  }
  return [...out].slice(0, MAX_CUPONS);
}

function resumoProduto(p) {
  const itens = (p.items || []).map((it) => {
    const o = it.sellers?.find((s) => s.sellerDefault)?.commertialOffer
      || it.sellers?.[0]?.commertialOffer || {};
    return {
      skuId: it.itemId,
      variacao: it.name || it.nameComplete || '',
      estoque: Number(o.AvailableQuantity || 0),
      preco: Number(o.Price || 0),
      de: Number(o.ListPrice || 0),
      seller: it.sellers?.find((s) => s.sellerDefault)?.sellerId || it.sellers?.[0]?.sellerId || '1',
      imagem: it.images?.[0]?.imageUrl || null,
    };
  });
  return {
    productId: p.productId,
    nome: p.productName,
    marca: p.brand,
    link: p.link,
    cor: p.COR?.[0] || null,
    imagem: itens.find((i) => i.imagem)?.imagem || null,
    itens,
    cupons: cuponsAnunciados(p),
  };
}

// ── Shopify ────────────────────────────────────────────────────────────────
// Superfícies públicas verificadas ao vivo 25/08 (allbirds + farmrio), sem
// credencial nenhuma: /products/<handle>.js (catálogo), /cart/add.js e /cart.js
// (carrinho), /cart/shipping_rates.json (frete real) e /cart/<variante>:<qtd>
// (link que já abre o checkout com o carrinho montado). O que NÃO existe: um
// endpoint público de fechar pedido. Por isso a Shopify para no link.
function resumoShopify(p, link, moeda = 'BRL') {
  const itens = (p.variants || []).map((v) => ({
    skuId: String(v.id),
    variacao: v.title === 'Default Title' ? '' : (v.title || ''),
    // Shopify não expõe quantidade, só o booleano `available`. Traduzo pro mesmo
    // formato da VTEX sem fingir número que eu não tenho.
    estoque: v.available ? 999 : 0,
    preco: Number(v.price || 0) / 100,
    de: Number(v.compare_at_price || 0) / 100,
    seller: '1',
    imagem: v.featured_image?.src || p.featured_image || (p.images || [])[0] || null,
  }));
  return {
    productId: String(p.id),
    nome: p.title,
    marca: p.vendor || null,
    link,
    moeda,
    cor: null,
    imagem: itens.find((i) => i.imagem)?.imagem || p.featured_image || null,
    itens,
    // A Shopify não anuncia cupom em lugar nenhum legível por API: o desconto só
    // é validado dentro do checkout. Nunca inventar um aqui.
    cupons: [],
  };
}

// Carrinho Shopify serve só pra PRECIFICAR (o jar é meu, não do dono). O que o
// dono recebe no fim é o permalink, que remonta o mesmo carrinho no browser dele.
async function shopifyPrecificar(origin, { skuId, quantidade = 1, cep, estado }) {
  const jar = new Map();
  const add = await req(`${origin}/cart/add.js`, { method: 'POST', jar, body: { id: Number(skuId), quantity: quantidade } });
  if (!add.json?.id) return null;
  const cart = await req(`${origin}/cart.js`, { jar }).catch(() => null);
  const moeda = cart?.json?.currency || 'BRL';
  const subtotal = Number(cart?.json?.total_price ?? 0);

  let fretes = [];
  const uf = estado ? String(estado).toUpperCase().slice(0, 2) : ufDoCep(cep);
  if (dig(cep).length === 8) {
    const qs = new URLSearchParams();
    qs.set('shipping_address[zip]', dig(cep));
    qs.set('shipping_address[country]', 'Brazil');
    if (uf && NOME_UF[uf]) qs.set('shipping_address[province]', NOME_UF[uf]);
    const r = await req(`${origin}/cart/shipping_rates.json?${qs}`, { jar, timeout: 40_000 }).catch(() => null);
    fretes = (r?.json?.shipping_rates || []).map((s) => ({
      nome: s.presentment_name || s.name,
      preco: Math.round(Number(s.price || 0) * 100),
      moeda: s.currency || moeda,
      prazo: (() => {
        const fim = s.delivery_range?.[s.delivery_range.length - 1];
        if (fim) return `chega até ${String(fim).split('-').reverse().join('/')}`;
        const d = Math.max(0, ...(s.delivery_days || [0]));
        return d ? `${d} dia${d === 1 ? '' : 's'}` : '';
      })(),
      canal: 'delivery', retirada: false,
    }));
  }
  return { moeda, subtotal, fretes, uf };
}

// ── plataforma ─────────────────────────────────────────────────────────────
// A URL já diz muito (/<slug>/p é VTEX, /products/<handle> é Shopify), então
// tento primeiro a plataforma provável e só caio na outra se ela negar. Sondar
// o checkout VTEX cria um orderForm à toa, por isso é sempre o último recurso.
async function resolverProduto(url) {
  const u = new URL(url);
  const origin = u.origin;
  const partes = u.pathname.split('/').filter(Boolean);
  const iProd = partes.lastIndexOf('products');
  const handle = iProd >= 0 && partes[iProd + 1] ? decodeURIComponent(partes[iProd + 1].split('?')[0]) : null;
  const slug = slugDaUrl(url);

  const tentarShopify = async () => {
    if (!handle) return null;
    const r = await req(`${origin}/products/${encodeURIComponent(handle)}.js`).catch(() => null);
    if (!r?.json?.variants?.length) return null;
    // O origin da resposta manda: se a loja redirecionou, é lá que o carrinho vive.
    let fim = origin;
    try { fim = new URL(r.url).origin; } catch { /* fica o original */ }
    // Loja Shopify não vende só em real (allbirds e farmrio cobram em USD, mesmo
    // atendendo o Brasil). A moeda vem do /meta.json da loja, não de suposição.
    const meta = await req(`${fim}/meta.json`).catch(() => null);
    const moeda = meta?.json?.currency || 'BRL';
    return { plataforma: 'shopify', origin: fim, produto: resumoShopify(r.json, `${fim}/products/${handle}`, moeda) };
  };
  const tentarVtex = async () => {
    if (!slug) return null;
    const r = await req(`${origin}/api/catalog_system/pub/products/search/${encodeURIComponent(slug)}/p`).catch(() => null);
    if (!Array.isArray(r?.json) || !r.json.length) return null;
    return { plataforma: 'vtex', origin, produto: resumoProduto(r.json[0]) };
  };

  const ordem = handle ? [tentarShopify, tentarVtex] : [tentarVtex, tentarShopify];
  for (const t of ordem) { const r = await t(); if (r) return r; }

  const probe = await req(`${origin}/api/checkout/pub/orderForm`, { method: 'POST', body: {}, jar: new Map() }).catch(() => null);
  if (probe?.json?.orderFormId) {
    throw new Error(`a loja é VTEX, mas não achei o produto pelo endereço "${slug}". Confira o link do produto.`);
  }
  throw new Error('não consegui consultar esta oferta pela integração da loja. Preço, estoque, variante e capacidade de montar carrinho não foram confirmados. A compra desta oferta precisa ser conferida e finalizada no site da loja; não prometa checkout ou Pix pelo assistente.');
}

// Simulação de carrinho: preço, frete e MEIOS DE PAGAMENTO sem criar orderForm.
async function simular(origin, { skuId, seller = '1', quantidade = 1, cep }) {
  const r = await req(`${origin}/api/checkout/pub/orderForms/simulation?sc=1`, {
    method: 'POST',
    body: { items: [{ id: String(skuId), quantity: quantidade, seller: String(seller) }], postalCode: dig(cep) || undefined, country: 'BRA' },
  });
  if (!r.json) return null;
  const li = r.json.logisticsInfo?.[0] || {};
  const sistemas = r.json.paymentData?.paymentSystems || [];
  return {
    total: (r.json.totals || []).reduce((a, t) => a + Number(t.value || 0), 0),
    // canal importa: "Retirada (loja X)" vem como pickup-in-point e costuma ser a
    // mais barata (R$0), mas NÃO é entrega e exige ponto de retirada. Selecionar
    // ela como 'delivery' faz a loja ignorar em silêncio e cobrar outro frete.
    fretes: (li.slas || []).map((s) => ({
      nome: s.id || s.name, preco: Number(s.price || 0), prazo: prazo(s.shippingEstimate),
      canal: s.deliveryChannel || 'delivery', retirada: !!s.pickupStoreInfo?.isPickupStore,
    })),
    // The Pix paymentSystem is found by name/group, so this works on any VTEX
    // store (on one store it's 713, "Pagaleve Pix A Vista Transparente").
    pix: sistemas.find((s) => /pix/i.test(`${s.name} ${s.groupName}`)) || null,
    sistemas: sistemas.map((s) => ({ id: s.id, nome: s.name, grupo: s.groupName })),
  };
}

async function cepLookup(origin, cep) {
  const d = dig(cep);
  if (d.length !== 8) return null;
  const r = await req(`${origin}/api/checkout/pub/postal-code/BRA/${d}`);
  return r.json?.city ? r.json : null;
}

// ── perfil de comprador (OPCIONAL, cifrado no cofre) ───────────────────────
async function lerPerfil(userId) {
  if (!vaultEnabled()) return null;
  const row = await getConnectionByProvider(userId, PROVIDER);
  if (!row) return null;
  try { return { id: row.id, ...JSON.parse(decryptSecret(row.secret_enc)) }; }
  catch { return null; }
}

async function gravarPerfil(userId, perfil) {
  const blob = encryptSecret(JSON.stringify(perfil));
  const row = await getConnectionByProvider(userId, PROVIDER);
  if (row) return updateConnectionSecret(userId, row.id, blob, { label: perfil.nome || '' });
  return addConnection(userId, { provider: PROVIDER, kind: 'profile', label: perfil.nome || '', secretEnc: blob, meta: { tipo: 'perfil de comprador' } });
}

// Junta o que veio na hora com o que está salvo (o da hora ganha). Devolve
// {perfil} ou {falta:[campos]} — nunca inventa dado de comprador.
function montarComprador(salvo, dado = {}) {
  const p = {
    nome: dado.nome || salvo?.nome || '',
    cpf: dig(dado.cpf || salvo?.cpf || ''),
    email: (dado.email || salvo?.email || '').trim(),
    telefone: dado.telefone || salvo?.telefone || '',
    cep: dig(dado.cep || salvo?.cep || ''),
    numero: String(dado.numero ?? salvo?.numero ?? '').trim(),
    complemento: dado.complemento ?? salvo?.complemento ?? '',
    rua: dado.rua || salvo?.rua || '',
    bairro: dado.bairro || salvo?.bairro || '',
    cidade: dado.cidade || salvo?.cidade || '',
    estado: dado.estado || salvo?.estado || '',
  };
  const falta = [];
  if (!p.nome || !p.nome.trim().includes(' ')) falta.push('nome completo');
  if (p.cpf.length !== 11) falta.push('CPF');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) falta.push('e-mail');
  if (!fone(p.telefone)) falta.push('celular com DDD');
  if (p.cep.length !== 8) falta.push('CEP');
  if (!p.numero) falta.push('número do endereço');
  return falta.length ? { falta } : { perfil: p };
}

// ── carrinho ───────────────────────────────────────────────────────────────
function limparCarrinhos() {
  const corte = Date.now() - CART_TTL_MS;
  for (const [k, c] of CARTS) if (c.criadoEm < corte) CARTS.delete(k);
}
export function getCarrinho(userId, id) {
  limparCarrinhos();
  return CARTS.get(`${userId}:${id}`) || null;
}

// Resumo do carrinho pro texto de CONFIRMAÇÃO (confirm.mjs). Quem monta a frase
// é este código, nunca o modelo: o dono tem que aprovar o valor REAL do carrinho,
// não um número que o modelo repetiu de memória. Busca só pelo id (o confirm não
// conhece o userId), então devolve de propósito só item/loja/total, sem CPF nem
// endereço — a execução de verdade continua escopada por usuário em getCarrinho.
// Em que plataforma o carrinho vive. O confirm.mjs usa isso pra não pedir ao dono
// que autorize "fechar o pedido" numa loja onde fechar não é comigo.
export function plataformaDoCarrinho(id) {
  limparCarrinhos();
  for (const [k, c] of CARTS) if (k.endsWith(`:${id}`)) return c.plataforma || 'vtex';
  return null;
}

// O carrinho VIVO mais recente desta conversa. O id que o modelo passa pra
// fechar_pedido sai do histórico do chat, e ali continuam visíveis os ids de
// montagens ANTERIORES (inclusive de carrinhos que já morreram). Com isto dá
// pra apontar o certo na hora, em vez de levar um id morto até o dono.
export function carrinhoVivoDoThread(userId, threadId) {
  limparCarrinhos();
  const prefixo = `${userId}:`;
  let melhor = null;
  for (const [k, c] of CARTS) {
    if (!k.startsWith(prefixo)) continue;
    if (threadId && c.threadId && c.threadId !== threadId) continue;
    if (!melhor || c.criadoEm > melhor.cart.criadoEm) melhor = { id: k.slice(prefixo.length), cart: c };
  }
  return melhor;
}

export function descreverCarrinho(id) {
  limparCarrinhos();
  for (const [k, c] of CARTS) {
    if (k.endsWith(`:${id}`)) {
      const loja = (() => { try { return new URL(c.origin).host; } catch { return c.origin; } })();
      const moeda = c.moeda || 'BRL';
      return `${c.produto.nome}${c.produto.variacao ? ` (${c.produto.variacao})` : ''} × ${c.produto.qtd} na ${loja}, total ${brl(c.valor, moeda)} (frete ${brl(c.frete?.preco || 0, moeda)}${c.cupom ? `, cupom ${c.cupom}` : ''})`;
    }
  }
  return null;
}

// Parsing remains local to the tool; safe validation/diagnostics are shared.
function pixValido(s) {
  return pixCodeDiagnostic(s).valid ? s.trim() : null;
}
function pixComCrcInvalido(s) {
  const reason=pixCodeDiagnostic(s).reason;
  return reason==='crc_missing'||reason==='crc_mismatch';
}

// A loja manda o vencimento em ISO UTC. Jogar isso cru no chat
// ("2026-09-10T14:26:28Z") não diz nada pra quem vai pagar: o que importa é a
// hora daqui.
function ateQueHoras(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

// Connector payload: sometimes a URL of its page, sometimes JSON with the code
// inside (one store's Pagaleve connector switched between 25/08 and 09/09).
// Returns { code } or { url }, NEVER the raw payload: on 09/09 the JSON fell
// into the link branch and the assistant pasted the whole object (with the QR
// PNG in base64, thousands of characters) into the owner's chat.
// A continuation link is provider-supplied, never constructed from order IDs.
// Preserve its query byte-for-byte. Reject insecure/credential-bearing links.
function linkPagamento(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password ? value : null;
  } catch { return null; }
}

function lerPayloadConector(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^https?:\/\//i.test(s)) { const url = linkPagamento(s); return url ? { url } : null; }
    const emv = pixValido(s);
    if (emv) return { code: emv };
    if (pixComCrcInvalido(s)) return { quebrado: true };
    if (!s.startsWith('{') && !s.startsWith('[')) return null;
  }
  let p = raw;
  if (typeof raw === 'string') { try { p = JSON.parse(raw); } catch { return null; } }
  if (!p || typeof p !== 'object') return null;
  const bruto = p.code || p.qrCodeText || p.pixCode || p.emv || p.qrCode;
  const code = pixValido(bruto);
  if (code) return { code, expira: p.expiresAt || p.expiration || null };
  const url = p.url || p.paymentUrl || p.redirectUrl || p.checkoutUrl || null;
  const link = linkPagamento(url);
  if (link) return { url: link };
  // Nada de URL e o que veio no campo do código tem cara de Pix mas não fecha o
  // CRC: é código corrompido, e isso o dono precisa saber.
  if (pixComCrcInvalido(bruto)) return { quebrado: true };
  return null;
}

// Where the Pix comes from depends on the store's CONNECTOR, not on VTEX. Two
// forms, and the store picks: native transparent Pix returns the copy-paste
// code in `paymentAppData`; a connector with a payment app (e.g. Pagaleve)
// returns in `paymentAuthorizationAppCollection` either its page URL or JSON
// with the code. I look in both responses (payment and callback) because each
// store answers in one.
// HARD RULE: only code that passed pixValido (CRC included) or an HTTPS URL
// without credentials leaves here. No base64 image and no raw payload. Code
// that looks like Pix with a wrong CRC becomes type 'quebrado' and is NOT
// delivered: better admit the store returned junk than send what the bank rejects.
function extrairPix(...respostas) {
  let quebrado = null;
  for (const o of respostas) {
    if (!o) continue;
    const app = o.paymentAppData || o.paymentData?.paymentAppData;
    const lidoApp = app?.payload != null ? lerPayloadConector(app.payload) : null;
    if (lidoApp?.code) return { tipo: 'copia-e-cola', code: lidoApp.code, expira: lidoApp.expira || null, app: app.appName || null };
    if (lidoApp?.url) return { tipo: 'link', url: lidoApp.url, app: app.appName || null };
    if (lidoApp?.quebrado && !quebrado) quebrado = { tipo: 'quebrado', app: app?.appName || null };

    const col = Array.isArray(o.paymentAuthorizationAppCollection) ? o.paymentAuthorizationAppCollection : [];
    // Quando é URL, tem que ser usada INTEIRA: tirar parâmetro (u, cb, cr) quebra
    // a tela do conector, testado ao vivo 25/08.
    const lidoCol = col[0]?.appPayload != null ? lerPayloadConector(col[0].appPayload) : null;
    if (lidoCol?.code) return { tipo: 'copia-e-cola', code: lidoCol.code, expira: lidoCol.expira || null, app: col[0].appName || null };
    if (lidoCol?.url) return { tipo: 'link', url: lidoCol.url, app: col[0].appName || null };
    if (lidoCol?.quebrado && !quebrado) quebrado = { tipo: 'quebrado', app: col[0]?.appName || null };

    const redirects = o.RedirectResponseCollection ?? o.redirectResponseCollection;
    const red = Array.isArray(redirects) ? redirects : [];
    // VTEX checkout-ui v6.152.1 reads RedirectResponseCollection[0].redirectUrl.
    // Do not mask an invalid authoritative field with an alternate value.
    const lidoRed = lerPayloadConector(red[0]?.redirectUrl ?? red[0]?.value ?? red[0]?.url);
    if (lidoRed?.url) return { tipo: 'link', url: lidoRed.url, app: null };
    if (lidoRed?.code) return { tipo: 'copia-e-cola', code: lidoRed.code, expira: lidoRed.expira || null, app: null };
    if (lidoRed?.quebrado && !quebrado) quebrado = { tipo: 'quebrado', app: null };
  }
  return quebrado;
}

function totais(of) {
  const t = Object.fromEntries((of.totalizers || []).map((x) => [x.id, Number(x.value || 0)]));
  return { itens: t.Items || 0, desconto: t.Discounts || 0, frete: t.Shipping || 0, total: Number(of.value || 0) };
}

// ── tools ──────────────────────────────────────────────────────────────────
export function comprasTools(userId, agentId, { threadId } = {}) {
  const recoveryScope={userId,agentId,threadId};
  function prepareCheckout(args, saved = null) {
    const id = String(args.carrinho_id || '').trim();
    const cart = saved ? {...saved.cart,jar:new Map(saved.cart.jar || [])} : getCarrinho(userId,id);
    if (saved && (saved.version !== 1 || saved.id !== id)) throw Error('Pedido inválido.');
    if (!cart || cart.userId !== userId || cart.agentId !== agentId || cart.threadId !== (threadId || null)
        || cart.criadoEm < Date.now()-CART_TTL_MS || cart.checkoutAttempted || cart.checkoutBusy) {
      throw Error('Carrinho expirado, já utilizado ou indisponível nesta conversa. Monte outro antes de confirmar.');
    }
    if (cart.plataforma !== 'vtex' || !cart.pix) throw Error('Este carrinho não permite fechamento por Pix.');
    const snapshot = saved || {version:1,id,cart:JSON.parse(JSON.stringify({...cart,jar:[...cart.jar]}))};
    const loja = new URL(cart.origin).host;
    const resumo = `${cart.produto.nome}${cart.produto.variacao ? ` (${cart.produto.variacao})` : ''} × ${cart.produto.qtd} na ${loja}, total ${brl(cart.valor,cart.moeda)} (frete ${brl(cart.frete?.preco || 0,cart.moeda)}${cart.cupom ? `, cupom ${cart.cupom}` : ''})`;
    return {descriptor:snapshot,
      label:`FECHAR O PEDIDO DE VERDADE: ${resumo}. Isso cria um pedido real no seu nome e gera a cobrança; não dá pra desfazer por aqui`,
      preflight:async()=>null,
      run:async()=>{
        const existing = getCarrinho(userId,id);
        if (existing?.checkoutAttempted || existing?.checkoutBusy) return {ok:false,error:'Este carrinho já foi processado; não repeti o pedido.'};
        // A saved checkout session is encrypted in the durable proposal. Restore
        // only after the SQL execution claim; the provider is rechecked below.
        CARTS.set(`${userId}:${id}`,cart);
        return tools.find(t=>t.name==='fechar_pedido').run({carrinho_id:id});
      },
    };
  }
  const tools = [
    {
      name:'recuperar_pix_pedido',
      description:'Recovers and revalidates the Pix already received for an existing order, by its number. Uses the protected record of the account and of this assistant; survives restarts. Does NOT create an order, does not call checkout, does not reissue a charge nor pay. If there is no record or the Pix has expired, reports the limitation without redoing the purchase. Copy the returned code literally, preserving spaces.',
      parameters:{type:'object',properties:{pedido_id:{type:'string',description:'Exact reference of the already-created order.'}},required:['pedido_id'],additionalProperties:false},
      run:async ({pedido_id}={})=>recoverOrderPix({store:checkoutRecoveryStore,parsePix:extrairPix},recoveryScope,String(pedido_id??'').trim()),
    },
    {
      name: 'analisar_produto',
      description:
        'READS THE REAL PAGE of a product in an online store (from the LINK the owner sent) and returns what the store says NOW: name, color, SIZES/variants with STOCK, list and sale price, coupon advertised on the page, shipping and delivery time for the CEP. '
        + 'Use ALWAYS when the owner sends a product link and talks about buying, size, price, shipping or availability. It is the first tool of the purchase: montar_carrinho comes after it. '
        + 'Works on VTEX stores and Shopify stores (together, most of online fashion retail); if it is another platform, it says so. Does NOT create an order, does NOT charge anything.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Product page link (the PDP, not the home page nor the search).' },
          cep: { type: 'string', description: 'Delivery CEP, if known (otherwise the one from the saved profile is used). Without a CEP, shipping is not calculated.' },
        },
        required: ['url'],
      },
      run: async ({ url, cep } = {}) => {
        if (!url) return 'ERRO: passe o link da página do produto.';
        let r;
        try { r = await resolverProduto(String(url).trim()); }
        catch (e) { return `Não consegui abrir esse produto: ${e.message}`; }
        const p = r.produto;
        const disp = p.itens.filter((i) => i.estoque > 0);
        // Estoque grande na VTEX costuma ser 99999 (= "tem"); só o número baixo
        // é informação útil ("corre que tá acabando").
        const estoqueTxt = (n) => (n <= 0 ? 'SEM ESTOQUE' : n > 20 ? 'em estoque' : `só ${n} em estoque`);
        const mo = p.moeda || 'BRL';
        const linhas = p.itens.map((i) => `  • ${i.variacao || '(única)'} — ${estoqueTxt(i.estoque)} — ${val(i.preco, mo)}${i.de > i.preco ? ` (de ${val(i.de, mo)})` : ''} [sku ${i.skuId}]`);
        const out = [
          `${p.nome}${p.marca ? ` — ${p.marca}` : ''} (loja ${r.plataforma.toUpperCase()}: ${new URL(r.origin).host})`,
          `link: ${p.link || url}`,
          p.imagem ? `imagem: ${p.imagem}` : '',
          `variações:`,
          ...linhas,
        ].filter(Boolean);
        if (p.cupons.length) out.push(`CUPOM anunciado na página: ${p.cupons.join(', ')} (eu testo no carrinho e fico com o melhor)`);

        const perfil = await lerPerfil(userId).catch(() => null);
        const cepUso = dig(cep) || perfil?.cep || '';
        const alvo = disp[0] || p.itens[0];
        if (cepUso && alvo && r.plataforma === 'vtex') {
          const sim = await simular(r.origin, { skuId: alvo.skuId, seller: alvo.seller, cep: cepUso }).catch(() => null);
          if (sim?.fretes?.length) out.push(`frete pro CEP ${cepUso}: ` + sim.fretes.map((f) => `${f.nome} ${brl(f.preco)} em ${f.prazo}${f.retirada ? ' [retirada em loja, eu não faço]' : ''}`).join(' | '));
          if (sim && !sim.pix) out.push('ATENÇÃO: essa loja não oferece Pix nos meios de pagamento.');
        }
        if (cepUso && alvo && r.plataforma === 'shopify') {
          const pr = await shopifyPrecificar(r.origin, { skuId: alvo.skuId, cep: cepUso, estado: perfil?.estado }).catch(() => null);
          if (pr?.fretes?.length) out.push(`frete pro CEP ${cepUso}: ` + pr.fretes.map((f) => `${f.nome} ${brl(f.preco, f.moeda)}${f.prazo ? ` (${f.prazo})` : ''}`).join(' | '));
          else out.push(`frete: essa loja só calcula no checkout (não respondeu pro CEP ${cepUso}).`);
          // Meio de pagamento na Shopify só aparece dentro do checkout dela: não
          // dá pra afirmar Pix nem cartão daqui, então não afirmo.
        }
        if (mo !== 'BRL') out.push(`ATENÇÃO: essa loja cobra em ${mo}, não em real (o dono paga com conversão e possível IOF).`);
        out.push(disp.length
          ? 'Preserve o modelo, variante, quantidade e teto pedidos. Se a variação já foi escolhida, use-a; só esclareça escolhas realmente ausentes. Chame montar_carrinho para conferir total com frete e cupom antes de prometer preço ou compra. Mostre a oferta exata com mostrar_produtos usando o link e a imagem daqui.'
          : 'Nenhuma variação com estoque. Avise o dono em vez de tentar montar carrinho.');
        return out.join('\n');
      },
    },

    {
      name: 'montar_carrinho',
      description:
        'BUILDS THE REAL CART in the store, as a guest, on the owner\'s behalf, and returns the FINAL TOTAL with shipping and a carrinho_id. '
        + 'Does NOT create an order and does NOT charge: it is the "how much will it be" step. Call it after analisar_produto, with the variant already chosen by the owner. '
        + 'On a VTEX store it identifies the buyer, calculates shipping to the address and tests the advertised COUPONS, keeping the biggest discount; after it, fechar_pedido can be called. '
        + 'On a SHOPIFY store it prices it (subtotal + shipping by CEP) and returns a checkout LINK with the cart already built, because Shopify does not allow closing an order from outside; the owner then finishes with 1 tap on that link and fechar_pedido does NOT apply. '
        + 'If they have a saved purchase profile, there is no need to pass `comprador`; if they do NOT, ask them for the data and pass it in `comprador` (a saved profile is optional; on Shopify the CEP is enough).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Product page link.' },
          variacao: { type: 'string', description: 'Chosen size/variant (e.g. "G"), or the sku directly. Leave empty if the product has only one.' },
          quantidade: { type: 'number', description: 'Quantity (default 1).' },
          cupom: { type: 'string', description: 'Specific coupon to test, if the owner has one. The ones advertised on the page are already tested automatically.' },
          frete: { type: 'string', description: 'Name of the shipping option, if the owner chose one (e.g. "Rápida"). Without it, the cheapest delivery is used. In-store pickup is not supported.' },
          comprador: {
            type: 'object',
            description: 'Buyer data, only if they have no saved profile (or to override it). Never invent: ask the owner.',
            properties: {
              nome: { type: 'string', description: 'Full name.' },
              cpf: { type: 'string' },
              email: { type: 'string' },
              telefone: { type: 'string', description: 'Mobile phone with area code (DDD).' },
              cep: { type: 'string' },
              numero: { type: 'string', description: 'Address number.' },
              complemento: { type: 'string' },
              rua: { type: 'string', description: 'Only if the CEP does not resolve on its own.' },
              bairro: { type: 'string' },
              cidade: { type: 'string' },
              estado: { type: 'string', description: 'State (UF).' },
            },
          },
          salvar_perfil: { type: 'boolean', description: 'true to save this data in the owner\'s vault and not ask again. Only with their OK.' },
        },
        required: ['url'],
      },
      run: async ({ url, variacao, quantidade, cupom, comprador, salvar_perfil, frete: freteEscolhido } = {}) => {
        if (!url) return 'ERRO: passe o link da página do produto.';
        const qtd = Math.max(1, Math.min(10, Number(quantidade) || 1));

        let r;
        try { r = await resolverProduto(String(url).trim()); }
        catch (e) { return `Não consegui abrir esse produto: ${e.message}`; }
        const { origin, produto } = r;

        // variação → sku
        const alvoTxt = norm(variacao);
        let item = null;
        if (!alvoTxt) item = produto.itens.find((i) => i.estoque > 0) || produto.itens[0];
        else item = produto.itens.find((i) => String(i.skuId) === String(variacao).trim())
          || produto.itens.find((i) => norm(i.variacao) === alvoTxt)
          || produto.itens.find((i) => norm(i.variacao).includes(alvoTxt));
        if (!item) return `Não achei a variação "${variacao}". Disponíveis: ${produto.itens.map((i) => i.variacao).join(', ')}.`;
        if (item.estoque < qtd) return `"${item.variacao}" está com ${item.estoque} em estoque (pedido: ${qtd}). Escolha outra variação ou reduza a quantidade.`;

        // ── Shopify: precifica e entrega o link do checkout com o carrinho montado ──
        // Aqui a jornada é mais curta de propósito: quem preenche nome, CPF e
        // endereço é a própria loja, na tela do dono. O único dado que eu preciso
        // é o CEP, e só pra ele já ver o frete antes de clicar.
        if (r.plataforma === 'shopify') {
          const perfilS = await lerPerfil(userId).catch(() => null);
          const cepS = dig(comprador?.cep) || perfilS?.cep || '';
          const pr = await shopifyPrecificar(origin, {
            skuId: item.skuId, quantidade: qtd, cep: cepS, estado: comprador?.estado || perfilS?.estado,
          }).catch(() => null);
          if (!pr) return `Não consegui montar o carrinho nessa loja Shopify (ela recusou a inclusão do item). Posso te mandar o link do produto pro dono fechar na mão: ${produto.link || url}`;

          const escolhido = norm(freteEscolhido);
          const freteS = (escolhido && pr.fretes.find((f) => norm(f.nome).includes(escolhido)))
            || [...pr.fretes].sort((a, b) => a.preco - b.preco)[0]
            || null;
          const total = pr.subtotal + (freteS?.preco || 0);
          const cupomS = cupom ? String(cupom).trim() : null;
          // Permalink de carrinho: a Shopify remonta o mesmo carrinho no browser de
          // quem abrir. O nosso jar acima serviu só pra precificar, e morre aqui.
          const link = `${origin}/cart/${item.skuId}:${qtd}` + (cupomS ? `?discount=${encodeURIComponent(cupomS)}` : '');

          const idS = 'c' + randomUUID().replaceAll('-', '');
          limparCarrinhos();
          CARTS.set(`${userId}:${idS}`, {
            criadoEm: Date.now(), userId, agentId, threadId: threadId || null,
            plataforma: 'shopify', origin, moeda: pr.moeda, checkoutUrl: link,
            produto: { nome: produto.nome, variacao: item.variacao, sku: item.skuId, qtd, link: produto.link || url, imagem: item.imagem || produto.imagem },
            comprador: null, frete: freteS, cupom: cupomS,
            valor: total, pix: null, sistemas: [],
          });

          return [
            `CARRINHO MONTADO NA SHOPIFY (nada foi cobrado) — carrinho_id: ${idS}`,
            `item: ${produto.nome} — ${item.variacao || 'única'} × ${qtd}`,
            `subtotal ${brl(pr.subtotal, pr.moeda)}`,
            freteS ? `frete: ${freteS.nome} ${brl(freteS.preco, freteS.moeda)}${freteS.prazo ? ` (${freteS.prazo})` : ''}` : (cepS ? 'frete: a loja não devolveu opção pro CEP; ela calcula no checkout.' : 'frete: sem CEP eu não calculo; a loja calcula no checkout.'),
            freteS ? `TOTAL: ${brl(total, pr.moeda)}` : `TOTAL PARCIAL (sem frete): ${brl(total, pr.moeda)}`,
            pr.moeda !== 'BRL' ? `ATENÇÃO: cobrança em ${pr.moeda}, não em real.` : '',
            cupomS ? `cupom ${cupomS} já vai aplicado no link (a loja valida na hora).` : '',
            `LINK PRA FECHAR: ${link}`,
            '',
            'Mostre ao dono o item, o total e ESSE LINK: nessa loja o pagamento é na tela dela, então o último toque é dele. NÃO chame fechar_pedido pra esta loja (só funciona em VTEX). Se ele quiser trocar tamanho ou quantidade, chame montar_carrinho de novo.',
          ].filter(Boolean).join('\n');
        }

        // comprador: cofre + o que veio na hora
        const salvo = await lerPerfil(userId).catch(() => null);
        const m = montarComprador(salvo, comprador || {});
        if (m.falta) {
          return `Pra montar o carrinho falta: ${m.falta.join(', ')}. PERGUNTE isso ao dono (não invente) e chame de novo passando em \`comprador\`.`
            + (salvo ? '' : ' Se ele quiser, posso salvar no cofre pra não perguntar mais (salvar_perfil:true).');
        }
        const c = m.perfil;

        // endereço: completa pelo CEP o que não veio
        if (!c.rua || !c.cidade || !c.estado) {
          const a = await cepLookup(origin, c.cep).catch(() => null);
          if (!a) return `A loja não reconheceu o CEP ${c.cep}. Confirme o CEP com o dono, ou passe rua/bairro/cidade/estado em \`comprador\`.`;
          c.rua = c.rua || a.street; c.bairro = c.bairro || a.neighborhood;
          c.cidade = c.cidade || a.city; c.estado = c.estado || a.state;
        }

        // frete disponível pro CEP (descobre as SLAs sem criar carrinho)
        const sim = await simular(origin, { skuId: item.skuId, seller: item.seller, quantidade: qtd, cep: c.cep }).catch(() => null);
        if (!sim?.fretes?.length) return `A loja não entrega no CEP ${c.cep} (nenhuma opção de frete pra esse item). Avise o dono.`;
        const entregas = sim.fretes.filter((f) => f.canal === 'delivery' && !f.retirada);
        if (!entregas.length) return `Nesse CEP a loja só oferece RETIRADA EM LOJA pra esse item, e retirada eu ainda não sei montar. Avise o dono.`;
        const pedido = norm(freteEscolhido);
        const frete = (pedido && entregas.find((f) => norm(f.nome).includes(pedido)))
          || [...entregas].sort((a, b) => a.preco - b.preco)[0];

        // ── carrinho real (jar compartilhado do começo ao fim) ──
        const jar = new Map();
        const of = await req(`${origin}/api/checkout/pub/orderForm`, { method: 'POST', body: {}, jar });
        const ofId = of.json?.orderFormId;
        if (!ofId) return `A loja não abriu carrinho (HTTP ${of.status}). Pode ser bloqueio a acesso automatizado; nesse caso mando o link pro dono fechar na mão.`;
        const base = `${origin}/api/checkout/pub/orderForm/${ofId}`;

        const add = await req(`${base}/items`, { method: 'POST', jar, body: { orderItems: [{ id: String(item.skuId), quantity: qtd, seller: String(item.seller) }] } });
        if (!add.json?.items?.length) return `Não consegui colocar o item no carrinho (HTTP ${add.status}).`;

        const [primeiro, ...resto] = c.nome.trim().split(/\s+/);
        await req(`${base}/attachments/clientProfileData`, {
          method: 'POST', jar,
          body: {
            email: c.email, firstName: primeiro, lastName: resto.join(' ') || primeiro,
            document: c.cpf, documentType: 'cpf', phone: fone(c.telefone), isCorporate: false,
          },
        });
        const ship = await req(`${base}/attachments/shippingData`, {
          method: 'POST', jar,
          body: {
            selectedAddresses: [{
              addressType: 'residential', receiverName: c.nome,
              postalCode: c.cep, city: c.cidade, state: c.estado, country: 'BRA',
              street: c.rua, number: String(c.numero), complement: c.complemento || '',
              neighborhood: c.bairro, geoCoordinates: [],
            }],
            logisticsInfo: [{ itemIndex: 0, selectedSla: frete.nome, selectedDeliveryChannel: 'delivery' }],
          },
        });
        if (!ship.json) return `A loja recusou o endereço (HTTP ${ship.status}). Confirme CEP e número com o dono.`;
        // Nunca reportar o frete que EU pedi: reportar o que a loja de fato
        // selecionou. Quando o pedido é ignorado (caso da retirada), o carrinho
        // volta com outra SLA e outro valor, e mentir aqui vira total errado.
        const liOf = ship.json.shippingData?.logisticsInfo?.[0] || {};
        const slaOf = (liOf.slas || []).find((s) => (s.id || s.name) === liOf.selectedSla);
        const freteReal = slaOf
          ? { nome: slaOf.id || slaOf.name, preco: Number(slaOf.price || 0), prazo: prazo(slaOf.shippingEstimate) }
          : frete;
        const outras = entregas.filter((f) => f.nome !== freteReal.nome);

        // cupom: testa os candidatos e fica com o de maior desconto (só um por vez)
        let carrinho = ship.json;
        const candidatos = [...new Set([...(cupom ? [String(cupom).trim().toUpperCase()] : []), ...produto.cupons])].slice(0, MAX_CUPONS);
        let melhor = { codigo: null, valor: Number(carrinho.value || 0) };
        const testados = [];
        for (const code of candidatos) {
          const t = await req(`${base}/coupons`, { method: 'POST', jar, body: { text: code } }).catch(() => null);
          if (!t?.json) continue;
          const aplicou = norm(t.json.marketingData?.coupon) === norm(code);
          const v = Number(t.json.value || 0);
          testados.push(`${code}${aplicou ? ` (-${brl(melhor.valor - v > 0 ? melhor.valor - v : 0)})` : ' (não aplicou)'}`);
          if (aplicou && v < melhor.valor) melhor = { codigo: code, valor: v };
          carrinho = t.json;
        }
        if (melhor.codigo && norm(carrinho.marketingData?.coupon) !== norm(melhor.codigo)) {
          const re = await req(`${base}/coupons`, { method: 'POST', jar, body: { text: melhor.codigo } }).catch(() => null);
          if (re?.json) carrinho = re.json;
        }

        if (salvar_perfil) { try { await gravarPerfil(userId, c); } catch { /* cofre off: segue sem salvar */ } }

        const t = totais(carrinho);
        const id = 'c' + randomUUID().replaceAll('-', '');
        limparCarrinhos();
        CARTS.set(`${userId}:${id}`, {
          criadoEm: Date.now(), userId, agentId, threadId: threadId || null,
          plataforma: 'vtex', moeda: 'BRL', origin, orderFormId: ofId, jar,
          produto: { nome: produto.nome, variacao: item.variacao, sku: item.skuId, qtd, link: produto.link || url, imagem: item.imagem || produto.imagem },
          comprador: c, frete: freteReal, cupom: carrinho.marketingData?.coupon || null,
          valor: t.total, pix: sim.pix || null, sistemas: sim.sistemas || [],
        });

        return [
          `CARRINHO MONTADO (nada foi cobrado ainda) — carrinho_id: ${id}`,
          `item: ${produto.nome} — ${item.variacao || 'única'} × ${qtd}`,
          `comprador: ${c.nome}, CPF ${maskCpf(c.cpf)}, ${c.email}`,
          `entrega: ${c.rua}, ${c.numero}${c.complemento ? ` (${c.complemento})` : ''} — ${c.bairro}, ${c.cidade}/${c.estado}, ${c.cep}`,
          `frete: ${freteReal.nome} ${brl(freteReal.preco)} em ${freteReal.prazo}`,
          outras.length ? `outras opções de frete: ${outras.map((f) => `${f.nome} ${brl(f.preco)} em ${f.prazo}`).join(' | ')} (pra trocar, chame de novo com frete:"nome")` : '',
          testados.length ? `cupons testados: ${testados.join(', ')}` : 'nenhum cupom anunciado na página',
          `subtotal ${brl(t.itens)}${t.desconto ? ` | desconto -${brl(Math.abs(t.desconto))}` : ''} | frete ${brl(t.frete)}`,
          `TOTAL: ${brl(t.total)}`,
          sim.pix ? `pagamento: Pix disponível (${sim.pix.name})` : 'pagamento: essa loja NÃO tem Pix.',
          '',
          'Mostre esse resumo ao dono COM O TOTAL e pergunte se pode fechar. Se ele topar, chame fechar_pedido com esse carrinho_id (ele ainda vai confirmar uma vez antes de valer). O carrinho expira em ~40 min; depois disso é só montar de novo.',
        ].filter(Boolean).join('\n');
      },
    },

    {
      name: 'fechar_pedido',
      description:
        'PLACES THE REAL ORDER in the store and returns the Pix for the owner to pay. It is the IRREVERSIBLE step: creates a real order, in their name, with a real charge. '
        + 'Only call it after montar_carrinho and after SHOWING the total to the owner. Goes through their explicit confirmation before executing. '
        + 'Do not invent carrinho_id: use the one montar_carrinho returned, and rebuild the cart if it has expired.',
      parameters: {
        type: 'object',
        properties: {
          carrinho_id: { type: 'string', description: 'The carrinho_id that montar_carrinho returned.' },
        },
        required: ['carrinho_id'],
      },
      prepareConfirmation: args => prepareCheckout(args),
      restoreConfirmation: (args,descriptor) => prepareCheckout(args,descriptor),
      // Sanity gate BEFORE it becomes a confirmation card (confirm.mjs calls
      // this in gateTool). Without it, a dead cart id became a confirmation
      // request with a total, the owner approved and ONLY THEN the tool refused:
      // they had confirmed a purchase that never existed (case of 10/09/2026,
      // where the model rebuilt the cart but sent the previous build's id).
      // Returning {erro} here, the model fixes the argument in the same turn and
      // the owner never sees the ghost.
      preflight: async ({ carrinho_id } = {}) => {
        const id = String(carrinho_id || '').trim();
        if (id && getCarrinho(userId, id)) return null;
        const vivo = carrinhoVivoDoThread(userId, threadId);
        if (vivo) {
          return { erro: `o carrinho "${id || '(vazio)'}" não existe mais aqui do meu lado. O carrinho vivo desta conversa é ${vivo.id} (${descreverCarrinho(vivo.id)}).` };
        }
        return { erro: 'não existe nenhum carrinho montado nesta conversa (carrinho vale ~40 min). Monte de novo com montar_carrinho e mostre o total ao dono antes de fechar.' };
      },
      // ATENÇÃO ao formato do retorno: esta tool é GATED, e o que ela devolve vai
      // DIRETO pro dono (confirm.mjs → renderConfirmed), sem passar pelo modelo.
      // Por isso o texto é escrito PRA ELE, e vem em `saida` dentro de um objeto:
      // string pura o renderConfirmed descarta, e o Pix se perderia no caminho.
      run: async ({ carrinho_id } = {}) => {
        const cart = getCarrinho(userId, String(carrinho_id || '').trim());
        // Não afirmar "expirou na loja": a loja nem foi consultada. O que
        // aconteceu foi eu perder a referência do carrinho aqui (TTL de ~40 min
        // ou reinício do serviço). Dizer o que de fato sei, nada além disso.
        if (!cart) return { ok: false, error: 'Perdi a referência desse carrinho aqui do meu lado (ele vale uns 40 minutos e some se o serviço reinicia), então não fechei nada e nada foi cobrado. Me peça pra montar de novo e eu te mostro o total atualizado antes.' };
        // Loja Shopify não tem como fechar por fora (o pagamento é na tela dela).
        // Em vez de tentar e falhar, devolvo o link que já monta o carrinho lá.
        if (cart.plataforma && cart.plataforma !== 'vtex') {
          return { ok: false, error: `Essa loja não deixa eu fechar o pedido por fora, o pagamento acontece na tela dela. Nada foi cobrado. O carrinho já está montado, é só abrir e finalizar:\n${cart.checkoutUrl || cart.produto?.link || ''}` };
        }
        if (!cart.pix) return { ok: false, error: `Essa loja não aceita Pix (o que ela tem: ${(cart.sistemas || []).map((s) => s.nome).join(', ') || 'nada que eu tenha reconhecido'}). Nada foi cobrado. Dá pra fechar na mão pelo site da loja.` };

        if (cart.checkoutAttempted) return {ok:false,error:'Este carrinho já teve uma tentativa de criação de pedido. Não vou repetir. Confira o estado na loja antes de outra compra.'};
        if (cart.checkoutBusy) return {ok:false,error:'Este carrinho já está sendo processado. Não iniciei outra tentativa.'};
        cart.checkoutBusy = true;
        try {
          const { origin, orderFormId: ofId, jar } = cart;
          const base = `${origin}/api/checkout/pub/orderForm/${ofId}`;
          const loja = (() => { try { return new URL(origin).host; } catch { return origin; } })();

          // 1) Reler o carrinho na loja ANTES de criar o pedido. O dono aprovou um
          // valor; se a loja mudou preço, frete ou derrubou o cupom nesse meio-tempo,
          // fechar seria cobrar um valor que ele não aprovou. Aí eu paro.
          const atual = await req(base, { jar }).catch(() => null);
          const valor = Number(atual?.json?.value || 0);
          if (!(atual?.status >= 200 && atual.status < 300) || !Number.isSafeInteger(valor) || valor <= 0) return { ok: false, error: `A loja não me devolveu o carrinho agora (HTTP ${atual?.status ?? 'sem resposta'}). Nada foi cobrado. Me peça pra montar de novo.` };
          if (valor !== Number(cart.valor)) {
            return { ok: false, error: `parei sem fechar: o total mudou na loja depois que você aprovou (era ${brl(cart.valor)}, agora ${brl(valor)}). Nada foi cobrado e nenhum pedido foi criado. Quer que eu feche por ${brl(valor)}?` };
          }

          // 2) paymentData ANTES do transaction. Sem isto o transaction devolve 200
          // com id/orderGroup null e a mensagem CHK0210 ("valor não confere"), ou
          // seja, falha silenciosa parecendo sucesso.
          const pd = await req(`${base}/attachments/paymentData`, {
            method: 'POST', jar,
            body: { payments: [{ paymentSystem: String(cart.pix.id), referenceValue: valor, value: valor, installments: 1, installmentsInterestRate: 0 }] },
          }).catch(() => null);
          if (!(pd?.status >= 200 && pd.status < 300) || !pd.json || (Array.isArray(pd.json.messages) && pd.json.messages.some(m=>String(m?.status).toLowerCase()==='error'))) return checkoutFailure('payment_data',pd,`Não consegui preparar o pagamento no carrinho (HTTP ${pd?.status ?? 'sem resposta'}). A criação do pedido não foi iniciada.`);

          // 3) Depois de enviar transaction, uma falha de resposta NÃO prova que
          // nada foi criado. Só prosseguir no pagamento com resposta de sucesso
          // e ambas as referências. Nunca repetir automaticamente o POST.
          let recoveryRecord;
          try { recoveryRecord=await checkoutRecoveryStore.reserve(recoveryScope,{origin,total:valor}); }
          catch { return {ok:false,error:'Não consegui preparar o registro protegido para recuperar o Pix. Parei antes de criar pedido ou enviar pagamento.'}; }
          cart.checkoutAttempted = true; // Set before network dispatch; never repeat an uncertain creation.
          const tr = await req(`${base}/transaction`, {
            method: 'POST', jar,
            body: { referenceId: ofId, savePersonalData: true, optinNewsLetter: false, value: valor, referenceValue: valor, interestValue: 0 },
          }).catch(() => null);
          const og = typeof tr?.json?.orderGroup === 'string' ? tr.json.orderGroup.trim() : '';
          const txId = typeof tr?.json?.id === 'string' ? tr.json.id.trim() : '';
          const conferirPedido = 'Não consigo consultar o estado atual do pedido por aqui. Confira com a loja antes de tentar outra compra, para evitar um pedido duplicado.';
          if (!(tr?.status >= 200 && tr.status < 300) || !og || !txId) {
            const referencias = [
              og ? `Referência de pedido recebida: ${og}.` : '',
              txId ? `Referência de transação recebida: ${txId}.` : '',
            ].filter(Boolean).join(' ');
            const failed = checkoutFailure('transaction',tr,[
              'Enviei a solicitação à loja, mas não recebi confirmação completa da criação do pedido. O resultado desta tentativa é incerto; não posso afirmar que nenhum pedido ou cobrança foi gerado.',
              referencias,
              conferirPedido,
            ].filter(Boolean).join(' '));
            failed.error = failed.saida; delete failed.saida; return failed;
          }
          try { await checkoutRecoveryStore.save(recoveryScope,recoveryRecord,og,'created'); }
          catch { return {ok:false,error:`A loja retornou a referência ${og}, mas não consegui preservá-la com segurança. Parei antes de enviar pagamento. Não repita: o estado do pedido precisa ser conferido.`}; }
          // Validade do código Pix não determina o estado/cancelamento do pedido.
          const avisoPix = 'O vencimento do Pix não confirma o cancelamento do pedido. ' + conferirPedido;

          // There is NO payment link to deliver. The purchase is made as a
          // guest through THIS process's cookie jar, so `/checkout/#/
          // orderPlaced?og=` and `/api/checkout/pub/orders/order-group/` only
          // open in that session: from any other browser the store returns 403
          // Access denied (measured on a VTEX store on 10/09). Sending that link
          // promises an exit that doesn't exist, so it was removed. The path
          // available here is Pix; don't infer cancellation without checking.
          const cabecalho = [
            `Pedido *${og}* na ${loja}.`,
            `${cart.produto.nome}${cart.produto.variacao ? ` (${cart.produto.variacao})` : ''} × ${cart.produto.qtd}`,
            `Entrega em ${cart.comprador.cidade}/${cart.comprador.estado}, CEP ${cart.comprador.cep} (${cart.frete?.nome}, ${cart.frete?.prazo}).`,
            `Total a pagar: *${brl(valor)}*`,
          ];

          // 4) Enviar o pagamento. Janela de ~5 min desde o passo 3, por isso 3-5
          // rodam numa tacada só, sem voltar pro modelo no meio.
          let request;
          try { request = paymentRequest(tr.json, cart.pix, valor); }
          catch (e) { return checkoutFailure('payment_contract',null,[...cabecalho,'','Recebi a referência da loja, mas não consegui validar os dados necessários para enviar o pagamento. Não enviei o pagamento nem obtive Pix.',avisoPix].join('\n'),e?.message); }
          const pay = await req(request.url, {method:'POST',jar,body:request.body}).catch(()=>null);
          if (pay?.status !== 201 || pay.json?.error || (Array.isArray(pay.json?.errors) && pay.json.errors.length)) {
            await checkoutRecoveryStore.save(recoveryScope,recoveryRecord,og,'payment_failed').catch(()=>{});
            return checkoutFailure('payment',pay,[...cabecalho,'',`Recebi a identificação do pedido, mas não consegui confirmar o resultado do envio do pagamento (HTTP ${pay?.status ?? 'sem resposta'}). Não obtive um Pix para te entregar; isso não comprova que nenhuma cobrança foi gerada.`,avisoPix].join('\n'));
          }

          // 5) gatewayCallback: é aqui que o conector devolve o Pix (copia-e-cola ou
          // a URL da tela dele). O 428 NÃO é erro: é o conector dizendo "o pagamento
          // precisa de continuação", por appPayload OU RedirectResponseCollection.
          const cb = await req(`${origin}/api/checkout/pub/gatewayCallback/${og}`, { method: 'POST', jar }).catch(() => null);
          const callbackAccepted=!!cb&&((cb.status>=200&&cb.status<300)||cb.status===428);
          try { await checkoutRecoveryStore.save(recoveryScope,recoveryRecord,og,callbackAccepted?'pix_received':'callback_failed',[pay.json,cb?.json]); }
          catch { return {ok:false,error:`Pedido ${og}: recebi a continuação da loja, mas não consegui preservar o retorno do Pix com segurança. Não repeti a tentativa. Confira o pedido antes de outra compra.`}; }
          if (!callbackAccepted) return checkoutFailure('callback',cb,[...cabecalho,'','O envio dos dados de pagamento foi aceito, mas não consegui confirmar o processamento nem obter um Pix utilizável.',avisoPix].join('\n'));
          const pix = extrairPix(pay.json, cb.json);

          if (pix?.tipo === 'copia-e-cola') {
            const hora = ateQueHoras(pix.expira);
            // O código vai SOZINHO numa linha, sem cerca de crase: em canal que
            // não renderiza markdown a crase é copiada junto e o banco recusa o
            // código. Uma linha limpa funciona em todos os canais.
            return { ok: true, saida: [...cabecalho, '',
              'Pix copia-e-cola (copie a linha inteira abaixo, e só ela):',
              pix.code,
              '',
              hora
                ? `Validade do Pix informada pela loja: até as ${hora} (horário de São Paulo).`
                : 'A loja não informou uma validade reconhecível para este Pix; não tenho um prazo confirmado.',
              avisoPix,
            ].join('\n') };
          }
          if (pix?.tipo === 'link') {
            return { ok: true, saida: [...cabecalho, '',
              `O Pix dessa loja quem gera é o parceiro de pagamento dela (${pix.app || 'conector da loja'}), então o código só nasce nesta tela. Abre aqui, o link inteiro (tirar qualquer pedaço quebra a página):`,
              pix.url,
              '',
              'Confira a validade do Pix na tela do parceiro; não tenho um prazo confirmado por aqui.',
              avisoPix,
            ].join('\n') };
          }
          if (pix?.tipo === 'quebrado') {
            return checkoutFailure('pix',cb,[...cabecalho, '',
              `Recebi a referência do pedido, mas o código Pix que ${pix.app || 'o parceiro de pagamento da loja'} devolveu não passou na verificação do dígito de integridade (ausente ou divergente), então não vou entregar esse código nem tentar corrigi-lo.`,
              avisoPix,
            ].join('\n'));
          }
          return checkoutFailure('pix',cb,[...cabecalho, '',
            `Recebi a referência do pedido, mas não consegui puxar o Pix por aqui. A continuação do pagamento respondeu HTTP ${cb?.status ?? 'sem resposta'}, sem código Pix ou link utilizável reconhecido por esta integração. Isso não comprova que a loja recusou o pagamento nem que o pedido foi cancelado.`,
            avisoPix,
          ].join('\n'));
        } finally { cart.checkoutBusy = false; }
      },
    },

    {
      name: 'salvar_perfil_compra',
      description:
        'Saves in the vault (encrypted) the data the store asks for to identify the owner in a purchase: name, CPF, e-mail, mobile phone and delivery address. OPTIONAL: it only serves so you do not ask again on every purchase. '
        + 'Only call it with their explicit OK, and never invent data.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Full name, as on the CPF.' },
          cpf: { type: 'string' },
          email: { type: 'string' },
          telefone: { type: 'string', description: 'Mobile phone with area code (DDD).' },
          cep: { type: 'string' },
          numero: { type: 'string' },
          complemento: { type: 'string' },
          rua: { type: 'string' }, bairro: { type: 'string' }, cidade: { type: 'string' }, estado: { type: 'string' },
        },
        required: ['nome', 'cpf', 'email', 'telefone', 'cep', 'numero'],
      },
      run: async (args = {}) => {
        if (!vaultEnabled()) return 'ERRO: o cofre não está configurado nesta instância, então não posso guardar CPF cifrado. Dá pra comprar mesmo assim: é só me passar os dados na hora.';
        const m = montarComprador(null, args);
        if (m.falta) return `Faltou: ${m.falta.join(', ')}.`;
        // Rua/bairro/cidade ficam em branco de propósito quando não vieram: quem
        // completa é a PRÓPRIA loja pelo CEP, na hora do carrinho (endpoint dela).
        const c = m.perfil;
        try { await gravarPerfil(userId, c); }
        catch (e) { return `ERRO ao guardar: ${e?.message ?? e}`; }
        return `Perfil de compra guardado (cifrado): ${c.nome}, CPF ${maskCpf(c.cpf)}, ${c.email}, entrega em ${c.rua || '(rua pelo CEP)'}, ${c.numero} — ${c.cidade}/${c.estado}, ${c.cep}. Não vou mais perguntar isso a cada compra.`;
      },
    },

    {
      name: 'ver_perfil_compra',
      description: 'Shows the owner\'s saved purchase profile (CPF always masked). Use when they ask what data you have, or before a purchase to confirm the address.',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        const p = await lerPerfil(userId).catch(() => null);
        if (!p) return 'Ele não tem perfil de compra salvo. Sem problema: dá pra comprar passando os dados na hora.';
        return `Perfil de compra: ${p.nome}, CPF ${maskCpf(p.cpf)}, ${p.email}, ${p.telefone}. Entrega: ${p.rua}, ${p.numero}${p.complemento ? ` (${p.complemento})` : ''} — ${p.bairro}, ${p.cidade}/${p.estado}, ${p.cep}.`;
      },
    },
  ];

  // Honesty envelope + trace, applied after building the list so the same rule
  // isn't spread across ten return points.
  //
  // 1. montar_carrinho fails by returning PROSE ("Não achei a variação...",
  //    "está com 0 em estoque..."), indistinguishable from success narration to
  //    whoever only reads text. A hard prefix stops the model from continuing
  //    the purchase thinking a cart exists.
  // 2. the log gives the trace missing from the post-mortem of 10/09/2026,
  //    when the only way to know if the build worked was to infer it from the
  //    result size in the cache. No URL, no CPF, no address.
  const marcar = (t) => {
    const orig = t.run;
    t.run = async (args = {}) => {
      const t0 = Date.now();
      let out;
      try { out = await orig(args); }
      catch (e) {
        console.log(`[compras] ${t.name} user=${userId} EXCECAO ${Date.now() - t0}ms: ${e?.message ?? e}`);
        throw e;
      }
      const txt = typeof out === 'string' ? out : '';
      const ok = t.name === 'montar_carrinho' ? txt.startsWith('CARRINHO MONTADO') : !(out && typeof out === 'object' && out.ok === false);
      console.log(`[compras] ${t.name} user=${userId} ${ok ? 'ok' : 'FALHOU'} ${Date.now() - t0}ms${out?.diagnostic_ref ? ` diagnostic=${out.diagnostic_ref}` : ''}${ok ? '' : ` motivo="${txt.slice(0, 120).replace(/\s+/g, ' ')}"`}`);
      if (ok || t.name !== 'montar_carrinho') return out;
      return `NÃO MONTEI O CARRINHO (não existe carrinho novo, não diga ao dono que montou nem chame fechar_pedido): ${txt}`;
    };
    return t;
  };
  return tools.map(marcar);
}

// Bloco curto pro fim do prompt: a capacidade de comprar não é óbvia a partir do
// nome das tools, e o caso de uso nasce de um LINK colado no chat.
export function comprasContext() {
  return 'RECUPERAR PIX: se o dono pedir o Pix de um pedido existente, use recuperar_pix_pedido com a referência. Nunca use fechar_pedido nem monte carrinho como substituto de recuperação. A ferramenta lê o retorno protegido, revalida e não gera cobrança. Se não houver registro ou estiver vencido, informe o motivo sem inventar cancelamento. COMPRA POR LINK: consulte analisar_produto para verificar o que é possível na loja e oferta exatas; somente após sucesso use montar_carrinho para conferir variante, quantidade, preço, frete e total. Preserve as restrições já pedidas mesmo ao mudar o link ou vendedor. Essas consultas não cobram. Não prometa que consegue comprar, montar carrinho ou gerar Pix antes do retorno correspondente. Internamente: VTEX permite fechar_pedido depois de total e confirmação; Shopify fornece link de checkout, cujo pagamento cabe ao dono. Na conversa, descreva a capacidade efetivamente comprovada em linguagem simples, sem nomes de plataformas internas; uma loja sem suporte exige finalizar no site. Preço/estoque de outra oferta e anúncio de potência/qualidade não comprovam as características desta compra.';
}
