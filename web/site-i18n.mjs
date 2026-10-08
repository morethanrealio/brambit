// i18n of the public pages: translation at RESPONSE time, without touching the HTML.
//
// Why not `data-i18n` on every element (the original plan): marking ~740
// strings by hand means editing every page that is currently correct and live,
// and every forgotten mark becomes a chunk in Portuguese in the middle of the
// translated page, with no error showing up at all. Here the HTML stays INTACT and the catalog is
// a separate file; whatever is missing translation stays in Portuguese, which is the
// honest fallback.
//
// The property that holds everything up: in pt-BR `traduzPagina` returns the SAME
// string, by early return, and with an empty catalog the walk returns the file
// BYTE FOR BYTE. In other words, today's 99 users have no way to regress because of
// this, and that is proven in a test against the real pages, not just asserted.
//
// DECLARED LIMIT: this translates what is IN THE FILE. Text that the page's
// JavaScript assembles from data coming from the API (plan name, server error
// message) does not go through here; whoever translates that is the backend.

import fs from 'node:fs';
import path from 'node:path';
import { tagIdioma, IDIOMA_PADRAO, IDIOMAS_OK } from './locale.mjs';

// Attributes whose value the user READS. `value` is left out on purpose: in
// <input type=hidden> and <option value=...> it is data, not text, and translating
// would break the form. A button with text in `value` doesn't exist on these
// pages (verified by grep before deciding).
const ATRIBUTOS_DE_TEXTO = new Set(['placeholder', 'title', 'alt', 'aria-label', 'aria-placeholder']);

// <meta content="..."> is only text for some names; for others it is machine
// (viewport, charset, theme-color) data and translating it would be damage.
const META_DE_TEXTO = new Set(['description', 'og:description', 'og:title', 'og:site_name', 'twitter:title', 'twitter:description', 'apple-mobile-web-app-title']);

// Has a letter? Serves to discard a candidate that is just a number, punctuation or emoji
// ("→", "•", "1", "R$"), which has nothing to translate and would only clutter the catalog.
const TEM_LETRA = /\p{L}{2}/u;

function ehTraduzivel(s) {
  // `${...}` in the middle: it's text ASSEMBLED at runtime. Translating the whole
  // template would require reordering the pieces and resolving plurals, and what comes
  // out of the hole still comes from the backend in Portuguese. Left out, declared.
  return TEM_LETRA.test(s) && !s.includes('${');
}

// Inside <script> most strings are NOT user text: they are a selector
// ('.aviso'), a route ('/api/creditos'), a key ('content-type'), a DOM constant
// ('Enter'). Translating any of these doesn't leave the page ugly, it leaves it
// BROKEN, and silently. So here the rule is the opposite of the HTML's: only
// what looks like a sentence goes through.
//
// Passes if it has a space (sentence) or an accent (proof that it's Portuguese written
// for people to read). A loose ASCII word is left out even if it's real
// text: a 'Salvar' that stays in Portuguese is lost, and in exchange there's no
// risk of translating the 'Enter' in `e.key === 'Enter'`. A Portuguese fallback is a
// visible defect; a key that stopped working is not.
function ehFraseDeScript(s) {
  if (ehCss(s)) return false;
  return /\s/.test(s) || /[^\x00-\x7F]/.test(s);
}

