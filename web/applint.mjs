// ── Lint determinístico de consistência de apps (custo zero de tokens) ──
// Roda no HOST dentro do publicar_sistema, antes do publish. Pega as classes de
// bug que geraram o pior modo de falha observado (incidente KhaosClass, ago/2026):
// o agente edita um arquivo grande, esquece uma função que o HTML referencia, o
// publish passa (o boot não executa handler de clique) e o usuário gasta turnos
// caçando "botão que não faz nada". As 3 regras são as mesmas pré-registradas no
// ESPECIFICACAO.md do app resgatado:
//   1. Todo handler on*(onclick/onchange/...) referenciado em HTML/templates tem
//      função definida em algum .js do app.                       → ERRO (bloqueia)
//   2. Toda chamada api()/fetch() do cliente tem rota no servidor. → AVISO (não bloqueia:
//      casar caminho literal com regex de rota é heurístico demais pra bloquear)
//   3. Nenhuma função declarada em dois arquivos de CLIENTE.       → ERRO (bloqueia)
//      (só cliente: módulos require() do Node têm escopo próprio, duplicar lá é legal)
//   4. Nome chamado que não existe no app e é quase idêntico a um nome
//      declarado (typo de digitação).                              → AVISO (não bloqueia:
//      é insumo pro MODELO revisar, nunca texto pro dono do app; ver app-typo-hunt.mjs)
// Funções puras (files = {caminho: texto}) pra dar pra testar sem harness.

import { huntTypos } from './app-typo-hunt.mjs';

// Nomes globais do browser/JS que um handler pode chamar sem definir.
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
  // Match por basename SÓ pra arquivo na raiz (index.html referencia "portal.js"
  // servido de public/; lib/routes/portal.js NÃO pode virar cliente por homônimo).
  return !rel.includes('/') && htmlSrcSet.has(rel.split('/').pop());
}

// Conta linhas de um texto (métrica do guarda de tamanho: linhas, não bytes —
// vendor minificado é 1 linha gigante e é legítimo).
export function countLines(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Decodifica {caminho: base64} → {caminho: texto} só dos arquivos de código.
export function decodeCodeFiles(filesB64) {
  const out = {};
  for (const [rel, b64] of Object.entries(filesB64 || {})) {
    if (!CODE_EXTS.test(rel)) continue;
    try { out[rel] = Buffer.from(b64, 'base64').toString('utf8'); } catch { /* binário: ignora */ }
  }
  return out;
}

// Extrai os nomes de função chamados em atributos on* (onclick="fn(...)"),
// tanto em HTML quanto em template string de JS (é onde o bug clássico mora).
function collectHandlerRefs(files) {
  const refs = new Map(); // nome -> Set de arquivos onde é referenciado
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
        if (prev === '.' || prev === '$') continue;          // método/interpolação, não global
        if (BUILTIN_NAMES.has(name)) continue;
        if (!refs.has(name)) refs.set(name, new Set());
        refs.get(name).add(rel);
      }
    }
  }
  return refs;
}

// Testa se `name` tem definição em algum arquivo. GENEROSO de propósito: falso
// "definido" é melhor que bloquear publish bom; o orfão de verdade (zero matches
// em todo o app) é o que interessa.
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

// Regra 2: caminhos literais de api()/fetch() do cliente vs texto do servidor.
// Server routes costumam ser regex (\/api\/turmas\/(\d+)\/...), então o texto do
// servidor é normalizado (\/ → /) e o caminho do cliente vira "trechos literais"
// (segmentos consecutivos sem ${...}); a rota é dada como presente se QUALQUER
// trecho não-trivial aparecer no servidor. Só aponta quando claramente não existe.
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
      if (p.startsWith('http') || !/(^|\/)api\//.test('/' + p)) continue; // só rotas de API
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
      if (!candidates.length) continue; // só "api/${x}": nada literal pra conferir
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

// Regra 3: mesma função DECLARADA em dois arquivos de cliente (escopo global
// compartilhado → a última carregada vence silenciosamente).
function collectDuplicateFunctions(files, htmlSrcSet) {
  const decl = new Map(); // nome -> Set de arquivos
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

// Lint completo. files = {caminho: texto} (use decodeCodeFiles pra vir de b64).
// Devolve { erros, avisos }: erros bloqueiam o publish, avisos só informam.
export function lintApp(files) {
  const erros = [];
  const avisos = [];
  // Arquivos .js citados em <script src> de algum HTML contam como cliente.
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

  // Regra 1: handlers on* órfãos.
  const refs = collectHandlerRefs(files);
  for (const [name, where] of refs) {
    if (!isDefined(name, files)) {
      erros.push({ tipo: 'handler_orfao', funcao: name, referenciado_em: [...where].sort() });
    }
  }

  // Regra 3: função declarada em dois arquivos de cliente.
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

  // Regra 4: nome chamado que não existe e é quase igual a um declarado (aviso).
  avisos.push(...huntTypos(files));

  return { erros, avisos };
}

// Conveniência pro hosting.mjs: recebe {caminho: base64} direto.
export function lintAppB64(filesB64) {
  return lintApp(decodeCodeFiles(filesB64));
}
