// Citation by reference: the model marks the fact with [n], the PLATFORM builds the
// source list.
//
// Why this exists (2026-10-06): the model used to write its own list ("Fonte: X"),
// copying, shortening and sometimes swapping names and addresses. The grounding
// guard (grounding-guard.mjs) then compared text to text and got it wrong on
// both sides: it flagged a real source that the model had summarized and had no way to
// prove where each fact came from. Here the origin is guaranteed by construction:
//  1. each source that a search/read tool shows the model gets a fixed
//     number in the turn (registroDeFontes), in the tool's own output;
//  2. the model only writes the number next to the fact;
//  3. citarFontes swaps the number for the real source: a number that no tool
//     showed disappears, and the list the person reads comes from the registry, never from the
//     model's memory.
//
// The other pure fixes to the final text also live here (orphan marker,
// leaked tool-call, punctuation stuck to a link), which used to live in server.mjs.
// Pure module: no I/O, no database.
import { tagIdioma, IDIOMA_PADRAO } from './locale.mjs';

const ROTULO = { 'pt-BR': 'Fontes:', en: 'Sources:', es: 'Fuentes:' };
const rotuloDe = language => ROTULO[tagIdioma(language)] || ROTULO[IDIOMA_PADRAO] || 'Fontes:';

/**
 * Registry of the sources the model saw in this turn. The same URL always receives the
 * same number, so two searches that find the same page don't generate two
 * sources. Only http(s) addresses are included: without an address, the source doesn't serve as proof.
 */
export function registroDeFontes() {
  const lista = [];
  const porUri = new Map();
  return {
    add({ title, uri } = {}) {
      const u = String(uri || '').trim();
      if (!/^https?:\/\/\S+$/i.test(u)) return 0;
      if (porUri.has(u)) return porUri.get(u);
      lista.push({ title: String(title || '').replace(/\s+/g, ' ').trim() || u, uri: u });
      porUri.set(u, lista.length);
      return lista.length;
    },
    get: n => lista[n - 1] || null,
    get size() { return lista.length; },
  };
}

// ——— markers ———————————————————————————————————————————————
// Touching the final text affects 100% of everyone's responses, so marker
// swapping is fenced by gates, and outside them the text comes out byte for byte:
//  - the marker has to be INSIDE the sentence, never opening a line (otherwise
//    we'd erase the menu the assistant itself offered: "[1] Sim");
//  - it has to look like a citation: numbers starting from 1 (the range "[0, 1]" stays) and
//    no digit right after (area code "[11] 98888-7777" stays);
//  - code block (``` or `) passes through intact: there "[0]" is code.
const CITACAO = String.raw`\[\s*[1-9]\d*(?:\s*[,;]\s*[1-9]\d*)*\s*\]`;
const RE_CITACAO = new RegExp(
  String.raw`[ \t]*(?<![\w\]])(?:\(\s*${CITACAO}\s*\)|${CITACAO})(?!\()[ \t]*`,
  'g',
);
// In reference citation, the group "[1][3]" is a single marker.
const RE_GRUPO = new RegExp(
  String.raw`[ \t]*(?<![\w\]])(?:\(\s*${CITACAO}\s*\)|${CITACAO}(?:[ \t]*${CITACAO})*)(?!\()[ \t]*`,
  'g',
);
const RE_LISTA = /(^|\n)\s*(fontes|sources|fuentes)\s*:/i;
const RE_ITEM_LISTA = /^\s*\[\d+\]\s+\S.*https?:\/\//m;

// Junk that is never content: "[cite: 1]" and the tool call's own
// identifier that some models use as a citation.
function limparLixo(s) {
  return s.replace(/[ \t]*\[cite:\s*\d+(?:[.,;\s]+\d+)*\s*\][ \t]*/gi, (m, off, str) => {
    const next = str[off + m.length] || '';
    return !off || !next || /[\s.,;:!?)\]]/.test(next) ? '' : ' ';
  }).replace(/default_api[:.][A-Za-z0-9_.-]+(?:\s*:\s*\d+)?/g, '');
}

