// Testes do i18n do bloco de fontes e do aviso de link quebrado (web/links.mjs).
//
// O que este arquivo prova, na ordem de importância:
//  1. o bloco de fontes preserva a tradução e os títulos (é o único idioma que existe na
//     base, então qualquer diferença aqui seria regressão pra todo mundo);
//  2. em en/es o rótulo e o aviso saem traduzidos; links quebrados são retirados;
//  3. o bloco não é anexado quando o texto já traz a lista, nos três idiomas
//     (o modelo escreve "Sources:"/"Fuentes:" quando responde em outra língua).
//
// A conferência de link é isolada: `FONTES_LINKS` não entra aqui e nenhum teste
// depende de rede. Os que exercitam o aviso de 404 simulam respostas HTTP.
//
// rodar: node links-i18n.test.mjs

import { blocoDeFontes, fontesEConferencia } from './web/links.mjs';
// Somente fixtures; nenhuma chamada sai desta função.
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

// Fontes já com URL direta: `resolveGroundingUri` devolve a própria URL quando
// ela não é redirect do vertexaisearch, então nada aqui toca a rede.
const FONTES = [
  { title: 'Banco Central', uri: 'https://www.bcb.gov.br/' },
  { title: 'IBGE', uri: 'https://www.ibge.gov.br/' },
];

// ── 1. pt-BR não muda um byte ───────────────────────────────────────────────
await t('bloco de fontes em pt-BR é o texto de sempre', async () => {
  const esperado = 'Fontes:\n[1] Banco Central — https://www.bcb.gov.br/\n[2] IBGE — https://www.ibge.gov.br/';
  eq(await blocoDeFontes(FONTES, 'pt-BR'), esperado, 'pt-BR explícito');
  eq(await blocoDeFontes(FONTES, undefined), esperado, 'sem idioma (chamada antiga)');
  eq(await blocoDeFontes(FONTES, 'fr'), esperado, 'idioma que não atendemos cai em pt-BR');
});

await t('texto sem fonte e sem link sai intocado em pt-BR', async () => {
  const r = await fontesEConferencia('Bom dia.', [], { mostrarFontes: false, language: 'pt-BR' });
  eq(r.texto, 'Bom dia.');
  eq(r.fontes, 0);
});

// ── 2. en/es traduzem rótulo e aviso, e não encostam na URL ─────────────────
await t('rótulo do bloco traduz em en e es', async () => {
  eq((await blocoDeFontes(FONTES, 'en')).split('\n')[0], 'Sources:');
  eq((await blocoDeFontes(FONTES, 'es')).split('\n')[0], 'Fuentes:');
  eq((await blocoDeFontes(FONTES, 'en-US')).split('\n')[0], 'Sources:', 'en-US normaliza pra en');
});

await t('URL e título sobrevivem à tradução', async () => {
  for (const idioma of ['pt-BR', 'en', 'es']) {
    const b = await blocoDeFontes(FONTES, idioma);
    if (!b.includes('[1] Banco Central — https://www.bcb.gov.br/')) throw new Error(`${idioma} mexeu na linha da fonte: ${b}`);
  }
});

// Exercita o verificador real com HTTP simulado (inclui confirmação GET).
await t('link removido e aviso traduzido nos três idiomas', async () => {
  for (const [language, fragment] of [['pt-BR', 'Removi 2 links'], ['en', 'I removed 2 links'], ['es', 'Quité 2 enlaces']]) {
    const text = '• https://broken.example.invalid/' + language + '/a\n• https://broken.example.invalid/' + language + '/b';
    const r = await fontesEConferencia(text, [], {language});
    eq(r.quebrados.length, 2);
    if (!r.texto.includes(fragment)) throw Error('aviso/plural não traduzido');
    if (r.texto.includes('https://broken.example.invalid')) throw Error('link quebrado entregue');
  }
});

// ── 3. lista que o modelo já escreveu não vira lista dobrada ────────────────
await t('não anexa fontes quando o texto já traz a lista, nos três idiomas', async () => {
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
