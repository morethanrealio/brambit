// ── Deterministic typo hunt for app draft (Type 1: name that does not exist) ──
// Gap measured on 2026-09-19/20: `applint.mjs` is 3 regex rules with NO scope
// analysis, so "called calcularTotal(), declared calcularTotais()" passes with
// "aprovado, 0 erros, 0 avisos" and the model declares the task done.
//
// This piece only raises a flag when both of these hold at the same time:
//   1. the called name does not appear anywhere in the app except as a call
//      (i.e. it's not a parameter, import, destructuring, property, nothing), and
//   2. the app itself has a DECLARED name almost identical to it.
// The second condition is what separates a TYPO from an external library:
// `dayjs()` or `Chart()` don't look like anything declared in the app, so they
// never become a warning.
//
// Output is always a WARNING, never an ERROR: a gate that informs improves, a
// gate that blocks stiffens. And the warning is input FOR THE MODEL, never text
// for the app's owner.
//
// Deliberate bias towards SILENCE (same spirit as applint's "generous on
// purpose"): any occurrence of the name outside call position already
// silences the warning, because in that case the name exists in the app's
// vocabulary and the chance of it being a typo drops sharply.
//
// Pure functions (files = {caminho: texto}); nothing executes code or touches disk.

import { similaridade } from './app-anchor.mjs';

// Threshold calibrated against the real app names in production (see
// `projetos/app-prova-de-execucao.md`). In practice 0,85 requires a name of
// 7+ characters with 1 character of difference, or of 14+ with 2, which is
// the typo's signature. Below that the name is too short to tell a mistake
// from a deliberate choice.
export const LIMIAR_TYPO = 0.85;
export const TAMANHO_MINIMO = 6;
export const MAX_AVISOS = 8;

const CODE_EXTS = /\.(js|mjs|cjs|html|htm)$/i;

// Names an app can call without declaring. Keyword, browser global, Node
// global, and everyday library/DOM method. Deliberately large list: every
// name here is one less false positive.
const CONHECIDOS = new Set(`
if else for while do switch case return function class new typeof void delete in of
instanceof try catch finally throw await async yield this super import export default
const let var break continue with debugger
alert confirm prompt open close print focus blur scroll scrollTo scrollBy scrollIntoView
requestAnimationFrame cancelAnimationFrame setTimeout setInterval clearTimeout clearInterval
queueMicrotask structuredClone fetch XMLHttpRequest WebSocket EventSource Notification
encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape btoa atob
parseInt parseFloat isNaN isFinite Symbol BigInt Proxy Reflect Intl
String Number Boolean Array Object Date JSON Math Promise RegExp Error TypeError RangeError
Map Set WeakMap WeakSet URL URLSearchParams FormData Blob File FileReader Headers Request Response
AbortController Image Audio Worker Event CustomEvent MutationObserver IntersectionObserver
window document history location navigator console localStorage sessionStorage screen
require module exports process Buffer global globalThis __dirname __filename setImmediate
clearImmediate TextEncoder TextDecoder URLPattern crypto performance
getElementById getElementsByClassName getElementsByTagName getElementsByName querySelector
querySelectorAll createElement createTextNode createElementNS appendChild removeChild
replaceChild insertBefore insertAdjacentHTML cloneNode contains closest matches
addEventListener removeEventListener dispatchEvent preventDefault stopPropagation
setAttribute getAttribute removeAttribute hasAttribute toggleAttribute getBoundingClientRect
classList toggle remove replace append prepend before after
forEach filter map reduce reduceRight some every find findIndex findLast findLastIndex
includes indexOf lastIndexOf slice splice concat join reverse sort flat flatMap
push pop shift unshift fill copyWithin entries keys values from isArray of
charAt charCodeAt codePointAt startsWith endsWith padStart padEnd repeat trim trimStart
trimEnd toLowerCase toUpperCase toLocaleLowerCase toLocaleUpperCase split match matchAll
search normalize localeCompare substring substr
toFixed toPrecision toExponential toString valueOf toJSON hasOwnProperty isPrototypeOf
propertyIsEnumerable stringify parse assign freeze seal create defineProperty getPrototypeOf
fromEntries getOwnPropertyNames
then catch finally all allSettled race any resolve reject
getTime getFullYear getMonth getDate getDay getHours getMinutes getSeconds getMilliseconds
setFullYear setMonth setDate setHours setMinutes setSeconds toISOString toLocaleDateString
toLocaleTimeString toLocaleString getTimezoneOffset now
floor ceil round abs min max pow sqrt random trunc sign log exp
test exec source flags lastIndex
listen use get post put patch delete head all route static json urlencoded send status
end write writeHead sendFile redirect render set header cookie clearCookie next
query params body headers
prepare run exec each pluck bind transaction serialize close open readFile writeFile
readFileSync writeFileSync existsSync mkdirSync readdirSync unlinkSync statSync appendFile
join resolve dirname basename extname relative normalize isAbsolute sep
emit on once off removeAllListeners pipe destroy
log warn info debug table group groupEnd time timeEnd trace assert count dir
`.trim().split(/\s+/));

