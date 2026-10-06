// Fontes reais + conferência de link, aplicadas no texto FINAL do turno.
//
// Nasceu do caso LinkedIn (08/09/2026): 2 dos 9 links entregues eram 404, em
// mensagens que diziam "links diretos e validados". Duas causas, os dois remédios
// daqui:
//  1. a busca NATIVA do Gemini roda no servidor do Google e não aparece como tool
//     call, então as URLs reais que embasaram a resposta eram descartadas e sobrava
//     o modelo escrevendo o endereço de memória -> `blocoDeFontes` mostra as reais;
//  2. ninguém, em lugar nenhum do código, chegava a ABRIR um link antes de mandar
//     -> `conferirLinks` bate um pedido em cada um.
//
// Regra de ouro da conferência (29/09/2026): link só sai do texto com falha
// REAL comprovada em dois pedidos seguidos (HEAD e depois GET): domínio que não
// existe (DNS ENOTFOUND), conexão recusada, `404`/`410` ou `5xx` que se repete.
// Fica no texto: redirecionamento (`3xx`, seguido até 5 saltos; `200` no fim é
// link bom), `401`/`403` (login ou bloqueio de robô em IP de datacenter:
// mckinsey, gartner, rand fazem isso com a página no ar), `429` (limite de taxa)
// e timeout ou outro erro de rede. Nesses casos a gente avisa que não conseguiu
// verificar, sem acusar uma página viva de estar morta.
//
// Regra antiga, pra referência: HEAD com `redirect: 'error'`; só `404`/`410` no
// HEAD confirmado por `404`/`410` no GET contava como quebrado. Todo `3xx` (até
// um redirect pra página boa), DNS inexistente, conexão recusada e `5xx` viravam
// "não verificado". Na resposta comum isso só gerava o aviso; em rotina
// (`strictLinks`) o link "não verificado" também era tirado do texto, inclusive
// o link bom que redirecionava, o `403` e o que passou do teto de 8 conferências.
//
// Este módulo roda no caminho de TODO turno, então não puxa dependência pesada.
// A única importação é `locale.mjs`, que é puro (sem banco, sem HTTP) e já está
// carregado pelo server: duplicar aqui a normalização de idioma sairia mais caro
// que importá-la, porque duas cópias divergem na primeira mudança.
import { uaBot } from './marca.mjs';
import { tagIdioma, IDIOMA_PADRAO } from './locale.mjs';

// O texto daqui é ANEXADO à resposta final, ou seja, a pessoa lê direto, sem o
// modelo reescrever. Por isso precisa do idioma DELA (`users.language`), a mesma
// fonte da diretriz do prompt.
//
// Contraste que importa: o "Fontes:" do `websearch.mjs` fica em português de
// propósito, porque aquele texto é RETORNO DE TOOL, vai pro modelo e não pra
// tela; o modelo já responde no idioma de quem perguntou.
//
// Os avisos são determinísticos nos três idiomas atendidos.
const TEXTOS = {
  'pt-BR': {
    fontes: 'Fontes:', naoVerificado: '[link não verificado]', itemNaoVerificado: '[Item omitido: link não verificado]', indisponivel: '[link indisponível]', item: '[Item omitido: link indisponível]',
    removidos: n => `⚠️ Removi ${n} link(s) que falharam em duas tentativas (HTTP 404/410, erro 5xx, domínio inexistente ou conexão recusada). Não encontrei substitutos nesta conferência.`,
    limitados: n => `⚠️ Não consegui verificar ${n} link(s) por bloqueio, erro de rede ou limite de conferência. Eles NÃO estão validados; isso não prova que as páginas deixaram de existir.`,
  },
  en: {
    fontes: 'Sources:', naoVerificado: '[link not verified]', itemNaoVerificado: '[Item omitted: link not verified]', indisponivel: '[link unavailable]', item: '[Item omitted: link unavailable]',
    removidos: n => `⚠️ Removed ${n} link(s) that failed twice (HTTP 404/410, 5xx error, nonexistent domain or refused connection). This check did not find replacements.`,
    limitados: n => `⚠️ Could not verify ${n} link(s) due to blocking, network errors or the checking limit. They are NOT validated; this does not prove that the pages no longer exist.`,
  },
  es: {
    fontes: 'Fuentes:', naoVerificado: '[enlace no verificado]', itemNaoVerificado: '[Elemento omitido: enlace no verificado]', indisponivel: '[enlace no disponible]', item: '[Elemento omitido: enlace no disponible]',
    removidos: n => `⚠️ Retiré ${n} enlace(s) que fallaron en dos intentos (HTTP 404/410, error 5xx, dominio inexistente o conexión rechazada). Esta comprobación no encontró reemplazos.`,
    limitados: n => `⚠️ No pude verificar ${n} enlace(s) por bloqueo, error de red o límite de comprobación. NO están validados; esto no demuestra que las páginas hayan dejado de existir.`,
  },
};
const textosDe = language => TEXTOS[tagIdioma(language)] || TEXTOS[IDIOMA_PADRAO];