// Opening a line (with or without a markdown bullet/heading) is a list or menu item.
function abreLinha(str, off, m) {
  const linha = str.slice(str.lastIndexOf('\n', off - 1) + 1, off + m.length - m.trimStart().length);
  return /^\s*(?:[-*•>#]+\s*)*$/.test(linha);
}

// Space from the removed marker: only comes back if it was separating two words.
function semMarcador(m, off, str) {
  const antes = str[off - 1] || '';
  const depois = str[off + m.length] || '';
  if (!antes || !depois || antes === '\n' || /[\s.,;:!?)\]]/.test(depois)) return '';
  return ' ';
}

// Applies fn only to prose: outside of ``` (an unclosed fence counts as open until
// the end, the case of a response cut off at the cap) and outside of `inline`.
function naProsa(texto, fn) {
  const partes = String(texto).split(/(```[\s\S]*?```)/g);
  const abertaEm = partes.findIndex((p, i) => i % 2 === 0 && p.includes('```'));
  return partes.map((parte, i) => (i % 2 || (abertaEm >= 0 && i >= abertaEm) ? parte
    : parte.split(/(`[^`\n]*`)/g).map((p, j) => (j % 2 ? p : fn(p))).join(''))).join('');
}
const prosaDe = texto => { const out = []; naProsa(texto, p => { out.push(p); return p; }); return out.join('\n'); };

/**
 * Turn WITHOUT a source registry (none of our searches ran, or only Gemini's
 * native search did): removes orphan markers. With a list in the text, the [n] resolves and stays.
 */
export function stripCitationMarkers(s) {
  const temLista = (t) => RE_LISTA.test(t) || RE_ITEM_LISTA.test(t);
  const listaNoTexto = temLista(prosaDe(s));
  return naProsa(s, (p) => {
    const t = limparLixo(p);
    if (listaNoTexto || temLista(t)) return t;
    return t.replace(RE_CITACAO, (m, off, str) => {
      if (abreLinha(str, off, m)) return m;
      if (/\d/.test(str[off + m.length] || '')) return m;
      return semMarcador(m, off, str);
    });
  });
}

const numerosDe = m => (m.match(/\d+/g) || []).map(Number);

// List the model wrote itself: the LAST "Fontes:" line outside of code and
// the items right below it (lines with [n], bullet or address; a blank
// line only doesn't close the list if the next one is an item). Returns the positions in the text.
const RE_CABECA = /^[ \t>*_#-]*(?:fontes|sources|fuentes)[\s*_]*:/i;
const RE_ITEM = /^\s*(?:[-*•+]|\d+[.)]|\[\d+\])\s+\S|https?:\/\//;
function blocoDoModelo(texto) {
  const linhas = texto.split('\n');
  let cerca = false, cab = -1;
  linhas.forEach((l, i) => {
    if (/^\s*```/.test(l)) cerca = !cerca;
    else if (!cerca && RE_CABECA.test(l)) cab = i;
  });
  if (cab < 0) return null;
  let fim = cab + 1;
  while (fim < linhas.length) {
    const l = linhas[fim];
    if (/^\s*```/.test(l)) break;
    if (RE_ITEM.test(l)) { fim++; continue; }
    if (!l.trim() && RE_ITEM.test(linhas[fim + 1] || '')) { fim++; continue; }
    break;
  }
  const ini = linhas.slice(0, cab).join('\n').length + (cab ? 1 : 0);
  const end = linhas.slice(0, fim).join('\n').length;
  return { ini, fim: end, texto: texto.slice(ini, end) };
}
const semPontaFinal = u => u.replace(/[.,;:!?)\]>*_]+$/, '');
// The model's list can only be replaced by ours if it talks about the SAME
// sources: every address in it is in the registry, and every "[n] ... url" uses the
// same number the registry gave that address.
function trocavel(bloco, registro) {
  const conhecidas = new Map();
  for (let n = 1; n <= registro.size; n++) conhecidas.set(registro.get(n).uri, n);
  for (const u of bloco.match(/https?:\/\/[^\s<>()[\]"'`]+/g) || []) {
    if (!conhecidas.has(semPontaFinal(u))) return false;
  }
  for (const linha of bloco.split('\n')) {
    const item = /^\s*(?:[-*•+]\s*)?\[(\d+)\][^\n]*?(https?:\/\/[^\s<>()[\]"'`]+)/.exec(linha);
    if (item && conhecidas.get(semPontaFinal(item[2])) !== Number(item[1])) return false;
  }
  return true;
}

/**
 * Swaps the [n] in the text for the real sources from the turn's registry.
 *  - a number some tool showed stays, and the source enters the list;
 *  - a number no tool showed disappears (there's no source for it);
 *  - the "Fontes:" list is built HERE, only with what was cited. If the model
 *    wrote its own with the same sources, ours takes its place; if
 *    its own brings something else (its own numbering, an address the registry doesn't
 *    know), the text stays as it wrote it, because the numbers point to
 *    its list;
 *  - with no valid citation, nothing is appended and the "Fonte: X" line the
 *    model may have written stays intact.
 * In the list, the cited sources become 1, 2, 3... in the order they appear in the
 * text, and all of them are included (the turn's registry can have over 100 sources and the
 * model cites only some). Exception: if an [n] is left in the text that the gates
 * didn't swap (opening a line, stuck to a digit) and that n exists in the registry,
 * the registry's numbering stays, so that [n] doesn't end up pointing to another
 * line in the list.
 * `comLista: false` only swaps the markers, with the registry's numbers (used for:
 * sub-agent summary, which goes back to the model and is cited again).
 * @returns {string}
 */
export function citarFontes(texto, registro, { language, comLista = true } = {}) {
  const base = String(texto ?? '');
  if (!registro?.size) return stripCitationMarkers(base);
  const bloco = blocoDoModelo(base);
  if (bloco && !trocavel(bloco.texto, registro)) return naProsa(base, limparLixo);
  const antes = bloco ? base.slice(0, bloco.ini) : base;
  const depois = bloco ? base.slice(bloco.fim) : '';
  // Insertion order = order of the first citation in the text.
  const citados = new Set();
  let escapou = false;
  // The registry number goes between \u0000 and \u0001 until the final numbering is decided.
  const trocar = (p) => limparLixo(p).replace(RE_GRUPO, (m, off, str) => {
    if (abreLinha(str, off, m) || /\d/.test(str[off + m.length] || '')) {
      if (numerosDe(m).some(n => registro.get(n))) escapou = true;
      return m;
    }
    const validos = [...new Set(numerosDe(m))].filter(n => registro.get(n));
    if (!validos.length) return semMarcador(m, off, str);
    validos.forEach(n => citados.add(n));
    const seguinte = str[off + m.length] || '';
    const fim = /[ \t]$/.test(m) && seguinte && !/[\s.,;:!?)\]]/.test(seguinte) ? ' ' : '';
    return `${/^[ \t]/.test(m) ? ' ' : ''}[${validos.map(n => `\u0000${n}\u0001`).join(', ')}]${fim}`;
  });
  const corpoBruto = naProsa(antes, trocar).replace(/\s+$/, '');
  const restoBruto = naProsa(depois, trocar).replace(/^\s+/, '');
  const ordem = !comLista || escapou ? [...citados].sort((a, b) => a - b) : [...citados];
  const novo = new Map(ordem.map((n, i) => [n, !comLista || escapou ? n : i + 1]));
  const numerar = t => t.replace(/\[((?:\u0000\d+\u0001(?:, )?)+)\]/g, (_, g) =>
    `[${numerosDe(g).map(n => novo.get(n)).sort((a, b) => a - b).join(', ')}]`);
  const corpo = numerar(corpoBruto);
  const resto = numerar(restoBruto);
  // No valid citation: the text goes back as it came, just without the orphan marker.
  if (!citados.size) return bloco ? naProsa(base, limparLixo) : corpo;
  if (!comLista) return [corpo, resto].filter(Boolean).join('\n\n');
  const linhas = ordem.map(n => `[${novo.get(n)}] ${registro.get(n).title} — ${registro.get(n).uri}`);
  return [corpo, `${rotuloDe(language)}\n${linhas.join('\n')}`, resto].filter(Boolean).join('\n\n');
}

