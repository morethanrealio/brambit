// ── Caça-typo determinístico para rascunho de app (Tipo 1: nome que não existe) ──
// Buraco medido em 19-20/09/2026: o `applint.mjs` são 3 regras de regex SEM
// análise de escopo, então "chamei calcularTotal(), declarei calcularTotais()"
// passa com "aprovado, 0 erros, 0 avisos" e o modelo declara a tarefa concluída.
//
// Esta peça levanta a mão SÓ quando as duas coisas valem ao mesmo tempo:
//   1. o nome chamado não aparece em lugar nenhum do app a não ser como chamada
//      (ou seja, não é parâmetro, import, destructuring, propriedade, nada), e
//   2. existe no próprio app um nome DECLARADO quase idêntico a ele.
// A segunda condição é o que separa TYPO de biblioteca externa: `dayjs()` ou
// `Chart()` não parecem com nada declarado no app, então nunca viram aviso.
//
// Saída é sempre AVISO, nunca ERRO: portão que informa melhora, portão que
// bloqueia engessa. E o aviso é insumo PRO MODELO, nunca texto pro dono do app.
//
// Viés deliberado para o SILÊNCIO (mesmo espírito do "generoso de propósito" do
// applint): qualquer ocorrência do nome fora de posição de chamada já cala o
// aviso, porque nesse caso o nome existe no vocabulário do app e a chance de ser
// engano de digitação despenca.
//
// Funções puras (files = {caminho: texto}); nada executa código nem toca disco.

import { similaridade } from './app-anchor.mjs';

// Limiar calibrado contra os nomes reais dos apps em produção (ver
// `projetos/app-prova-de-execucao.md`). Na prática 0,85 exige nome de 7+
// caracteres com 1 caractere de diferença, ou de 14+ com 2, que é a assinatura
// do typo. Abaixo disso o nome é curto demais pra distinguir engano de decisão.
export const LIMIAR_TYPO = 0.85;
export const TAMANHO_MINIMO = 6;
export const MAX_AVISOS = 8;

const CODE_EXTS = /\.(js|mjs|cjs|html|htm)$/i;

// Nomes que um app pode chamar sem declarar. Palavra-chave, global de browser,
// global de Node e método de biblioteca/DOM do dia a dia. Lista grande de
// propósito: cada nome aqui é um falso positivo a menos.
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

// Nomes DECLARADOS como função de primeira classe (alvo de chamada global).
const RE_FUNCOES = [
  new RegExp(`\\b(?:async\\s+)?function\\s*\\*?\\s*(${ident})`, 'g'),
  new RegExp(`\\bclass\\s+(${ident})`, 'g'),
  new RegExp(`\\b(?:const|let|var)\\s+(${ident})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\*|\\([^()]*\\)\\s*=>|${ident}\\s*=>)`, 'g'),
  new RegExp(`\\b(?:window|globalThis|self)\\.(${ident})\\s*=`, 'g'),
];

// Nomes DECLARADOS como método/propriedade-função (alvo de chamada com ponto).
const RE_METODOS = [
  new RegExp(`(${ident})\\s*:\\s*(?:async\\s+)?function\\b`, 'g'),
  new RegExp(`(${ident})\\s*:\\s*(?:async\\s*)?(?:\\([^()]*\\)|${ident})\\s*=>`, 'g'),
  new RegExp(`(?:^|[{,;])[ \\t]*(?:static\\s+)?(?:async\\s+)?\\*?\\s*(${ident})\\s*\\([^()]*\\)\\s*\\{`, 'gm'),
  new RegExp(`\\.(${ident})\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^()]*\\)\\s*=>|${ident}\\s*=>)`, 'g'),
  new RegExp(`\\b(?:this|exports|module\\.exports)\\.(${ident})\\s*=`, 'g'),
  new RegExp(`\\bprototype\\.(${ident})\\s*=`, 'g'),
];

// Toda ocorrência de identificador, com o caractere anterior e se é chamada.
const RE_OCORRENCIA = new RegExp(`(.?)\\b(${ident})\\b\\s*(\\(?)`, 'g');

// Tira comentário sem quebrar URL dentro de string (o `//` de `https://` vem
// depois de `:` e por isso é preservado).
function semComentarios(txt) {
  return txt.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\w'"`\\/])\/\/[^\n]*/g, '$1');
}

function coletar(regexes, txt, destino) {
  for (const re of regexes) {
    re.lastIndex = 0;
    let m;
    // Palavra-chave nunca entra: `if (x) {` casa com a forma de método curto.
    while ((m = re.exec(txt)) !== null) if (!CONHECIDOS.has(m[1])) destino.add(m[1]);
  }
}

/**
 * Procura nome chamado que não existe no app e é quase idêntico a um declarado.
 * files = {caminho: texto}. Devolve lista de avisos (nunca erros).
 */
export function huntTypos(files, opcoes = {}) {
  const limiar = opcoes.limiar ?? LIMIAR_TYPO;
  const minimo = opcoes.tamanhoMinimo ?? TAMANHO_MINIMO;
  const maxAvisos = opcoes.maxAvisos ?? MAX_AVISOS;

  const funcoes = new Set();   // declaradas, alvo de chamada global
  const metodos = new Set();   // declaradas, alvo de chamada com ponto
  const vocabulario = new Set(); // QUALQUER ocorrência fora de posição de chamada
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
    // Chamada com ponto compara com métodos E com funções: app real exporta função
    // de topo num objeto (`const Chat = { criarChat }` → `Chat.criarChat()`), e sem
    // a união o caçador calava em 17 dos 22 typos plantados que ele deixou passar.
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
