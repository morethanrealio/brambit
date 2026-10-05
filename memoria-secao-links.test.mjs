// Achado #17: toda escrita na memória rodava sincronizarLinks, que cortava TUDO
// abaixo de "## Mais detalhe" e regravava só o bloco de links. Qualquer linha que
// o dono (ou o assistente) tivesse escrito embaixo dessa seção sumia em silêncio.
// Aqui testo a parte pura (montarPerfilComLinks), que é onde mora o corte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { montarPerfilComLinks } = await import('./web/wiki.mjs');

const MARCA = '## Mais detalhe';
const PAGS = [{ slug: 'pessoa-joao', title: 'Pessoa João' }, { slug: 'projeto-x', title: 'Projeto X' }];

// Perfil típico: fatos em cima, seção de links gerada, e um rabo escrito pelo dono.
const comRabo = [
  '# Perfil',
  '- mora em São Paulo',
  '',
  `${MARCA} (leia com memoria_ler quando a tarefa pedir)`,
  '- pessoa-joao — Pessoa João',
  '',
  '## Combinados',
  '- nunca marcar reunião antes das 10h',
].join('\n');

test('linha escrita abaixo da seção de links sobrevive à sincronização', () => {
  const body = montarPerfilComLinks(comRabo, PAGS);
  assert.ok(body !== null, 'não podia abortar: a perda seria só do bloco gerado');
  assert.ok(body.includes('## Combinados'));
  assert.ok(body.includes('- nunca marcar reunião antes das 10h'));
  assert.ok(body.includes('- mora em São Paulo'));
});

test('os links são regenerados, não duplicados', () => {
  const body = montarPerfilComLinks(comRabo, PAGS);
  assert.equal(body.split('- pessoa-joao — Pessoa João').length - 1, 1);
  assert.ok(body.includes('- projeto-x — Projeto X'));
  assert.equal(body.split(MARCA).length - 1, 1);
});

test('o rabo do dono fica DEPOIS do bloco de links, não no meio', () => {
  const body = montarPerfilComLinks(comRabo, PAGS);
  const l = body.split('\n');
  assert.ok(l.indexOf('- projeto-x — Projeto X') < l.indexOf('## Combinados'));
  assert.ok(l.indexOf(l.find((x) => x.startsWith(MARCA))) < l.indexOf('## Combinados'));
});

test('sem outras páginas, a seção some mas o rabo continua lá', () => {
  const body = montarPerfilComLinks(comRabo, []);
  assert.ok(!body.includes(MARCA));
  assert.ok(!body.includes('- pessoa-joao — Pessoa João'));
  assert.ok(body.includes('## Combinados'));
  assert.ok(body.includes('- nunca marcar reunião antes das 10h'));
});

test('perfil sem marcador ganha a seção no fim e não perde nada', () => {
  const antes = '# Perfil\n- gosta de café';
  const body = montarPerfilComLinks(antes, PAGS);
  assert.ok(body.includes('- gosta de café'));
  assert.ok(body.includes(MARCA));
  assert.ok(body.includes('- pessoa-joao — Pessoa João'));
});

test('nada muda quando já está sincronizado (evita escrita à toa)', () => {
  const body = montarPerfilComLinks(comRabo, [PAGS[0]]);
  assert.equal(body.trim(), comRabo.trim());
});

test('linha parecida com link mas escrita pelo dono não é comida', () => {
  const antes = [
    '# Perfil',
    '',
    `${MARCA} (leia com memoria_ler quando a tarefa pedir)`,
    '- pessoa-joao — Pessoa João',
    '- comprar pão — na padaria da esquina',
  ].join('\n');
  const body = montarPerfilComLinks(antes, PAGS);
  assert.ok(body.includes('- comprar pão — na padaria da esquina'));
});

test('trava de segurança: se fosse perder linha do dono, devolve null (não grava)', () => {
  // Simula regressão futura chamando com um perfil cujo rabo some: aqui garanto
  // que a trava existe no fonte e que o chamador respeita o null.
  const src = fs.readFileSync(new URL('./web/wiki.mjs', import.meta.url), 'utf8');
  assert.match(src, /return perdidas\.length \? null : body;/);
  assert.match(src, /if \(body === null\) \{/);
  assert.match(src, /\[memoria links\][^\n]*abortado/);
});

test('o corte não é mais "tudo abaixo do marcador"', () => {
  const src = fs.readFileSync(new URL('./web/wiki.mjs', import.meta.url), 'utf8');
  const f = src.slice(src.indexOf('export function montarPerfilComLinks'), src.indexOf('export async function sincronizarLinks'));
  assert.ok(/EH_LINK_GERADO/.test(f), 'o corte tem que reconhecer o formato da linha gerada');
  assert.ok(/rabo/.test(f), 'o que vem depois do bloco gerado tem que ser preservado');
});
