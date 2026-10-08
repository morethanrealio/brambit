// ── Deterministic app consistency lint (zero token cost) ──
// Runs on the HOST inside publicar_sistema, before the publish. Catches the
// bug classes that caused the worst failure mode observed (KhaosClass
// incident, Aug/2026): the agent edits a big file, forgets a function the
// HTML references, the publish goes through (boot doesn't run the click
// handler) and the user spends turns hunting a "button that does nothing".
// The 3 rules are the same ones pre-registered in the rescued app's
// ESPECIFICACAO.md:
//   1. Every on*(onclick/onchange/...) handler referenced in HTML/templates
//      has a function defined in some .js of the app.              → ERROR (blocks)
//   2. Every client api()/fetch() call has a route on the server.   → WARNING (does
//      not block: matching a literal path against a route regex is too
//      heuristic to block on)
//   3. No function declared in two CLIENT files.                   → ERROR (blocks)
//      (client only: Node's require() modules have their own scope, duplicating
//      there is fine)
//   4. A called name that does not exist in the app and is almost identical
//      to a declared name (typo).                                   → WARNING (does
//      not block: it's input for the MODEL to review, never text for the
//      app's owner; see app-typo-hunt.mjs)
// Pure functions (files = {caminho: texto}) so they can be tested without the harness.

import { huntTypos } from './app-typo-hunt.mjs';

// Global browser/JS names a handler can call without defining.
const BUILTIN_NAMES = new Set([
  'alert', 'confirm', 'prompt', 'open', 'close', 'print', 'focus', 'blur',
  'scrollTo', 'scrollBy', 'requestAnimationFrame', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'fetch', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'JSON', 'Math',
  'Promise', 'RegExp', 'Error', 'Map', 'Set', 'URL', 'FormData', 'escape', 'unescape',
  'return', 'if', 'for', 'while', 'switch', 'function', 'typeof', 'void', 'new',
  'event', 'this', 'window', 'document', 'history', 'location', 'console', 'require',
]);

const CODE_EXTS = /\.(js|mjs|cjs|html|htm)$/i;
const JS_EXTS = /\.(js|mjs|cjs)$/i;

