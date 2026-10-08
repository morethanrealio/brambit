// Real sources + link checking, applied to the turn's FINAL text.
//
// Born from the LinkedIn case (2026-09-08): 2 of the 9 links delivered were
// 404, in messages that said "direct, validated links". Two causes, the two
// fixes here:
//  1. Gemini's NATIVE search runs on Google's server and doesn't show up as a
//     tool call, so the real URLs that backed the response were discarded and
//     the model was left writing the address from memory -> `blocoDeFontes`
//     shows the real ones;
//  2. nowhere in the code did anyone actually OPEN a link before sending it
//     -> `conferirLinks` makes a request to each one.
//
// Golden rule of the check (2026-09-29): a link only comes out of the text
// with a REAL failure proven across two requests in a row (HEAD and then
// GET): a domain that doesn't exist (DNS ENOTFOUND), connection refused,
// `404`/`410`, or a repeating `5xx`. Stays in the text: a redirect (`3xx`,
// followed up to 5 hops; `200` at the end is a good link), `401`/`403`
// (login or bot blocking on a datacenter IP: mckinsey, gartner, rand do this
// with the page still live), `429` (rate limit), and a timeout or other
// network error. In those cases we say we couldn't verify it, instead of
// accusing a live page of being dead.
//
// Old rule, for reference: HEAD with `redirect: 'error'`; only a `404`/`410`
// on HEAD confirmed by a `404`/`410` on GET counted as broken. Every `3xx`
// (even a redirect to a good page), a nonexistent DNS, a refused connection
// and `5xx` all turned into "unverified". In a regular response this only
// produced the notice; in a routine (`strictLinks`) an "unverified" link was
// also stripped from the text, including a good link that redirected, a
// `403`, and one that went over the cap of 8 checks.
//
// This module runs on the path of EVERY turn, so it doesn't pull in a heavy
// dependency. The only import is `locale.mjs`, which is pure (no database, no
// HTTP) and is already loaded by the server: duplicating the language
// normalization here would cost more than importing it, because two copies
// drift apart the first time one of them changes.
import { uaBot } from './marca.mjs';
import { tagIdioma, LEGACY_TEXT_LANGUAGE } from './locale.mjs';

// The text here is APPENDED to the final reply, so the person reads it
// directly, with no model rewrite. That's why it needs THEIR language
// (`users.language`), the same source as the prompt directive.
//
// Contrast that matters: the "Fontes:" in `websearch.mjs` stays in Portuguese
// on purpose, because that text is a TOOL RESULT, goes to the model and not to
// the screen; the model already answers in the asker's language.
//
// Notices are deterministic in the three supported languages and speak the
// reader's language: no HTTP codes, "network" or "cap" (06/10/2026).
const TEXTOS = {
  'pt-BR': {
    fontes: 'Fontes:', naoVerificado: '[link não verificado]', itemNaoVerificado: '[Item omitido: link não verificado]', indisponivel: '[link indisponível]', item: '[Item omitido: link indisponível]',
    removidos: n => n === 1
      ? '⚠️ Removi 1 link que não abriu em duas tentativas: a página não existe mais ou o site está fora do ar. Não achei outro endereço para pôr no lugar.'
      : `⚠️ Removi ${n} links que não abriram em duas tentativas: as páginas não existem mais ou os sites estão fora do ar. Não achei outros endereços para pôr no lugar.`,
  },
  en: {
    fontes: 'Sources:', naoVerificado: '[link not verified]', itemNaoVerificado: '[Item omitted: link not verified]', indisponivel: '[link unavailable]', item: '[Item omitted: link unavailable]',
    removidos: n => n === 1
      ? '⚠️ I removed 1 link that did not open after two tries: the page no longer exists or the site is down. I could not find another address to put in its place.'
      : `⚠️ I removed ${n} links that did not open after two tries: the pages no longer exist or the sites are down. I could not find other addresses to put in their place.`,
  },
  es: {
    fontes: 'Fuentes:', naoVerificado: '[enlace no verificado]', itemNaoVerificado: '[Elemento omitido: enlace no verificado]', indisponivel: '[enlace no disponible]', item: '[Elemento omitido: enlace no disponible]',
    removidos: n => n === 1
      ? '⚠️ Quité 1 enlace que no abrió en dos intentos: la página ya no existe o el sitio está caído. No encontré otra dirección para poner en su lugar.'
      : `⚠️ Quité ${n} enlaces que no abrieron en dos intentos: las páginas ya no existen o los sitios están caídos. No encontré otras direcciones para poner en su lugar.`,
  },
};
const textosDe = language => TEXTOS[tagIdioma(language)] || TEXTOS[LEGACY_TEXT_LANGUAGE];

const TIMEOUT_MS = 3000;       // per request (HEAD or GET), counting the redirect hops
const MAX_REDIRECTS = 5;
const MAX_LINKS = 8;          // cap on checks per turn (latency)
const MAX_FONTES = 5;         // cap on sources shown
const UA = () => uaBot();

