// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
// i18n tests for the server's MESSAGES. As with the site, what is proven here
// is not translation quality: it's that the Portuguese response comes out exactly
// the same as today's, and that nothing besides `error` and `message` is touched.
//
// The difference in mechanism relative to the site matters and is tested: there the
// catalog is REPLACED inside the page's source; here it's a LOOKUP in the map
// with the string already in hand. That's why no test here worries about
// quotes or backticks in the translation, but rather about a key that no longer exists in the code.
//
// run: node mensagens-i18n.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraiMensagens, traduzMensagem, traduzResposta, idiomaDaRequisicao, FONTES_MENSAGENS } from './web/mensagens-i18n.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, 'web');

let ok = 0, falhas = 0;
const t = (nome, fn) => {
  try { fn(); ok++; }
  catch (e) { falhas++; console.error(`FALHOU: ${nome}\n  ${e.message}`); }
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg || 'diferente'}\n  esperado: ${JSON.stringify(b)?.slice(0, 300)}\n  obtido:   ${JSON.stringify(a)?.slice(0, 300)}`);
};

const fonte = FONTES_MENSAGENS.map((f) => fs.readFileSync(path.join(WEB, f), 'utf8')).join('\n');
const mensagens = extraiMensagens(fonte);
const catalogos = {};
for (const idioma of ['en', 'es']) {
  catalogos[idioma] = JSON.parse(fs.readFileSync(path.join(WEB, 'textos-servidor', `${idioma}.json`), 'utf8'));
}

// ── 1. pt-BR doesn't change a byte ───────────────────────────────────────────────
// This is THE test. It runs over the 362 real messages, not over a made-up
// example: if one of them started coming out different, today's 99 users
// would see the change.
t('pt-BR returns the SAME string in every real message', () => {
  for (const m of mensagens) {
    for (const idioma of ['pt-BR', 'pt', 'pt-PT', undefined, null, '']) {
      const saida = traduzMensagem(m, idioma, catalogos);
      if (saida !== m) throw new Error(`${JSON.stringify(idioma)} mexeu em ${JSON.stringify(m)} -> ${JSON.stringify(saida)}`);
    }
  }
});

t('pt-BR returns the SAME object, by the same reference', () => {
  const obj = { ok: false, error: 'Faça login.', message: 'Faça login.', saldo: 12 };
  for (const idioma of ['pt-BR', undefined, null]) {
    if (traduzResposta(obj, idioma, catalogos) !== obj) throw new Error(`copiou o objeto em ${JSON.stringify(idioma)}`);
  }
});

t('unknown language does not translate and does not copy', () => {
  const obj = { error: 'Faça login.' };
  eq(traduzResposta(obj, 'de', catalogos), obj, 'German has no catalog, the same object should come out');
  eq(traduzMensagem('Faça login.', 'de', catalogos), 'Faça login.', 'German has no catalog');
});

// ── 2. only `error` and `message`, nothing else ────────────────────────────────────
t('translates error and message and does not touch the rest', () => {
  const pt = mensagens.find((m) => catalogos.en[m]);
  if (!pt) throw new Error('catálogo en vazio: o resto do teste não valeria nada');
  const obj = { ok: false, error: pt, id: 'abc', queued: true, credits: 10 };
  const saida = traduzResposta(obj, 'en', catalogos);
  eq(saida.error, catalogos.en[pt], 'error should have been translated');
  for (const campo of ['ok', 'id', 'queued', 'credits']) eq(saida[campo], obj[campo], `${campo} was changed`);
  eq(Object.keys(saida).join(','), Object.keys(obj).join(','), 'the set or order of keys changed');
  eq(obj.error, pt, 'the ORIGINAL object was mutated');
});

t('a field that is not a string passes through untouched', () => {
  const obj = { error: { code: 42 }, message: 7 };
  eq(traduzResposta(obj, 'en', catalogos), obj, 'an object with no translatable string should come out as the same reference');
});

t('not an object: returns as it came', () => {
  for (const v of [null, undefined, 'texto', 42, true]) eq(traduzResposta(v, 'en', catalogos), v, `changed ${JSON.stringify(v)}`);
});

// ── 3. machine code never turns into a translated sentence ─────────────────────────
// Translating `locked` or `bad_request` wouldn't make the screen ugly: it would leave the
// client comparing against a value that changed language.
t('machine code stays out of the extraction', () => {
  const CODIGO = /^[a-z][a-z0-9_]*$/;
  const vazados = mensagens.filter((m) => CODIGO.test(m));
  if (vazados.length) throw new Error(`extraiu código de máquina: ${JSON.stringify(vazados)}`);
});

t('machine code is not in the catalog, not even by mistake', () => {
  for (const idioma of ['en', 'es']) {
    for (const codigo of ['locked', 'no_agent', 'bad_request', 'unauthorized', 'rate_limited']) {
      if (catalogos[idioma][codigo] !== undefined) throw new Error(`${idioma} traduz ${codigo}`);
      eq(traduzMensagem(codigo, idioma, catalogos), codigo, `${idioma} changed ${codigo}`);
    }
  }
});

// ── 4. the catalog matches today's code ─────────────────────────────────────
// A key that no longer exists in server.mjs is dead weight and hides a typo;
// this test is what warns when someone rewrites a message.
t('every catalog key exists in the server.mjs extraction', () => {
  const validas = new Set(mensagens);
  for (const idioma of ['en', 'es']) {
    const orfas = Object.keys(catalogos[idioma]).filter((k) => !validas.has(k));
    if (orfas.length) throw new Error(`${idioma} tem ${orfas.length} chave(s) órfã(s): ${JSON.stringify(orfas.slice(0, 5))}`);
  }
});

t('no translation carries a backslash or interpolation', () => {
  for (const idioma of ['en', 'es']) {
    for (const [pt, tr] of Object.entries(catalogos[idioma])) {
      if (typeof tr !== 'string' || !tr.trim()) throw new Error(`${idioma}: tradução vazia em ${JSON.stringify(pt)}`);
      if (tr.includes('\\')) throw new Error(`${idioma}: barra invertida em ${JSON.stringify(pt)}`);
      if (tr.includes('${')) throw new Error(`${idioma}: interpolação em ${JSON.stringify(pt)}`);
    }
  }
});

t('extraction does not pick up a template nor a literal with escape', () => {
  for (const m of mensagens) {
    if (m.includes('${')) throw new Error(`template virou chave: ${JSON.stringify(m)}`);
    if (m.includes('\\')) throw new Error(`literal com escape virou chave: ${JSON.stringify(m)}`);
  }
});

// ── 5. emission point, not content ───────────────────────────────────────
// What decides whether a literal goes to the screen is where it exits through. `return { error }`
// is a tool result, it goes to the model, and translating it there would mess with the text that guides
// its decision.
t('only a literal emitted by fail()/send() gets in', () => {
  const amostra = `
    fail(res, 401, 'Entra na conta primeiro.');
    send(res, 400, { error: 'Escolhe um arquivo.' });
    send(res, 200, { ok: true, message: 'Tudo certo por aqui.' });
    return { error: 'Isto aqui é resposta de tool.' };
    const rotulo = 'Isto aqui é texto solto.';
    fail(res, 403, 'locked');
  `;
  const achados = extraiMensagens(amostra);
  eq(achados.join(' | '), 'Entra na conta primeiro. | Escolhe um arquivo. | Tudo certo por aqui.', 'conjunto errado');
});

// ── 6. request language ─────────────────────────────────────────────────
// The order exists for a reason: the SPA's `X-Idioma` is not a browser guess,
// it's the echo of the SAVED preference with which the server assembled that page. So
// the error arrives in the same language as the screen that triggered it.
const doHeader = (req) => ({ language: req.headers['accept-language'] === 'es-AR' ? 'es' : 'pt-BR' });

t('valid X-Idioma wins over Accept-Language', () => {
  eq(idiomaDaRequisicao({ headers: { 'x-idioma': 'en', 'accept-language': 'es-AR' } }, doHeader), 'en');
});

t('invalid X-Idioma falls back to Accept-Language', () => {
  eq(idiomaDaRequisicao({ headers: { 'x-idioma': 'klingon', 'accept-language': 'es-AR' } }, doHeader), 'es');
  eq(idiomaDaRequisicao({ headers: { 'x-idioma': 'EN', 'accept-language': 'es-AR' } }, doHeader), 'es', 'the check is case-sensitive, on purpose');
});

t('no header at all, Portuguese', () => {
  eq(idiomaDaRequisicao({ headers: {} }, doHeader), 'pt-BR');
  eq(idiomaDaRequisicao({}, doHeader), 'pt-BR');
});

t('a doHeader that throws does not bring down the request', () => {
  eq(idiomaDaRequisicao({ headers: {} }, () => { throw new Error('boom'); }), 'pt-BR');
});

// ── 7. the SPA actually returns the page's language ─────────────────────────
// Without this the rest turns into theory: if `api()` stops sending the header, every
// app error falls back to Portuguese and no other test complains.
t('index.html sends X-Idioma with the <html> lang', () => {
  const spa = fs.readFileSync(path.join(WEB, 'public', 'index.html'), 'utf8');
  if (!/X-Idioma/.test(spa)) throw new Error('o api() da SPA não manda mais X-Idioma');
  if (!/document\.documentElement\.lang/.test(spa)) throw new Error('X-Idioma não vem mais do lang do <html>');
});

// ── 8. coverage, as a warning and not as a failure ───────────────────────────────
for (const idioma of ['en', 'es']) {
  const n = mensagens.filter((m) => catalogos[idioma][m]).length;
  console.log(`${idioma}: ${n}/${mensagens.length} mensagens traduzidas`);
}

console.log(`\n${ok} ok, ${falhas} falhas`);
process.exit(falhas ? 1 : 0);