const TIMEOUT_MS = 3000;       // por pedido (HEAD ou GET), somando os saltos de redirect
const MAX_REDIRECTS = 5;
const MAX_LINKS = 8;          // teto de conferências por turno (latência)
const MAX_FONTES = 5;         // teto de fontes mostradas
const UA = () => uaBot();

// Cache curto por URL: uma thread que repete o mesmo link em turnos seguidos não
// paga a rede de novo, e o mesmo link citado por várias pessoas confere uma vez.
const cache = new Map(); // url -> { veredito, ts }
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 500;

// URLs http(s) do texto. O linkificador dos canais para nos mesmos caracteres, e a
// classe abaixo (sem espaço, sem <>()[]"'`) já derruba o caso comum de link
// markdown `[texto](url)`. Pontuação final da frase sai fora.
// Link SEM "https://" também conta (caso de 02/10/2026: o modelo escreveu
// `panelinha.com.br/receita/<nome inventado>` e a conferência nem viu, porque só
// procurava endereço com esquema; o WhatsApp mostra esse texto como link). Pra não
// confundir com nome de arquivo ou e-mail, o endereço sem esquema precisa de
// caminho (`dominio.tld/...`) ou começar com `www.`, não pode vir colado em `@`,
// `/` ou `.`, e o final do domínio não pode ser extensão de arquivo
// (`server.mjs/x`). Ele é conferido como https.
const RE_URL = /https?:\/\/[^\s<>()[\]"'`]+|(?<![A-Za-z0-9@./:-])(?:www\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>()[\]"'`]*)?|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\/[^\s<>()[\]"'`]*)/g;
const EXTENSAO = /\.(?:m?js|cjs|ts|tsx|jsx|json|md|py|sh|txt|pdf|csv|html?|png|jpe?g|gif|svg|webp|ya?ml|xml|zip|docx?|xlsx?|pptx?|log|env|lock|rs|go|rb|java|css|sql|ini|toml)$/i;
const semEsquema = u => !/^https?:\/\//.test(u);
const paraConferir = u => semEsquema(u) ? 'https://' + u : u;
// Pontuação de fim de frase sai; no endereço sem esquema, também a marcação do
// canal em volta dele (*negrito*, _itálico_, ~riscado~).
const limpaFim = u => u.replace(semEsquema(u) ? /[.,;:!?*_~]+$/ : /[.,;:!?]+$/, '');
function aceitaSemEsquema(u) {
  const host = u.split('/')[0];
  return !EXTENSAO.test(host);
}

function mapProse(text, fn) {
  const parts = String(text ?? '').split(/(```[\s\S]*?```)/g);
  const open = parts.findIndex((p, i) => i % 2 === 0 && p.includes('```'));
  return parts.map((p, i) => i % 2 || (open >= 0 && i >= open) ? p
    : p.split(/(`[^`\n]*`)/g).map((v, j) => j % 2 ? v : fn(v)).join('')).join('');
}

// Também vale pra cada salto de redirect: um link público não pode levar o
// verificador pra rede interna (ex.: metadata da EC2 em 169.254.169.254).
const hostInterno = host => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i.test(host);

function extrairUrls(texto) {
  const out = [];
  const seen = new Set();
  const prose = []; mapProse(texto, p => { prose.push(p); return p; });
  for (const m of prose.join('\n').matchAll(RE_URL)) {
    let u = limpaFim(m[0]);
    // Parêntese no caminho (Wikipédia: /wiki/Foo_(bar)) é cortado pela regex e o
    // pedaço truncado responderia 404: seria acusar de quebrado um link bom. Fora.
    if (m.input[m.index + m[0].length] === '(') continue;
    // URL assinada (S3 presign) responde 403 a HEAD por causa da assinatura: não
    // dá pra conferir e não vale gastar rede.
    if (/[?&]X-Amz-Signature=/i.test(u)) continue;
    if (semEsquema(u) && !aceitaSemEsquema(u)) continue;
    let host = '';
    try { host = new URL(paraConferir(u)).hostname; } catch { continue; }
    // Rede interna/local: nunca sai daqui pra conferir.
    if (hostInterno(host)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// Códigos de erro de rede que provam falha real: o domínio não existe ou o
// servidor recusou a conexão. Timeout, reset, TLS e bloqueio do egress não provam
// nada sobre a página.
const REDE_PROVA = new Set(['ENOTFOUND', 'ECONNREFUSED']);
function codigoDeRede(error) {
  const cause = error?.cause;
  const codes = [error?.code, cause?.code, ...(Array.isArray(cause?.errors) ? cause.errors.map(e => e?.code) : [])].filter(Boolean);
  if (codes.includes('ENOTFOUND')) return 'ENOTFOUND';
  // Com mais de um endereço (IPv4 e IPv6) todos precisam ter recusado.
  if (Array.isArray(cause?.errors) && cause.errors.length) return cause.errors.every(e => e?.code === 'ECONNREFUSED') ? 'ECONNREFUSED' : null;
  return codes.includes('ECONNREFUSED') ? 'ECONNREFUSED' : null;
}

// Um pedido, seguindo redirect na mão (até MAX_REDIRECTS, nunca pra host
// interno). Devolve { status, redirecionou } ou { rede: código|null }.
async function pedir(url, method) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let atual = url;
  try {
    for (let salto = 0; ; salto++) {
      const res = await fetch(atual, { method, redirect: 'manual', signal, headers: { 'user-agent': UA() } });
      try { await res.body?.cancel?.(); } catch { /* noop */ }
      const loc = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
      if (!loc) return { status: res.status, redirecionou: salto > 0 };
      let prox;
      try { prox = new URL(loc, atual); } catch { return { status: res.status, redirecionou: true }; }
      if (salto >= MAX_REDIRECTS || !/^https?:$/.test(prox.protocol) || hostInterno(prox.hostname)) {
        return { status: res.status, redirecionou: true };
      }
      atual = prox.href;
    }
  } catch (error) {
    return { rede: codigoDeRede(error) };
  }
}

// 'ok' | 'falha' | 'indefinido' pra um pedido. Falha só com prova: 404/410/5xx
// sem redirect no meio, ou DNS inexistente / conexão recusada.
function avaliar(r) {
  if (r.rede !== undefined) return r.rede && REDE_PROVA.has(r.rede) ? 'falha' : 'indefinido';
  if (r.status >= 200 && r.status < 300) return 'ok';
  if (r.redirecionou) return 'indefinido';
  if (r.status === 404 || r.status === 410 || (r.status >= 500 && r.status < 600)) return 'falha';
  return 'indefinido';
}

// 'ok' | 'quebrado' | 'indefinido'. Um HEAD resolve a maioria; a falha só é dada
// como certa depois de um GET repetir, porque servidor que responde errado a
// HEAD existe, 5xx pode ser passageiro e um falso "link quebrado" é pior que não
// conferir.
async function conferirUma(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.veredito;
  let veredito = avaliar(await pedir(url, 'HEAD'));
  if (veredito === 'falha') {
    const get = avaliar(await pedir(url, 'GET'));
    veredito = get === 'falha' ? 'quebrado' : get;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(url, { veredito, ts: Date.now() });
  return veredito;
}

// Somente links exatos de mensagens observadas nas ferramentas deste turno.
// A API autenticada comprova a fonte; não comprova que uma URL abre sem login.
// Não aplicar esta exceção a links no corpo do e-mail ou a um domínio inteiro.
function isAuthenticatedEmailSource(value, observed) {
  if (!observed.has(value)) return false;
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (u.hostname === 'mail.google.com') {
    return /^\/mail\/(?:u\/\d+\/)?$/.test(u.pathname) && /^#all\/[A-Za-z0-9_%=-]+$/.test(u.hash)
      && [...u.searchParams.keys()].every(key=>key==='authuser')
      && u.searchParams.getAll('authuser').length<=1;
  }
  if (!['outlook.live.com','outlook.office.com','outlook.office365.com'].includes(u.hostname) || u.hash) return false;
  if (u.pathname === '/owa/' || u.pathname === '/owa') {
    return !!u.searchParams.get('ItemID') && u.searchParams.get('viewmodel') === 'ReadMessageItem'
      && [...u.searchParams.keys()].every(key=>['ItemID','exvsurl','viewmodel'].includes(key));
  }
  return /^\/mail\/(?:\d+\/)?(?:deeplink\/read|(?:inbox|sentitems|drafts|deleteditems|junkemail|archive)\/id)\/[A-Za-z0-9_%=-]+\/?$/.test(u.pathname)
    && [...u.searchParams.keys()].every(key=>['exvsurl','popoutv2'].includes(key));
}

/**
 * Confere todos os links do texto (em paralelo) e devolve os que estão QUEBRADOS.
 * Não mexe no texto: quem chama decide o que fazer com a lista.
 * authenticatedSources são fontes observadas pela API, NÃO URLs HTTP validadas.
 * @returns {Promise<{quebrados:string[], indefinidos:string[], naoChecados:string[], checados:number, authenticatedSources:string[]}>}
 */
export async function conferirLinks(texto, { authenticatedEmailSources = [] } = {}) {
  const observed = new Set(authenticatedEmailSources);
  const extracted = extrairUrls(texto);
  const authenticatedSources = extracted.filter(u=>isAuthenticatedEmailSource(u,observed));
  const authenticated = new Set(authenticatedSources);
  const all = extracted.filter(u=>!authenticated.has(u)), urls = all.slice(0, MAX_LINKS);
  const vereditos = await Promise.all(urls.map(async u => [u, await conferirUma(paraConferir(u))]));
  return {
    quebrados: vereditos.filter(([, v]) => v === 'quebrado').map(([u]) => u),
    indefinidos: vereditos.filter(([, v]) => v === 'indefinido').map(([u]) => u),
    naoChecados: all.slice(MAX_LINKS), checados: urls.length, authenticatedSources,
  };
}

/**
 * A URI que a busca nativa devolve é um redirect OPACO do vertexaisearch, que
 * expira e não diz nada pro usuário. Segue o primeiro salto pra achar o endereço
 * real. Devolve '' quando não resolve (aí a fonte não é mostrada).
 */
export async function resolveGroundingUri(uri) {
  const u = String(uri || '');
  if (!/^https:\/\/vertexaisearch\.cloud\.google\.com\//i.test(u)) return u;
  try {
    const res = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
      headers: { 'user-agent': uaBot({ comSite: false }) },
    });
    const loc = res.headers.get('location');
    try { await res.body?.cancel?.(); } catch { /* noop */ }
    if (loc && /^https?:\/\//i.test(loc)) return loc;
  } catch { /* noop */ }
  return '';
}

/**
 * Lista numerada "[1] título — url", com os redirects já resolvidos.
 * Com `registro` (registroDeFontes do turno, citacoes.mjs) o número é o do
 * registro: fixo no turno inteiro, é o que o modelo escreve na resposta e o que a
 * plataforma troca pela fonte real. Fonte sem endereço resolvido fica sem número,
 * porque não tem como ser citada.
 */
export async function renderFontes(sources, registro = null) {
  const arr = (sources || []).slice(0, 10);
  const resolved = await Promise.all(arr.map(async (s) => ({ title: s.title, uri: await resolveGroundingUri(s.uri) })));
  return resolved.map((s, i) => {
    const n = registro ? registro.add(s) : i + 1;
    return `${n ? `[${n}] ` : '- '}${s.title}${s.uri ? ' — ' + s.uri : ''}`;
  }).join('\n');
}

/**
 * Bloco "Fontes:" no mesmo formato do `buscar_web` (renderFontes), a
 * partir das fontes de grounding da busca nativa. Resolve o redirect opaco do
 * vertexaisearch pro endereço real e descarta o que não resolver.
 * @returns {Promise<string>} bloco pronto, ou '' se não sobrar nada pra mostrar
 */
export async function blocoDeFontes(sources, language) {
  const arr = (sources || []).slice(0, MAX_FONTES);
  if (!arr.length) return '';
  const lista = await renderFontes(arr);
  // renderFontes deixa a linha sem URL quando o redirect não resolveu; sem
  // endereço a "fonte" não serve pra nada aqui, então some.
  const linhas = lista.split('\n').filter((l) => /https?:\/\//.test(l));
  if (!linhas.length) return '';
  const rotulo = textosDe(language)?.fontes || 'Fontes:';
  return `${rotulo}\n${linhas.map((l, i) => l.replace(/^\[\d+\]/, `[${i + 1}]`)).join('\n')}`;
}

/**
 * Costura os dois no texto final do turno.
 *  - `sources`: grounding da busca nativa (pode vir vazio);
 *  - anexa "Fontes:" quando a busca rodou e a resposta ainda não traz uma lista;
 *  - avisa, com honestidade, quando algum link entregue não abriu.
 * Retira links comprovadamente quebrados e sinaliza limites, sem inventar substitutos.
 * @returns {Promise<{texto:string, quebrados:string[], fontes:number}>}
 */
export async function fontesEConferencia(texto, sources = [], { mostrarFontes = true, language, strictLinks = false, authenticatedEmailSources = [] } = {}) {
  const base = String(texto ?? '');
  // O modelo responde no idioma da pessoa, então a lista que ele já escreveu
  // pode vir como "Sources:" ou "Fuentes:". Reconhecer as três evita anexar um
  // bloco de fontes em cima de outro que já está lá.
  const jaTemLista = /(^|\n)\s*(fontes|sources|fuentes)\s*:/i.test(base);
  const t = textosDe(language);
  const bloco = mostrarFontes && !jaTemLista ? await blocoDeFontes(sources, language).catch(() => '') : '';
  // Conferir também as fontes anexadas: antes elas passavam fora do verificador.
  let out = base + (bloco ? `\n\n${bloco}` : '');
  // A política estrita de rotinas continua exigindo verificação HTTP pública;
  // sua confirmação autenticada de mensagens é tratada pela curadoria própria.
  const { quebrados, indefinidos, naoChecados, authenticatedSources } = await conferirLinks(out, {
    authenticatedEmailSources: strictLinks ? [] : authenticatedEmailSources,
  });
  if (quebrados.length) {
    out = omitBrokenLinks(out, quebrados, language);
    out += `\n\n${t.removidos(quebrados.length)}`;
  }
  // Link não verificado (redirect, 401/403, 429, timeout, teto de 8) fica no
  // texto, com o aviso abaixo, inclusive em rotina. Até 29/09/2026 a rotina
  // (`strictLinks`) tirava esses links também.
  const naoVerificados = indefinidos.length + naoChecados.length;
  if (naoVerificados) out += `\n\n${t.limitados(naoVerificados)}`;
  return { texto: out, quebrados, indefinidos, naoChecados, authenticatedSources, fontes: bloco ? bloco.split('\n').length - 1 : 0 };
}

// Não inventa URL substituta nem manda outra vez o endereço sabidamente quebrado.
// Em listas simples omite a linha do item e suas continuações; em prosa/tabelas
// preserva o texto e retira só o endereço. Código literal passa intacto.
export function omitBrokenLinks(text, broken, language, { unverified = false } = {}) {
  const bad = new Set(broken), t = textosDe(language);
  const itemLabel = unverified ? t.itemNaoVerificado : t.item;
  const linkLabel = unverified ? t.naoVerificado : t.indisponivel;
  const item = /^\s*(?:[-*•]|\d+[.)]|\[\d+\])\s+/;
  return mapProse(text, part => {
    let dropping = false;
    return part.split('\n').map(line => {
      const isItem = item.test(line);
      if (!line.trim() || isItem || /^\s*#/.test(line)) dropping = false;
      if (dropping) return '';
      const urls = [...line.matchAll(RE_URL)].map(m => limpaFim(m[0]));
      if (isItem && urls.length && urls.every(u => bad.has(u))) {
        dropping = true;
        return line.match(item)[0] + itemLabel;
      }
      // Retira também o invólucro markdown do endereço, sem deixar link falso.
      let out = line.replace(/\[([^\]\n]*)\]\(((?:https?:\/\/)?[^\s()]+)\)/g,
        (all, label, url) => bad.has(url) ? `${label} ${linkLabel}` : all);
      return out.replace(RE_URL, raw => {
        const url = limpaFim(raw);
        return bad.has(url) ? linkLabel + raw.slice(url.length) : raw;
      });
    }).join('\n');
  });
}