function isClientPath(rel, htmlSrcSet) {
  if (/^(public|static|templates)\//i.test(rel)) return true;
  if (htmlSrcSet.has(rel)) return true;
  // Basename match ONLY for a root-level file (index.html references
  // "portal.js" served from public/; lib/routes/portal.js must NOT become a
  // client file by namesake).
  return !rel.includes('/') && htmlSrcSet.has(rel.split('/').pop());
}

// Counts lines in a text (size-guard metric: lines, not bytes — a minified
// vendor file is 1 giant line and is legitimate).
export function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Decodes {caminho: base64} → {caminho: texto} only for code files.
export function decodeCodeFiles(filesB64) {
  const out = {};
  for (const [rel, b64] of Object.entries(filesB64 || {})) {
    if (!CODE_EXTS.test(rel)) continue;
    try { out[rel] = Buffer.from(b64, 'base64').toString('utf8'); } catch { /* binary: skip */ }
  }
  return out;
}

// Extracts the function names called in on* attributes (onclick="fn(...)"),
// both in HTML and in JS template strings (where the classic bug lives).
function collectHandlerRefs(files) {
  const refs = new Map(); // name -> Set of files where it's referenced
  const attrRe = /\bon[a-z]{2,20}\s*=\s*(["'])([\s\S]*?)\1/gi;
  const callRe = /([A-Za-z_$][\w$]*)\s*\(/g;
  for (const [rel, txt] of Object.entries(files)) {
    let m;
    attrRe.lastIndex = 0;
    while ((m = attrRe.exec(txt)) !== null) {
      const val = m[2];
      let c;
      callRe.lastIndex = 0;
      while ((c = callRe.exec(val)) !== null) {
        const name = c[1];
        const prev = c.index > 0 ? val[c.index - 1] : '';
        if (prev === '.' || prev === '$') continue;          // method/interpolation, not global
        if (BUILTIN_NAMES.has(name)) continue;
        if (!refs.has(name)) refs.set(name, new Set());
        refs.get(name).add(rel);
      }
    }
  }
  return refs;
}

// Tests whether `name` has a definition in some file. Deliberately GENEROUS:
// a false "defined" is better than blocking a good publish; the real orphan
// (zero matches across the whole app) is what matters.
function isDefined(name, files) {
  const esc = name.replace(/\$/g, '\\$');
  const pats = [
    new RegExp(`\\bfunction\\s+${esc}\\s*\\(`),
    new RegExp(`\\basync\\s+function\\s+${esc}\\s*\\(`),
    new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=`),
    new RegExp(`\\bwindow\\.${esc}\\s*=`),
    new RegExp(`(?:^|[^.\\w$])${esc}\\s*=\\s*(?:async\\b|function\\b|\\()`),
    new RegExp(`\\b${esc}\\s*:\\s*(?:async\\s+)?function\\b`),
    new RegExp(`^\\s*(?:async\\s+)?${esc}\\s*\\([^()]*\\)\\s*\\{`, 'm'),
  ];
  for (const txt of Object.values(files)) {
    for (const re of pats) if (re.test(txt)) return true;
  }
  return false;
}

// Rule 2: literal client api()/fetch() paths vs. the server's text. Server
// routes tend to be regex (\/api\/turmas\/(\d+)\/...), so the server's text
// is normalized (\/ → /) and the client's path becomes "literal chunks"
// (consecutive segments with no ${...}); the route is considered present if
// ANY non-trivial chunk shows up on the server. Only flags when it clearly
// does not exist.
function collectApiCallIssues(files, htmlSrcSet, serverBlob) {
  const avisos = [];
  const seen = new Set();
  const callRe = /\b(?:api|fetch)\(\s*([`'"])([^`'"]+)\1/g;
  for (const [rel, txt] of Object.entries(files)) {
    if (!isClientPath(rel, htmlSrcSet) && !/\.html?$/i.test(rel)) continue;
    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(txt)) !== null) {
      let p = m[2].split('?')[0].replace(/^\.?\//, '');
      if (p.startsWith('http') || !/(^|\/)api\//.test('/' + p)) continue; // API routes only
      const segs = p.split('/');
      const runs = [];
      let cur = [];
      for (const s of segs) {
        if (s.includes('${')) { if (cur.length) runs.push(cur.join('/')); cur = []; }
        else cur.push(s);
      }
      if (cur.length) runs.push(cur.join('/'));
      const candidates = runs
        .map((r) => r.replace(/^api\/?/, ''))
        .filter((r) => r.length > 1);
      if (!candidates.length) continue; // just "api/${x}": nothing literal to check
      const found = candidates.some((r) => serverBlob.includes(r));
      if (!found) {
        const key = p;
        if (seen.has(key)) continue;
        seen.add(key);
        avisos.push({ tipo: 'rota_nao_encontrada', chamada: p, arquivo: rel });
      }
    }
  }
  return avisos;
}

// Rule 3: same function DECLARED in two client files (shared global scope →
// the last one loaded silently wins).
function collectDuplicateFunctions(files, htmlSrcSet) {
  const decl = new Map(); // name -> Set of files
  const fnRe = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const [rel, txt] of Object.entries(files)) {
    if (!JS_EXTS.test(rel) || !isClientPath(rel, htmlSrcSet)) continue;
    let m;
    fnRe.lastIndex = 0;
    while ((m = fnRe.exec(txt)) !== null) {
      if (!decl.has(m[1])) decl.set(m[1], new Set());
      decl.get(m[1]).add(rel);
    }
  }
  const erros = [];
  for (const [name, where] of decl) {
    if (where.size > 1) erros.push({ tipo: 'funcao_duplicada', funcao: name, arquivos: [...where].sort() });
  }
  return erros;
}

// Full lint. files = {caminho: texto} (use decodeCodeFiles to come from b64).
// Returns { erros, avisos }: errors block the publish, warnings just inform.
export function lintApp(files) {
  const erros = [];
  const avisos = [];
  // .js files referenced in a <script src> of some HTML count as client.
  const htmlSrcSet = new Set();
  const srcRe = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (const [rel, txt] of Object.entries(files)) {
    if (!/\.html?$/i.test(rel)) continue;
    let m;
    srcRe.lastIndex = 0;
    while ((m = srcRe.exec(txt)) !== null) {
      const src = m[1].split('?')[0].replace(/^\.?\//, '');
      if (src.startsWith('http')) continue;
      htmlSrcSet.add(src);
      htmlSrcSet.add(src.split('/').pop());
    }
  }

  // Rule 1: orphaned on* handlers.
  const refs = collectHandlerRefs(files);
  for (const [name, where] of refs) {
    if (!isDefined(name, files)) {
      erros.push({ tipo: 'handler_orfao', funcao: name, referenciado_em: [...where].sort() });
    }
  }

  // Rule 3: function declared in two client files.
  erros.push(...collectDuplicateFunctions(files, htmlSrcSet));

  // Regra 2: api()/fetch() sem rota no servidor (aviso).
  const serverBlob = Object.entries(files)
    .filter(([rel]) => JS_EXTS.test(rel) && !isClientPath(rel, htmlSrcSet))
    .map(([, txt]) => txt)
    .join('\n')
    .replace(/\\\//g, '/');
  const pyBlob = Object.entries(files)
    .filter(([rel]) => /\.py$/i.test(rel))
    .map(([, txt]) => txt).join('\n');
  avisos.push(...collectApiCallIssues(files, htmlSrcSet, serverBlob + '\n' + pyBlob));

  // Rule 4: called name that does not exist and is almost the same as a
  // declared one (warning).
  avisos.push(...huntTypos(files));

  return { erros, avisos };
}

// Convenience for hosting.mjs: takes {caminho: base64} directly.
export function lintAppB64(filesB64) {
  return lintApp(decodeCodeFiles(filesB64));
}
