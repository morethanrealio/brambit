// These cases check the Portuguese texts, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
// i18n tests for the server's MESSAGES (the `error`/`message` of JSON replies).
// The core emits `server.*` keys and the reply carries the text of the request's
// language; plugins still use the older catalogs keyed by the Portuguese sentence,
// which must keep working and keep pt-BR byte for byte.
//
// run: node mensagens-i18n.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extraiMensagens, traduzMensagem, traduzResposta, idiomaDaRequisicao, serverMessages, FONTES_MENSAGENS } from './web/mensagens-i18n.mjs';
import { fatiaJs } from './web/site-i18n.mjs';

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
const core = serverMessages();

// ── 0. the core emits keys, and every key it emits has a text ─────────────────────
// A new `fail(res, 400, 'Some sentence.')` would reach every language in Portuguese,
// and a key missing from the catalog would show the raw key on screen.
t('core files emit no literal sentence', () => {
  const frases = extraiMensagens(fonte);
  if (frases.length) throw new Error(`sentence instead of a server.* key: ${JSON.stringify(frases.slice(0, 5))}`);
});

t('every server.* key in the core exists in en and pt-BR', () => {
  const chaves = new Set(fatiaJs(fonte).filter((p) => p.tipo === 'string').map((p) => fonte.slice(p.ini + 1, p.fim - 1)).filter((s) => /^server\.[a-z0-9_]+$/.test(s)));
  if (chaves.size < 100) throw new Error(`only ${chaves.size} keys found: the scan is broken`);
  for (const k of chaves) for (const idioma of ['en', 'pt-BR']) {
    if (!core.i18n.has(k, idioma)) throw new Error(`${k} has no ${idioma} text`);
  }
});

t('a key becomes the text of the language, with brand and support filled in', () => {
  const pt = core.i18n.t('server.invalid_action', 'pt-BR');
  eq(traduzResposta({ error: 'server.invalid_action' }, 'pt-BR', core).error, pt);
  eq(traduzResposta({ error: 'server.invalid_action' }, 'en', core).error, core.i18n.t('server.invalid_action', 'en'));
  const out = JSON.stringify(['en', 'pt-BR', 'es'].map((l) => traduzResposta({ error: 'server.account_deleted', message: 'server.too_many_attempts' }, l, core)));
  if (/\{brand\}|\{support\}|__MARCA__|__SUPORTE__/.test(out)) throw new Error(`placeholder left in ${out}`);
});

t('a core sentence that arrives as text (an error message) is translated through its key', () => {
  const pt = core.i18n.t('server.invalid_action', 'pt-BR');
  eq(traduzResposta({ error: pt }, 'en', core).error, core.i18n.t('server.invalid_action', 'en'));
  eq(traduzResposta({ error: pt }, 'pt-BR', core).error, pt);
});

// The rest covers the older mechanism plugins use: a catalog keyed by the sentence.
const catalogos = {
  en: { 'Faça login.': 'Log in.', 'Escolha um arquivo.': 'Pick a file.' },
  es: { 'Faça login.': 'Inicia sesión.' },
};
const legado = { ...core, legacy: catalogos };
const mensagens = Object.keys(catalogos.en);

// ── 1. pt-BR doesn't change a byte ───────────────────────────────────────────────
t('pt-BR returns the SAME string', () => {
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
    if (traduzResposta(obj, idioma, legado) !== obj) throw new Error(`copiou o objeto em ${JSON.stringify(idioma)}`);
  }
});

t('unknown language does not translate and does not copy', () => {
  const obj = { error: 'Faça login.' };
  eq(traduzResposta(obj, 'de', legado), obj, 'German has no catalog, the same object should come out');
  eq(traduzMensagem('Faça login.', 'de', catalogos), 'Faça login.', 'German has no catalog');
});

// ── 2. only `error` and `message`, nothing else ────────────────────────────────────
t('translates error and message and does not touch the rest', () => {
  const pt = 'Faça login.';
  const obj = { ok: false, error: pt, id: 'abc', queued: true, credits: 10 };
  const saida = traduzResposta(obj, 'en', legado);
  eq(saida.error, catalogos.en[pt], 'error should have been translated');
  for (const campo of ['ok', 'id', 'queued', 'credits']) eq(saida[campo], obj[campo], `${campo} was changed`);
  eq(Object.keys(saida).join(','), Object.keys(obj).join(','), 'the set or order of keys changed');
  eq(obj.error, pt, 'the ORIGINAL object was mutated');
});

t('a field that is not a string passes through untouched', () => {
  const obj = { error: { code: 42 }, message: 7 };
  eq(traduzResposta(obj, 'en', legado), obj, 'an object with no translatable string should come out as the same reference');
});

t('not an object: returns as it came', () => {
  for (const v of [null, undefined, 'texto', 42, true]) eq(traduzResposta(v, 'en', legado), v, `changed ${JSON.stringify(v)}`);
});

// ── 3. machine code never turns into a translated sentence ─────────────────────────
// Translating `locked` or `bad_request` wouldn't make the screen ugly: it would leave the
// client comparing against a value that changed language.
t('machine code is left as it is', () => {
  for (const idioma of ['en', 'es']) {
    for (const codigo of ['locked', 'no_agent', 'bad_request', 'unauthorized', 'rate_limited']) {
      eq(traduzResposta({ error: codigo }, idioma, legado).error, codigo, `${idioma} changed ${codigo}`);
    }
  }
});

t('extraction does not pick up a template nor a literal with escape', () => {
  const achados = extraiMensagens("fail(res, 400, `Oi ${nome}.`);\nfail(res, 400, 'Não deu, tenta d\\'novo.');\nfail(res, 400, 'locked');");
  eq(achados.length, 0, `extracted ${JSON.stringify(achados)}`);
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


console.log(`\n${ok} ok, ${falhas} falhas`);
process.exit(falhas ? 1 : 0);
