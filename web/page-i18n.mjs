// Text of the HTML pages, from the catalogs (docs/i18n.md, "Pages"). The page
// marks what a person reads and the server fills it in the request's language:
//
//   <h1 data-i18n="usage_page.title">Usage & cost</h1>
//   <input data-i18n-placeholder="usage_page.user_all" placeholder="all">
//   <script type="application/json" data-i18n-texts="usage_page"></script>
//
// - `data-i18n="key"` replaces the element's content. Child tags (bold, a
//   link, a command) stay in the page and the catalog text places them by
//   number: "Click <0>Connect</0>" or "Run <1/>", so a sentence is never split
//   into pieces.
// - `data-i18n-<attribute>="key"` replaces that attribute (placeholder, title,
//   alt, aria-label, content...).
// - `data-i18n-texts="<area>"` on an empty JSON script is filled with the
//   `<area>.*` texts, for the page's own script (web/public/page-texts.js).
//
// The English written in the page is only the source for whoever reads the
// HTML: the catalogs decide what is served, with the fallback to English and to
// the key. Pages that are not migrated yet go through web/site-i18n.mjs after
// this, keyed by the Portuguese sentence.

import { productI18n } from './i18n.mjs';
import { traduzPagina } from './site-i18n.mjs';

export { carregaCatalogos } from './site-i18n.mjs';

const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');
// JSON inside <script>: `</script>` or `<!--` in a text must not end the block.
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

const OPEN_TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function attributes(raw) {
  const out = [];
  for (const m of raw.matchAll(ATTR)) out.push({ name: m[1], lower: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? '' });
  return out;
}

// Texts of an area, without the area prefix, for the page's script. `vars`
// fills what the server knows ({brand}); the rest is left for pageText().
export function pageTexts(area, language, i18n = productI18n(), vars = {}) {
  const prefix = `${area}.`;
  return Object.fromEntries(i18n.keys(area).map((key) => [key.slice(prefix.length), i18n.t(key, language, vars)]));
}

// Fills the marks of `html` in `language`. `vars` fills placeholders the page
// cannot know ({brand}). A page without marks comes back as the same string.
export function fillPage(html, language, { i18n = productI18n(), vars = {}, onProblem = () => {} } = {}) {
  if (!html.includes('data-i18n')) return html;
  const text = (key) => i18n.t(key, language, vars);
  let out = '';
  let last = 0;
  OPEN_TAG.lastIndex = 0;
  for (let m; (m = OPEN_TAG.exec(html));) {
    const [tag, name, rawAttrs, selfClosing] = m;
    const lowerName = name.toLowerCase();
    // Script and style bodies are not HTML: skip to their end tag.
    const skipBody = (lowerName === 'script' || lowerName === 'style') && !selfClosing;
    if (!rawAttrs.includes('data-i18n')) {
      if (skipBody) OPEN_TAG.lastIndex = endOfRawBody(html, OPEN_TAG.lastIndex, lowerName);
      continue;
    }
    const attrs = attributes(rawAttrs);
    let contentKey = null, textsArea = null;
    const replace = new Map();
    for (const a of attrs) {
      if (a.lower === 'data-i18n') contentKey = a.value;
      else if (a.lower === 'data-i18n-texts') textsArea = a.value;
      else if (a.lower.startsWith('data-i18n-')) replace.set(a.lower.slice('data-i18n-'.length), text(a.value));
    }
    let newTag = tag;
    if (replace.size) {
      // Attributes already there get the text in place; missing ones are added.
      const done = new Set();
      const filled = rawAttrs.replace(ATTR, (whole, attr) => {
        const lower = attr.toLowerCase();
        if (!replace.has(lower)) return whole;
        done.add(lower);
        return `${attr}="${escapeAttr(replace.get(lower))}"`;
      });
      const added = [...replace].filter(([attr]) => !done.has(attr)).map(([attr, value]) => ` ${attr}="${escapeAttr(value)}"`);
      newTag = `<${name}${filled}${added.join('')}${selfClosing ? ' /' : ''}>`;
    }
    out += html.slice(last, m.index) + newTag;
    last = OPEN_TAG.lastIndex;
    if (textsArea && lowerName === 'script') {
      const close = endOfRawBody(html, last, 'script');
      out += jsonForScript(pageTexts(textsArea, language, i18n, vars));
      last = close;
      OPEN_TAG.lastIndex = close;
      continue;
    }
    if (skipBody) { OPEN_TAG.lastIndex = endOfRawBody(html, last, lowerName); continue; }
    if (contentKey && !selfClosing) {
      const body = parseInline(html, last, lowerName);
      const markup = (tag) => (tag.includes('data-i18n') ? fillPage(tag, language, { i18n, vars, onProblem }) : tag);
      const filled = body && renderText(text(contentKey), body.nodes, markup);
      if (filled == null) {
        onProblem(body ? `data-i18n="${contentKey}" names a child tag that <${name}> does not have` : `data-i18n="${contentKey}" on <${name}> has markup that cannot be read`);
        continue;
      }
      // Keep the whitespace around the text: only the words change.
      const inner = html.slice(last, body.end);
      out += /^\s*/.exec(inner)[0] + filled + /\s*$/.exec(inner)[0];
      last = body.end;
      OPEN_TAG.lastIndex = body.end;
    }
  }
  // The <html> lang= follows the language served (screen readers, spell check).
  return (out + html.slice(last)).replace(/<html\b[^>]*>/i, (tag) => tag.replace(/\blang\s*=\s*("[^"]*"|'[^']*')/i, `lang="${escapeAttr(language)}"`));
}

const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'source', 'track', 'wbr']);
const ANY_TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|<!--[\s\S]*?-->/g;