// ——— other fixes to the final text ———————————————————————————

// The <tool_call>…</tool_call> block (GLM format: name + <arg_key>/<arg_value> pairs)
// comes out whole. Without a closing tag, it comes out up to the block's last </arg_value> or, with no
// arguments, up to the end of the tag's line. Space around the hole becomes a
// space (or a paragraph, if there was a line break).
export function removerToolCallVazado(s) {
  if (!s.includes('<tool_call>')) return s;
  const BURACO = '\u0000';
  let out = s.replace(/<tool_call>(?:(?!<tool_call>)[\s\S])*?<\/tool_call>/g, BURACO);
  let i;
  while ((i = out.indexOf('<tool_call>')) >= 0) {
    const proxima = out.indexOf('<tool_call>', i + 1);
    const bloco = out.slice(i, proxima >= 0 ? proxima : out.length);
    const fimArg = bloco.lastIndexOf('</arg_value>');
    const nl = bloco.indexOf('\n');
    const fim = fimArg >= 0 ? fimArg + '</arg_value>'.length : nl >= 0 ? nl : bloco.length;
    out = out.slice(0, i) + BURACO + out.slice(i + fim);
  }
  return out.replace(/\s*\u0000(?:\s*\u0000)*\s*/g, (m, off, str) => {
    if (!off || off + m.length >= str.length) return '';
    return m.includes('\n') ? '\n\n' : ' ';
  });
}