// Short per-URL cache: a thread that repeats the same link across
// consecutive turns doesn't pay the network cost again, and the same link
// cited by several people only gets checked once.
const cache = new Map(); // url -> { veredito, ts }
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 500;

// http(s) URLs in the text. The channels' linkifier stops at the same
// characters, and the class below (no space, no <>()[]"'`) already handles
// the common markdown link case `[text](url)`. Trailing sentence punctuation
// is excluded.
// A link WITHOUT "https://" also counts (case from 2026-10-02: the model
// wrote `panelinha.com.br/receita/<made-up name>` and the check didn't even
// see it, because it only looked for an address with a scheme; WhatsApp
// shows that text as a link). To avoid confusing it with a filename or an
// e-mail, a schemeless address needs a path (`domain.tld/...`) or to start
// with "www.", can't be glued to `@`, `/` or `.`, and the domain's ending
// can't be a file extension (`server.mjs/x`). It's checked as https.
const RE_URL = /https?:\/\/[^\s<>()[\]"'`]+|(?<![A-Za-z0-9@./:-])(?:www\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>()[\]"'`]*)?|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\/[^\s<>()[\]"'`]*)/g;
const EXTENSAO = /\.(?:m?js|cjs|ts|tsx|jsx|json|md|py|sh|txt|pdf|csv|html?|png|jpe?g|gif|svg|webp|ya?ml|xml|zip|docx?|xlsx?|pptx?|log|env|lock|rs|go|rb|java|css|sql|ini|toml)$/i;
const semEsquema = u => !/^https?:\/\//.test(u);
const paraConferir = u => semEsquema(u) ? 'https://' + u : u;
// Trailing sentence punctuation is excluded; for a schemeless address, so is
// the channel's markup around it (*bold*, _italic_, ~strikethrough~).
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

// Also applies to every redirect hop: a public link can't lead the verifier
// into the internal network (e.g. EC2 metadata at 169.254.169.254).
const hostInterno = host => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i.test(host);

function extrairUrls(texto) {
  const out = [];
  const seen = new Set();
  const prose = []; mapProse(texto, p => { prose.push(p); return p; });
  for (const m of prose.join('\n').matchAll(RE_URL)) {
    let u = limpaFim(m[0]);
    // A parenthesis in the path (Wikipedia: /wiki/Foo_(bar)) gets cut by
    // the regex and the truncated piece would respond 404: that would be
    // accusing a good link of being broken. Excluded.
    if (m.input[m.index + m[0].length] === '(') continue;
    // A signed URL (S3 presign) responds 403 to HEAD because of the
    // signature: there's no way to check it and it's not worth spending the
    // network call.
    if (/[?&]X-Amz-Signature=/i.test(u)) continue;
    if (semEsquema(u) && !aceitaSemEsquema(u)) continue;
    let host = '';
    try { host = new URL(paraConferir(u)).hostname; } catch { continue; }
    // Internal/local network: never leaves here to check.
    if (hostInterno(host)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

// Network error codes that prove a real failure: the domain doesn't exist or
// the server refused the connection. Timeout, reset, TLS and egress blocking
// prove nothing about the page.
const REDE_PROVA = new Set(['ENOTFOUND', 'ECONNREFUSED']);
function codigoDeRede(error) {
  const cause = error?.cause;
  const codes = [error?.code, cause?.code, ...(Array.isArray(cause?.errors) ? cause.errors.map(e => e?.code) : [])].filter(Boolean);
  if (codes.includes('ENOTFOUND')) return 'ENOTFOUND';
  // With more than one address (IPv4 and IPv6) all of them need to have
  // refused.
  if (Array.isArray(cause?.errors) && cause.errors.length) return cause.errors.every(e => e?.code === 'ECONNREFUSED') ? 'ECONNREFUSED' : null;
  return codes.includes('ECONNREFUSED') ? 'ECONNREFUSED' : null;
}

// One request, following redirects by hand (up to MAX_REDIRECTS, never to
// an internal host). Returns { status, redirecionou } or { rede: código|null }.
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

// 'ok' | 'falha' | 'indefinido' for a single request. Failure only with
// proof: 404/410/5xx with no redirect in between, or a nonexistent DNS /
// refused connection.
function avaliar(r) {
  if (r.rede !== undefined) return r.rede && REDE_PROVA.has(r.rede) ? 'falha' : 'indefinido';
  if (r.status >= 200 && r.status < 300) return 'ok';
  if (r.redirecionou) return 'indefinido';
  if (r.status === 404 || r.status === 410 || (r.status >= 500 && r.status < 600)) return 'falha';
  return 'indefinido';
}

// 'ok' | 'quebrado' | 'indefinido'. A HEAD resolves most cases; the failure
// is only taken as certain after a GET repeats it, because servers that
// respond wrong to HEAD do exist, a 5xx can be transient, and a false
// "broken link" is worse than not checking at all.
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

// Only exact links from tool messages observed in this turn.
// The authenticated API proves the source; it does not prove a URL opens without login.
// Do not apply this exception to links in the email body or to an entire domain.
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
 * Checks all links in the text (in parallel) and returns the ones that are BROKEN.
 * Does not touch the text: the caller decides what to do with the list.
 * authenticatedSources are sources observed via the API, NOT validated HTTP URLs.
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
 * The URI the native search returns is an OPAQUE redirect from vertexaisearch, that
 * expires and tells the user nothing. Follows the first hop to find the real
 * address. Returns '' when it doesn't resolve (then the source is not shown).
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
 * Numbered list "[1] title — url", with redirects already resolved.
 * With `registro` (the turn's registroDeFontes, citacoes.mjs) the number is the
 * registry's: fixed for the whole turn, it's what the model writes in the response and
 * what the platform swaps for the real source. A source without a resolved address has
 * no number, because it cannot be cited.
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
 * "Sources:" block in the same format as `buscar_web` (renderFontes), from
 * the native search's grounding sources. Resolves the vertexaisearch opaque redirect
 * to the real address and discards what doesn't resolve.
 * @returns {Promise<string>} ready-made block, or '' if nothing is left to show
 */
export async function blocoDeFontes(sources, language) {
  const arr = (sources || []).slice(0, MAX_FONTES);
  if (!arr.length) return '';
  const lista = await renderFontes(arr);
  // renderFontes leaves the line without a URL when the redirect didn't resolve; without
  // an address the "source" is useless here, so it's dropped.
  const linhas = lista.split('\n').filter((l) => /https?:\/\//.test(l));
  if (!linhas.length) return '';
  const rotulo = textosDe(language)?.fontes || 'Fontes:';
  return `${rotulo}\n${linhas.map((l, i) => l.replace(/^\[\d+\]/, `[${i + 1}]`)).join('\n')}`;
}

/**
 * Stitches the two into the turn's final text.
 *  - `sources`: native search grounding (may come empty);
 *  - appends "Sources:" when the search ran and the response doesn't already bring a list;
 *  - honestly warns when some delivered link didn't open.
 * Removes links proven broken, without inventing substitutes.
 * @returns {Promise<{texto:string, quebrados:string[], fontes:number}>}
 */
export async function fontesEConferencia(texto, sources = [], { mostrarFontes = true, language, strictLinks = false, authenticatedEmailSources = [] } = {}) {
  const base = String(texto ?? '');
  // The model responds in the person's language, so the list it already wrote
  // may come as "Sources:" or "Fuentes:". Recognizing all three avoids appending a
  // sources block on top of another that's already there.
  const jaTemLista = /(^|\n)\s*(fontes|sources|fuentes)\s*:/i.test(base);
  const t = textosDe(language);
  const bloco = mostrarFontes && !jaTemLista ? await blocoDeFontes(sources, language).catch(() => '') : '';
  // Also check the appended sources: before, they passed outside the verifier.
  let out = base + (bloco ? `\n\n${bloco}` : '');
  // The strict routine policy still requires public HTTP verification;
  // its authenticated message confirmation is handled by its own curation.
  const { quebrados, indefinidos, naoChecados, authenticatedSources } = await conferirLinks(out, {
    authenticatedEmailSources: strictLinks ? [] : authenticatedEmailSources,
  });
  if (quebrados.length) {
    out = omitBrokenLinks(out, quebrados, language);
    out += `\n\n${t.removidos(quebrados.length)}`;
  }
  // A link the check could not confirm (401/403/429, timeout, TLS, over the cap of
  // 8) stays in the text with no notice, in chat and in routines. In prod (30 days
  // to 06/10/2026) these were almost all live sites refusing a robot, so the
  // notice told people to distrust links that open fine (06/10/2026).
  // Only proven-dead links (404/410/5xx, unknown domain, refused connection) go.
  return { texto: out, quebrados, indefinidos, naoChecados, authenticatedSources, fontes: bloco ? bloco.split('\n').length - 1 : 0 };
}

// Does not invent a substitute URL nor resend the address known to be broken.
// In simple lists it omits the item's line and its continuations; in prose/tables
// it preserves the text and removes only the address. Literal code passes through intact.
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
      // Also removes the markdown wrapper around the address, without leaving a fake link.
      let out = line.replace(/\[([^\]\n]*)\]\(((?:https?:\/\/)?[^\s()]+)\)/g,
        (all, label, url) => bad.has(url) ? `${label} ${linkLabel}` : all);
      return out.replace(RE_URL, raw => {
        const url = limpaFim(raw);
        return bad.has(url) ? linkLabel + raw.slice(url.length) : raw;
      });
    }).join('\n');
  });
}
