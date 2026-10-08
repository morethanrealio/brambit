// These cases check the Portuguese texts not yet in the catalogs, on an instance whose default is pt-BR.
process.env.BRAMBIT_DEFAULT_LANGUAGE = 'pt-BR';
// i18n tests for the sources block and the broken-link notice (web/links.mjs).
//
// What this file proves, in order of importance:
//  1. the sources block preserves the translation and the titles (it's the only language that exists in the
//     base, so any difference here would be a regression for everyone);
//  2. in en/es the label and the notice come out translated; broken links are removed;
//  3. the block is not appended when the text already carries the list, in all three languages
//     (the model writes "Sources:"/"Fuentes:" when it replies in another language).
//
// Link verification is isolated: `FONTES_LINKS` is not part of this and no test
// depends on the network. The ones that exercise the 404 notice simulate HTTP responses.
//
// run: node tests/links-i18n.test.mjs

import { blocoDeFontes, fontesEConferencia } from '../web/links.mjs';
// Fixtures only; no call leaves this function.
globalThis.fetch = async (url, opts) => {
  const host = new URL(url).hostname;
  if (!['broken.example.invalid', 'www.bcb.gov.br', 'www.ibge.gov.br'].includes(host)) throw Error('Unexpected URL');
  const status = host === 'broken.example.invalid' ? 404 : 200;
  return {ok:status === 200,status,body:{cancel:async()=>{}}};
};

let ok = 0, falhas = 0;
const t = async (nome, fn) => {
  try { await fn(); ok++; }
  catch (e) { falhas++; console.error(`FALHOU: ${nome}\n  ${e.message}`); }
};
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg || 'diferente'}\n  esperado: ${JSON.stringify(b)}\n  obtido:   ${JSON.stringify(a)}`);
};

// Sources already with a direct URL: `resolveGroundingUri` returns the URL itself when
// it's not a vertexaisearch redirect, so nothing here touches the network.
const FONTES = [
  { title: 'Banco Central', uri: 'https://www.bcb.gov.br/' },
  { title: 'IBGE', uri: 'https://www.ibge.gov.br/' },
];

// ── 1. pt-BR doesn't change a byte ───────────────────────────────────────────────
await t('pt-BR sources block is the usual text', async () => {
  const esperado = 'Fontes:\n[1] Banco Central — https://www.bcb.gov.br/\n[2] IBGE — https://www.ibge.gov.br/';
  eq(await blocoDeFontes(FONTES, 'pt-BR'), esperado, 'explicit pt-BR');
  eq(await blocoDeFontes(FONTES, undefined), esperado, 'no language (old call)');
  eq(await blocoDeFontes(FONTES, 'fr'), esperado, 'an unsupported language falls back to pt-BR');
});

await t('text with no source and no link comes out untouched in pt-BR', async () => {
  const r = await fontesEConferencia('Bom dia.', [], { mostrarFontes: false, language: 'pt-BR' });
  eq(r.texto, 'Bom dia.');
  eq(r.fontes, 0);
});

// ── 2. en/es translate label and notice, and don't touch the URL ─────────────────
await t('block label is translated in en and es', async () => {
  eq((await blocoDeFontes(FONTES, 'en')).split('\n')[0], 'Sources:');
  eq((await blocoDeFontes(FONTES, 'es')).split('\n')[0], 'Fuentes:');
  eq((await blocoDeFontes(FONTES, 'en-US')).split('\n')[0], 'Sources:', 'en-US normalizes to en');
});

await t('URL and title survive translation', async () => {
  for (const idioma of ['pt-BR', 'en', 'es']) {
    const b = await blocoDeFontes(FONTES, idioma);
    if (!b.includes('[1] Banco Central — https://www.bcb.gov.br/')) throw new Error(`${idioma} mexeu na linha da fonte: ${b}`);
  }
});

// Exercises the real checker with simulated HTTP (includes GET confirmation).
await t('removed link and notice translated in all three languages', async () => {
  for (const [language, fragment] of [['pt-BR', 'Removi 2 links'], ['en', 'I removed 2 links'], ['es', 'Quité 2 enlaces']]) {
    const text = '• https://broken.example.invalid/' + language + '/a\n• https://broken.example.invalid/' + language + '/b';
    const r = await fontesEConferencia(text, [], {language});
    eq(r.quebrados.length, 2);
    if (!r.texto.includes(fragment)) throw Error('aviso/plural não traduzido');
    if (r.texto.includes('https://broken.example.invalid')) throw Error('link quebrado entregue');
  }
});

// ── 3. a list the model already wrote doesn't turn into a doubled list ────────────────
await t('does not append sources when the text already has the list, in all three languages', async () => {
  const casos = [
    ['pt-BR', 'Resposta.\n\nFontes:\n[1] x — https://www.bcb.gov.br/'],
    ['en', 'Answer.\n\nSources:\n[1] x — https://www.bcb.gov.br/'],
    ['es', 'Respuesta.\n\nFuentes:\n[1] x — https://www.bcb.gov.br/'],
  ];
  for (const [idioma, texto] of casos) {
    const r = await fontesEConferencia(texto, FONTES, { mostrarFontes: true, language: idioma });
    eq(r.fontes, 0, `${idioma} deveria pular o bloco`);
    if (r.texto.split(/fontes:|sources:|fuentes:/i).length > 2) throw new Error(`${idioma} dobrou a lista:\n${r.texto}`);
  }
});

console.log(`\n${ok} ok, ${falhas} falhas`);
process.exit(falhas ? 1 : 0);