// CSS put in an element's `style` ('font-size:12px;margin:2px 0 4px;') has
// a space and would therefore pass as a sentence. It's code: translated, it breaks the layout.
// Recognized by the format, every piece separated by ';' being a
// `property: value` with a CSS property name (lowercase with hyphen).
function ehCss(s) {
  // Selector ('#routines .rcard', '.tabs .tab'): has a space, so it would pass as a
  // sentence. No Portuguese sentence starts with # or a dot.
  if (/^[#.[]/.test(s)) return true;
  const partes = s.split(';').map((p) => p.trim()).filter(Boolean);
  return partes.length > 0 && partes.every((p) => /^[a-z-]+\s*:\s*\S/.test(p));
}

// Second filter for the script: looks at what comes BEFORE the literal. There is a string that
// looks like screen text on all sides ('app-open lib', '1 1 auto',
// 'BEGIN PRIVATE KEY') and is a machine value; what gives it away is not the content, it's
// who is receiving it. Translating one of these doesn't leave the screen ugly, it leaves it
// BROKEN silently, which is the defect this whole file exists to
// avoid.
//
// Each line below came from a REAL occurrence measured in index.html, not from
// generic caution: a class name assembled in `className =`, a measurement in
// `style.flex`/`style.padding`, and the `p8.includes('BEGIN PRIVATE KEY')` that
// detects a private key pasted by the user.
const CONTEXTO_DE_MAQUINA = new RegExp(`(?:${[
  '(?:===?|!==?|\\bcase)',                                     // direct comparison
  '\\.(?:includes|indexOf|lastIndexOf|startsWith|endsWith|split)\\s*\\(',
  '\\.(?:className|cssText)\\s*\\+?=',                         // classe / style inteiro
  '\\.style\\.[A-Za-z]+\\s*=',                                 // style.flex, style.padding
  'classList\\.(?:add|remove|toggle|contains|replace)\\s*\\(',
  '(?:querySelector|querySelectorAll|closest|matches|getElementById)\\s*\\(',
  '(?:get|set|has|remove)Attribute\\s*\\(',                    // 1st arg is the attribute NAME
  'setAttribute\\s*\\(\\s*[\'"]class[\'"]\\s*,',               // and the 2nd arg of class too
  '(?:localStorage|sessionStorage)\\.\\w+\\s*\\(',
].join('|')})\\s*$`);

// ── Walk ───────────────────────────────────────────────────────────────
// A single pass serves both to EXTRACT (build the catalog) and to APPLY
// (translate). It's on purpose: if they were two different passes, the
// extracted key might not be the key being looked up, and the symptom would be a page in
// Portuguese with no error at all. Here, if it was extracted, it's found.
//
// `troca(texto, tipo)` returns the replacement or null to leave it as is.
function caminha(html, troca) {
  let out = '';
  let i = 0;
  const n = html.length;

  const emite = (bruto, tipo) => {
    // Preserves the surrounding space: the trim is only to match the key, the HTML comes back
    // with the same indentation as before.
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(bruto);
    const [, antes, miolo, depois] = m;
    if (!miolo || !ehTraduzivel(miolo)) return bruto;
    const novo = troca(miolo, tipo);
    return novo == null ? bruto : antes + novo + depois;
  };

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += emite(html.slice(i), 'texto'); break; }
    out += emite(html.slice(i, lt), 'texto');

    // Comment: copied raw. A code comment is not user text.
    if (html.startsWith('<!--', lt)) {
      const fim = html.indexOf('-->', lt + 4);
      const ate = fim < 0 ? n : fim + 3;
      out += html.slice(lt, ate);
      i = ate;
      continue;
    }

    // End of the opening tag, ignoring a '>' that is INSIDE an attribute
    // value (happens in onclick and in SVG).
    let j = lt + 1, aspas = null;
    while (j < n) {
      const c = html[j];
      if (aspas) { if (c === aspas) aspas = null; }
      else if (c === '"' || c === "'") aspas = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= n) { out += html.slice(lt); break; }

    const tag = html.slice(lt, j + 1);
    out += traduzTag(tag, troca);
    i = j + 1;

    // <script> and <style>: the content is NOT HTML, so the walk cannot
    // enter it. It goes whole into the JS literal handling (script) or is
    // copied raw (style).
    const nome = /^<\s*([a-zA-Z][\w:-]*)/.exec(tag)?.[1]?.toLowerCase();
    if ((nome === 'script' || nome === 'style') && !/\/\s*>$/.test(tag)) {
      const fecha = new RegExp(`</\\s*${nome}\\s*>`, 'i');
      const resto = html.slice(i);
      const m = fecha.exec(resto);
      const corpo = m ? resto.slice(0, m.index) : resto;
      out += nome === 'script' ? traduzScript(corpo, troca) : corpo;
      i += corpo.length;
    }
  }
  return out;
}