// The child tags of the element whose text starts at `from`, as a tree, and the
// index of its end tag. Null when the markup is not plain nested tags.
function parseInline(html, from, name) {
  const root = { children: [] };
  const stack = [{ name, node: root }];
  ANY_TAG.lastIndex = from;
  for (let m; (m = ANY_TAG.exec(html));) {
    if (!m[2]) continue; // comment
    const top = stack[stack.length - 1];
    const tag = m[2].toLowerCase();
    if (m[1]) {
      if (tag !== top.name) return null;
      if (stack.length === 1) return { nodes: root.children, end: m.index };
      top.node.close = m[0];
      top.node.outer = html.slice(top.node.start, ANY_TAG.lastIndex);
      stack.pop();
      continue;
    }
    if (tag === 'script' || tag === 'style') return null;
    const node = { open: m[0], start: m.index, children: [] };
    top.node.children.push(node);
    if (m[4] || VOID.has(tag)) { node.void = true; node.outer = m[0]; continue; }
    stack.push({ name: tag, node });
  }
  return null;
}

// A catalog text with the element's child tags in it, numbered in order on each
// level: "Click <0>Connect</0>" wraps "Connect" in the first child tag (with its
// attributes from the page), and "<1/>" puts the second child back as it is
// (a command, an icon). Text is escaped; null when a number has no tag.
function renderText(value, nodes, markup) {
  const TOKEN = /<(\d+)\s*(\/?)>|<\/(\d+)>/g;
  let pos = 0;
  const level = (children, closing) => {
    let out = '';
    for (let m; (m = TOKEN.exec(value));) {
      out += escapeText(value.slice(pos, m.index));
      pos = TOKEN.lastIndex;
      if (m[3] !== undefined) return Number(m[3]) === closing ? out : null;
      const child = children[Number(m[1])];
      if (!child) return null;
      if (m[2]) { out += markup(child.outer); continue; }
      if (child.void) return null;
      const inner = level(child.children, Number(m[1]));
      if (inner == null) return null;
      out += markup(child.open) + inner + child.close;
    }
    if (closing !== null) return null;
    return out + escapeText(value.slice(pos));
  };
  return level(nodes, null);
}

// Index of the `</name>` that ends a raw body (script/style) starting at `from`.
function endOfRawBody(html, from, name) {
  const m = new RegExp(`</\\s*${name}\\s*>`, 'i').exec(html.slice(from));
  return m ? from + m.index : html.length;
}

// Every key a page uses, for the check that they exist in English.
export function pageKeys(html) {
  const keys = new Set(), areas = new Set();
  OPEN_TAG.lastIndex = 0;
  for (let m; (m = OPEN_TAG.exec(html));) {
    const lowerName = m[1].toLowerCase();
    if (m[2].includes('data-i18n')) {
      for (const a of attributes(m[2])) {
        if (a.lower === 'data-i18n-texts') areas.add(a.value);
        else if (a.lower === 'data-i18n' || a.lower.startsWith('data-i18n-')) keys.add(a.value);
      }
    }
    if ((lowerName === 'script' || lowerName === 'style') && !m[3]) OPEN_TAG.lastIndex = endOfRawBody(html, OPEN_TAG.lastIndex, lowerName);
  }
  return { keys: [...keys], areas: [...areas] };
}

// The whole page: catalog marks first, then the Portuguese-keyed catalogs of the
// pages not migrated yet (web/site-i18n.mjs). A mark that cannot be filled is
// logged once per page and text, and the page is served anyway.
const reported = new Set();
export function translatePage(html, language, legacyCatalogs, { vars = {}, file = 'page' } = {}) {
  const filled = fillPage(html, language, { vars, onProblem: (problem) => {
    const id = `${file}: ${problem}`;
    if (!reported.has(id)) { reported.add(id); console.warn(`[page-i18n] ${id}`); }
  } });
  return traduzPagina(filled, language, legacyCatalogs);
}