// A period stuck to a URL turns into a 404: the WhatsApp/Telegram linkifier (and
// ours, on web) swallows the "." inside the href. We don't control the client, so
// we strip the punctuation from the sentence when it's stuck to a link at the end of the line.
// Only touches a URL WITH a path (has "/"), so it doesn't break a sentence that ends in a
// file name ("veja o config.yaml."), and ignores markdown links (close with ")").
export function desgrudarPontuacaoDeLink(s) {
  return String(s ?? '').replace(
    /((?:https?:\/\/|(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}\/)[^\s<>()[\]]*[^\s<>()[\].,;:!?])[.,;:!?]+(?=\s*$)/gm,
    '$1',
  );
}

/**
 * Safety net for the assistant's FINAL text, independent of provider:
 *  1) strips raw tool-call markup that leaks when the model's parser fails;
 *  2) citations: with the turn's source registry, swaps [n] for the real source
 *     (citarFontes); without a registry but with a search in the turn, strips the orphan marker.
 * Secret masking and punctuation un-sticking are left to the caller
 * (the masker lives in a module with database access).
 */
export function limparTextoFinal(t, { comFontes = false, fontes = null, language } = {}) {
  // Strips only the leaked technical piece; the text for the user before AND after it
  // stays. Before, it used to cut everything from the first <tool_call> onward and lost the
  // response that came after it (2026-09-29).
  let s = removerToolCallVazado(String(t ?? ''));
  // Cleans up loose arg fragments (in case the model emits without the opening <tool_call>).
  s = s.replace(/<\/?(?:tool_call|arg_key|arg_value)>/g, '');
  if (fontes?.size) return citarFontes(s, fontes, { language });
  if (comFontes) return stripCitationMarkers(s);
  return s;
}