// Text attributes inside an opening tag.
function traduzTag(tag, troca) {
  const ehMeta = /^<\s*meta\b/i.test(tag);
  let metaNome = null;
  if (ehMeta) {
    const m = /\b(?:name|property)\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    metaNome = (m?.[2] ?? m?.[3] ?? '').toLowerCase();
  }
  return tag.replace(/([a-zA-Z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g, (todo, nome, _q, dupla, simples) => {
    const attr = nome.toLowerCase();
    const valor = dupla !== undefined ? dupla : simples;
    const aspa = dupla !== undefined ? '"' : "'";
    const alvo = ATRIBUTOS_DE_TEXTO.has(attr) || (ehMeta && attr === 'content' && META_DE_TEXTO.has(metaNome));
    if (!alvo || !valor || !ehTraduzivel(valor)) return todo;
    const novo = troca(valor.trim(), 'atributo');
    // Quotes in the middle of the value would break the attribute. Not a remote hypothesis: in
    // Spanish «"sí"» shows up. When in doubt, keep the Portuguese.
    if (novo == null || novo.includes(aspa)) return todo;
    return `${nome}=${aspa}${novo}${aspa}`;
  });
}

// ── JavaScript lexer ─────────────────────────────────────────────────────
// Finding a string with regex does NOT work, and the way it fails is treacherous.
// On these pages `/[.,;:!?)\]}"]$/` exists: the quote inside the regex literal
// opens a fake "string" that swallows code up to the next quote, and the extractor
// spits out pieces of function as if they were a sentence. This is exactly what happened
// in the first version (measured, not assumed). Hence the lexer: it needs to know
// comment, regex and template to know what is NOT a string.
const PALAVRAS_ANTES_DE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'instanceof', 'throw']);

// Slices the code into labeled pieces, covering the whole text with no gap nor
// overlap (the test confirms that reassembling the pieces returns the input).
export function fatiaJs(js) {
  const out = [];
  const n = js.length;
  let i = 0;
  let anterior = '';        // last meaningful character
  let palavra = '';         // last identifier, for `return /re/`
  // Nested context: {tipo:'tpl'} inside a template, {tipo:'expr'} inside the
  // ${} of a template. Needs a real stack because a template inside the
  // ${} of another template happens on these pages.
  const pilha = [];
  const topo = () => pilha[pilha.length - 1];

  const podeSerRegex = () => {
    if (!anterior) return true;
    if (/[A-Za-z0-9_$]/.test(anterior)) return PALAVRAS_ANTES_DE_REGEX.has(palavra);
    // after ) or ] comes division (`(a+b)/2`); after operator, comma,
    // open brace, etc. comes regex.
    return anterior !== ')' && anterior !== ']';
  };

  const fimDeString = (ini, aspa) => {
    let j = ini + 1;
    while (j < n) {
      const c = js[j];
      if (c === '\\') { j += 2; continue; }
      if (c === aspa) return j + 1;
      if (c === '\n') return -1;   // string doesn't close on another line: it was something else
      j++;
    }
    return -1;
  };

  while (i < n) {
    const c = js[i];

    // Inside a template the content is TEXT, not code: only ` and ${ have
    // meaning. It has to come before everything else, otherwise a quote or a slash in the
    // middle of the text becomes a string/regex and the pieces overlap.
    if (topo()?.tipo === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') {
        const ctx = pilha.pop();
        if (!pilha.length) out.push({ tipo: 'template', ini: ctx.ini, fim: i + 1, aspa: '`' });
        anterior = '`'; palavra = '';
        i++;
        continue;
      }
      if (c === '$' && js[i + 1] === '{') { pilha.push({ tipo: 'expr', chaves: 0 }); i += 2; continue; }
      i++;
      continue;
    }

    if (c === '/' && js[i + 1] === '/') {
      const j = js.indexOf('\n', i);
      if (!pilha.length) out.push({ tipo: 'comentario', ini: i, fim: j < 0 ? n : j });
      i = j < 0 ? n : j;
      continue;
    }
    if (c === '/' && js[i + 1] === '*') {
      const j = js.indexOf('*/', i + 2);
      if (!pilha.length) out.push({ tipo: 'comentario', ini: i, fim: j < 0 ? n : j + 2 });
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === '/' && podeSerRegex()) {
      let j = i + 1, classe = false, ok = false;
      while (j < n) {
        const d = js[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (classe) { if (d === ']') classe = false; }
        else if (d === '[') classe = true;
        else if (d === '/') { ok = true; j++; break; }
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/.test(js[j])) j++;   // flags
        if (!pilha.length) out.push({ tipo: 'regex', ini: i, fim: j });
        anterior = '/'; palavra = '';
        i = j;
        continue;
      }
      // didn't close: it really was division, keeps going as code
    }
    if (c === '"' || c === "'") {
      const fim = fimDeString(i, c);
      if (fim > 0) {
        if (!pilha.length) out.push({ tipo: 'string', ini: i, fim, aspa: c });
        anterior = c; palavra = '';
        i = fim;
        continue;
      }
      // stray quote (inside a badly detected regex, for example): treat as code
    }
    if (c === '`') {
      pilha.push({ tipo: 'tpl', ini: i });
      anterior = '`'; palavra = '';
      i++;
      continue;
    }
    // Closing of ${}: the brace that matches the opening returns to the template.
    if (topo()?.tipo === 'expr') {
      if (c === '{') topo().chaves++;
      else if (c === '}') {
        if (topo().chaves === 0) { pilha.pop(); i++; continue; }
        topo().chaves--;
      }
    }
    if (!/\s/.test(c)) {
      anterior = c;
      palavra = /[A-Za-z0-9_$]/.test(c) ? palavra + c : '';
    }
    i++;
  }
  // Template that doesn't close (truncated script): emits what's left so coverage
  // stays complete instead of disappearing along with the rest of the file.
  const aberto = pilha.find((c) => c.tipo === 'tpl');
  if (aberto) out.push({ tipo: 'template', ini: aberto.ini, fim: n, aspa: '`' });
  return out;
}

