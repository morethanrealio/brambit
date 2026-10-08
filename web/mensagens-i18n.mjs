// Translation of SERVER MESSAGES (the `error`/`message` field of JSON
// responses), sibling of site-i18n.mjs, which handles the HTML.
//
// Why a module separate from the site: the origin is different. HTML is data, and the
// walker knows what's text because it knows the tag grammar. Here the origin is
// CODE, and what decides whether a literal goes to the user's screen isn't its
// content, it's the point of emission. `'locked'`, `'bad_request'` and "Faça login." are
// in the same file, come out through the same function, and only one of the three is a sentence.
//
// The guarantee is the same as the site's and for the same reason: in pt-BR nothing is walked and
// the response comes out byte-for-byte the same as today. A key with no translation stays in
// Portuguese, on purpose: a missing message is a sentence in the wrong language, and
// an invented message is a wrong sentence.
import { IDIOMAS_OK, IDIOMA_PADRAO, tagIdioma } from './locale.mjs';
import { fatiaJs } from './site-i18n.mjs';
import { hostDaMarca, marca } from './marca.mjs';

// The emission points that reach the CLIENT. `fail()` and `send()` are the server's
// two JSON exit ports; whatever passes through them the person reads.
//
// `return { error: ... }` is left OUT on purpose, and that's the distinction that
// matters in this file: that's a tool return, it goes to the model, not to the screen.
// The model already responds in the language of whoever asked, so translating there
// wouldn't help anyone and would touch the text that guides its decision.
const EMISSORES = [
  /\bfail\s*\(\s*res\s*,\s*\d+\s*,\s*$/,
  /\bsend\s*\(\s*res\s*,\s*\d+\s*,\s*\{\s*error\s*:\s*$/,
  /\bsend\s*\(\s*res\s*,\s*\d+\s*,\s*\{[^{}]*\bmessage\s*:\s*$/,
  // The fallback literal after `||` (`e?.message || 'URL inválida.'`) also
  // reaches the screen when the expression on the left comes out empty.
  /\bfail\s*\(\s*res\s*,\s*\d+\s*,[^,{}()'"`]*\|\|\s*$/,
  /\bsend\s*\(\s*res\s*,\s*\d+\s*,\s*\{\s*error\s*:[^,{}()'"`]*\|\|\s*$/,
  // Text that a port returns for the server to answer with (`{ mensagem: '...' }`,
  // e.g.: entrarNaFila from the permissions port) becomes `message` in the response.
  /\{\s*mensagem\s*:\s*$/,
];

// Machine code, not a sentence: lowercase, digits, `_` and `-`, no space, no
// accent, no punctuation (`locked`, `no_agent`, `bad_request`, `apple-em-uso`).
// The exclusion is by SHAPE, not by a list: a new list would miss the next code.
// Translating one of these wouldn't make the screen ugly, it would leave the client comparing
// against a value that changed language.
const CODIGO_DE_MAQUINA = /^[a-z][a-z0-9_-]*$/;

// Core files (inside web/) whose responses pass through the server's send/fail
// and therefore through the web/textos-servidor catalog. A new core module
// that answers via this send belongs here; a plugin's goes in its own fontesMensagens,
// with the catalog in textosServidor (plugins.mjs).
export const FONTES_MENSAGENS = ['server.mjs'];

// User messages emitted as a literal in the code. Returns the unique
// strings, in the order they appear.
//
// Templates are left out (backticks with `${}`): their text only exists assembled, at
// runtime, so there's no stable key to store in a catalog. There are
// few of them and they stay in Portuguese; `mensagens-i18n-pendentes.mjs` lists them.
export function extraiMensagens(js) {
  const fora = [];
  const vistos = new Set();
  for (const p of fatiaJs(js)) {
    if (p.tipo !== 'string') continue;
    const antes = js.slice(Math.max(0, p.ini - 90), p.ini);
    if (!EMISSORES.some((re) => re.test(antes))) continue;
    const texto = js.slice(p.ini + 1, p.fim - 1);
    // A literal with an escape (`\'`, `\n`) doesn't become a key: the key would have to be the
    // ALREADY unescaped value to match at runtime, and the substitution
    // would have to re-escape it. Neither side is worth the risk for a handful of
    // sentences; they stay in Portuguese and pendentes shows them.
    if (texto.includes('\\')) continue;
    if (!texto.trim() || CODIGO_DE_MAQUINA.test(texto)) continue;
    if (vistos.has(texto)) continue;
    vistos.add(texto);
    fora.push(texto);
  }
  return fora;
}

// Single point called by the server, one text at a time. In pt-BR it returns the SAME
// string without consulting anything, which is what guarantees that today's response doesn't change
// a byte. Outside the catalog, it also returns the same string.
export function traduzMensagem(texto, language, catalogos) {
  if (typeof texto !== 'string' || !texto) return texto;
  const tag = tagIdioma(language);
  if (tag === IDIOMA_PADRAO) return texto;
  const t = catalogos?.[tag]?.[texto];
  return typeof t === 'string' && t ? t : texto;
}

// The product name enters the message as __MARCA__ and the support email as
// __SUPORTE__ (in the code and on both ends of the catalog), so the key stays
// a fixed literal, and they become the brand's only here, after translation and in
// any language. An installation with no support email in the brand config answers with
// ADMIN_EMAIL and, without that, with the site's address.
const MARCA = /__MARCA__|__SUPORTE__/g;
const daMarca = (k) => (k === '__MARCA__' ? marca().nome : marca().suporte || process.env.ADMIN_EMAIL || hostDaMarca());
const comMarca = (t) => (t.includes('__') ? t.replace(MARCA, daMarca) : t);

// Translates only the two fields the person reads on screen, `error` and `message`, and doesn't
// touch the rest of the object: `ok`, `queued`, id, balance and any other data stay
// as they are.
//
// In pt-BR and for any text outside the catalog (and without __MARCA__ or __SUPORTE__)
// it returns the SAME object, by the same reference, so the response stays byte for
// byte the same as today.
// A copy is only created when some field actually changed.
export function traduzResposta(obj, language, catalogos) {
  if (!obj || typeof obj !== 'object') return obj;
  const pt = tagIdioma(language) === IDIOMA_PADRAO;
  let saida = obj;
  for (const campo of ['error', 'message']) {
    const v = obj[campo];
    if (typeof v !== 'string') continue;
    const t = comMarca(pt ? v : traduzMensagem(v, language, catalogos));
    if (t === v) continue;
    if (saida === obj) saida = { ...obj };
    saida[campo] = t;
  }
  return saida;
}

// Language of a request, resolved WITHOUT hitting the database.
//
// The order exists for a reason: the SPA sends `X-Idioma` with the language it
// itself was served in, and that page already went out in the person's SAVED preference
// (the server resolved that in `idiomaDaPagina`). So the client's header isn't a
// guess, it's the echo of the preference, and it still guarantees what the user expects:
// the error message arrives in the same language as the screen that triggered it.
//
// A client that doesn't send the header (extension, app, curl) falls back to the
// agent's own Accept-Language, and whoever doesn't send that either falls back to Portuguese.
export function idiomaDaRequisicao(req, doHeader) {
  const pedido = String(req.headers?.['x-idioma'] || '').trim();
  if (IDIOMAS_OK.includes(pedido)) return pedido;
  try { return doHeader(req).language || IDIOMA_PADRAO; } catch { return IDIOMA_PADRAO; }
}