const ident = '[A-Za-z_$][\\w$]*';

// Names DECLARED as a first-class function (target of a global call).
const RE_FUNCOES = [
  new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s*(${ident})`, 'g'),
  new RegExp(`\\bclass\\s+(${ident})`, 'g'),
  new RegExp(`\\b(?:const|let|var)\\s+(${ident})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\*|\\([^()]*\\)\\s*=>|${ident}\\s*=>)`, 'g'),
  new RegExp(`\\b(?:window|globalThis|self)\\.(${ident})\\s*=`, 'g'),
];

// Names DECLARED as a method/function-property (target of a dotted call).
const RE_METODOS = [
  new RegExp(`(${ident})\\s*:\\s*(?:async\\s+)?function\\b`, 'g'),
  new RegExp(`(${ident})\\s*:\\s*(?:async\\s*)?(?:\\([^()]*\\)|${ident})\\s*=>`, 'g'),
  new RegExp(`(?:^|[{,;])[ \\t]*(?:static\\s+)?(?:async\\s+)?\\*?\\s*(${ident})\\s*\\([^()]*\\)\\s*\\{`, 'gm'),
  new RegExp(`\\.(${ident})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^()]*\\)\\s*=>|${ident}\\s*=>)`, 'g'),
  new RegExp(`\\b(?:this|exports|module\\.exports)\\.(${ident})\\s*=`, 'g'),
  new RegExp(`\\bprototype\\.(${ident})\\s*=`, 'g'),
];

// Every identifier occurrence, with the previous character and whether it's a call.
const RE_OCORRENCIA = new RegExp(`(.?)\\b(${ident})\\b\\s*(\\(?)`, 'g');

// Strips comments without breaking a URL inside a string (the `//` of
// `https://` comes after `:` and is therefore preserved).
function semComentarios(txt) {
  return txt.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\w'"`\\/])\/\/[^\n]*/g, '$1');
}

function coletar(regexes, txt, destino) {
  for (const re of regexes) {
    re.lastIndex = 0;
    let m;
    // A keyword never counts: `if (x) {` matches the short-method shape.
    while ((m = re.exec(txt)) !== null) if (!CONHECIDOS.has(m[1])) destino.add(m[1]);
  }
}

/**
 * Looks for a called name that does not exist in the app and is almost
 * identical to a declared one. files = {caminho: texto}. Returns a list of
 * warnings (never errors).
 */
export function huntTypos(files, opcoes = {}) {
  const limiar = opcoes.limiar ?? LIMIAR_TYPO;
  const minimo = opcoes.tamanhoMinimo ?? TAMANHO_MINIMO;
  const maxAvisos = opcoes.maxAvisos ?? MAX_AVISOS;

  const funcoes = new Set();   // declaradas, alvo de chamada global
  const metodos = new Set();   // declaradas, alvo de chamada com ponto
  const vocabulario = new Set(); // ANY occurrence outside call position
  const usos = new Map();      // nome -> { arquivo, ponto }

  const limpos = {};
  for (const [rel, txt] of Object.entries(files)) {
    if (!CODE_EXTS.test(rel) || typeof txt !== 'string') continue;
    limpos[rel] = semComentarios(txt);
  }

  for (const txt of Object.values(limpos)) {
    coletar(RE_FUNCOES, txt, funcoes);
    coletar(RE_METODOS, txt, metodos);
  }

  for (const [rel, txt] of Object.entries(limpos)) {
    RE_OCORRENCIA.lastIndex = 0;
    let m;
    while ((m = RE_OCORRENCIA.exec(txt)) !== null) {
      const antes = m[1], nome = m[2], chamada = m[3] === '(';
      // O regex consome o caractere anterior; recuar deixa `a.b(` ser visto.
      RE_OCORRENCIA.lastIndex = m.index + (antes ? 1 : 0) + nome.length;
      if (!chamada) { vocabulario.add(nome); continue; }
      if (usos.has(nome)) continue;
      usos.set(nome, { arquivo: rel, ponto: antes === '.' });
    }
  }

  const avisos = [];
  for (const [nome, { arquivo, ponto }] of usos) {
    if (avisos.length >= maxAvisos) break;
    if (nome.length < minimo) continue;
    if (CONHECIDOS.has(nome) || vocabulario.has(nome)) continue;
    if (funcoes.has(nome) || metodos.has(nome)) continue;
    // A dotted call compares against both methods AND functions: a real app
    // exports a top-level function in an object (`const Chat = { criarChat }`
    // → `Chat.criarChat()`), and without that union the hunter stayed silent
    // on 17 of the 22 planted typos it let through.
    const pool = ponto ? new Set([...metodos, ...funcoes]) : funcoes;
    let melhor = null, melhorSim = 0;
    for (const cand of pool) {
      if (cand === nome) continue;
      if (Math.abs(cand.length - nome.length) > 2) continue;
      const s = similaridade(nome, cand);
      if (s > melhorSim) { melhorSim = s; melhor = cand; }
    }
    if (melhor && melhorSim >= limiar) avisos.push({ tipo: 'nome_parecido', funcao: nome, sugestao: melhor, arquivo });
  }
  return avisos;
}