// Has an HTML tag inside? Then the string is a piece of page assembled in JS, and whoever
// knows how to find text in it is the HTML walk itself, recursively. This way
// 'Baixe o <b>__MARCA__ Runner.exe</b> (botão acima)' is translated piece by
// piece of text, with the tags intact, instead of becoming one giant catalog key.
const TEM_TAG = /<[a-zA-Z][^>]*>/;

// List of loose, neighboring words, with at least one accented: it's the shape
// of `['domingo','segunda','terça',...]`. Without this the sentence filter only catches
// 'terça' and 'sábado' (the accented ones) and the English screen shows "domingo,
// segunda, Tuesday" — worse than everything in Portuguese, because it looks like a defect and
// not a lack of translation. So either the whole group goes in, or none does.
//
// Requires ALL the loose words so as not to confuse it with a function argument, and
// at least one accented one as proof that the list is Portuguese written to
// be read. A list with no accent at all ('jan','fev','mar') is left out entirely, which is
// consistent.
const UMA_PALAVRA = /^\p{L}[\p{L}\p{M}]*$/u;

function irmaosDeLista(js, pedacos) {
  const ok = new Set();
  let grupo = [];
  const fecha = () => {
    const corpos = grupo.map((p) => js.slice(p.ini + 1, p.fim - 1));
    if (grupo.length >= 3 && corpos.every((c) => UMA_PALAVRA.test(c)) && corpos.some((c) => /[^\x00-\x7F]/.test(c))) {
      for (const p of grupo) ok.add(p.ini);
    }
    grupo = [];
  };
  for (const p of pedacos) {
    if (p.tipo !== 'string') { fecha(); continue; }
    if (grupo.length && /^\s*,\s*$/.test(js.slice(grupo[grupo.length - 1].fim, p.ini))) grupo.push(p);
    else { fecha(); grupo = [p]; }
  }
  fecha();
  return ok;
}

// String literals inside <script>.
function traduzScript(js, troca) {
  const pedacos = fatiaJs(js);
  const daLista = irmaosDeLista(js, pedacos);
  let out = '';
  let cursor = 0;
  for (const p of pedacos) {
    out += js.slice(cursor, p.ini);
    cursor = p.fim;
    const bruto = js.slice(p.ini, p.fim);
    if (p.tipo !== 'string' && p.tipo !== 'template') { out += bruto; continue; }
    const aspa = p.aspa;
    const corpo = js.slice(p.ini + 1, p.fim - 1);

    if (TEM_TAG.test(corpo)) {
      // Recursion: only the texts inside the fragment are swapped. Any
      // swap that brings a closing quote or backslash is rejected down
      // below, so the literal stays valid.
      const novo = caminha(corpo, (t, tipo) => {
        const r = troca(t, tipo);
        return r == null || r.includes(aspa) || r.includes('\\') || r.includes('`') ? null : r;
      });
      out += aspa + novo + aspa;
      continue;
    }
    if (!corpo || !ehTraduzivel(corpo)) { out += bruto; continue; }
    if (!daLista.has(p.ini) && !ehFraseDeScript(corpo.trim())) { out += bruto; continue; }
    // 40 characters because the longest trigger ('setAttribute("class", ') doesn't
    // fit in less; a shorter window would let exactly the dangerous case through.
    if (CONTEXTO_DE_MAQUINA.test(js.slice(Math.max(0, p.ini - 40), p.ini))) { out += bruto; continue; }
    const novo = troca(corpo.trim(), 'script');
    // The string comes back with the SAME quote, so the translation can't contain the quote
    // nor a stray backslash. A single quote in Spanish/English is common
    // ("don't", "qué'"), and escaping here would be easy to get wrong: better to reject.
    if (novo == null || novo.includes(aspa) || novo.includes('\\')) { out += bruto; continue; }
    // preserves the surrounding space the trim removed
    const m = /^(\s*)[\s\S]*?(\s*)$/.exec(corpo);
    out += aspa + m[1] + novo + m[2] + aspa;
  }
  return out + js.slice(cursor);
}

// ── API ─────────────────────────────────────────────────────────────────────

// All the texts the walk considers translatable, in the order they
// appear, without repetition. It's the list that feeds the catalog — and, being the
// SAME pass as the translation, it's also the list of what can be translated.
export function extraiTextos(html) {
  const vistos = new Set();
  const fora = [];
  caminha(html, (texto, tipo) => {
    if (!vistos.has(texto)) { vistos.add(texto); fora.push({ texto, tipo }); }
    return null;
  });
  return fora;
}

// Applies a catalog { 'text in Portuguese': 'translation' }. Missing key = stays
// in Portuguese, on purpose.
export function aplicaCatalogo(html, catalogo) {
  if (!catalogo) return html;
  return caminha(html, (texto) => {
    const t = catalogo[texto];
    return typeof t === 'string' && t ? t : null;
  });
}

// Swaps the lang= of the <html> tag, so the screen reader and the browser's
// spell checker stop thinking the page is Portuguese.
function trocaLangDoHtml(html, tag) {
  return html.replace(/<html\b[^>]*>/i, (m) => (
    /\blang\s*=\s*["'][^"']*["']/i.test(m)
      ? m.replace(/\blang\s*=\s*["'][^"']*["']/i, `lang="${tag}"`)
      : m.replace(/^<html\b/i, `<html lang="${tag}"`)
  ));
}

// Reads the catalogs from disk, one JSON per language. A missing or broken file does NOT
// bring down the process: without a catalog the whole site comes out in Portuguese, which is the
// same behavior as before this change existed. A site in Portuguese is a
// site; a site that doesn't come up is not.
export function carregaCatalogos(dir) {
  const fora = {};
  // Several folders (the core's and the brand's): the later ones complete the earlier ones.
  for (const tag of IDIOMAS_OK) for (const d of [].concat(dir)) {
    if (tag === IDIOMA_PADRAO) continue;
    const arq = path.join(d, `${tag}.json`);
    try {
      const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
      // Only a non-empty string goes in: a key with null/number in the JSON would become
      // an unexpected replacement down the line.
      const limpo = {};
      for (const [k, v] of Object.entries(j)) if (typeof v === 'string' && v.trim()) limpo[k] = v;
      fora[tag] = { ...fora[tag], ...limpo };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[site-i18n] catalog ${tag} ignored: ${e.message}`);
    }
  }
  return fora;
}

// Single entry point called by the server. In pt-BR returns the SAME string, without going
// through the walk: that's what guarantees today's page doesn't change a byte.
export function traduzPagina(html, language, catalogos) {
  const tag = tagIdioma(language);
  if (tag === IDIOMA_PADRAO) return html;
  const cat = catalogos?.[tag];
  if (!cat) return html;
  return trocaLangDoHtml(aplicaCatalogo(html, cat), tag);
}
