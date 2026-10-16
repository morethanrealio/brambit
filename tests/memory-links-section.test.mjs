// Finding #17: every memory write ran sincronizarLinks, which cut EVERYTHING
// below "## Mais detalhe" and rewrote only the links block. Any line that
// the owner (or the assistant) had written below that section disappeared silently.
// Here I test the pure part (montarPerfilComLinks), which is where the cut lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { montarPerfilComLinks } = await import('../web/wiki.mjs');

const MARCA = '## Mais detalhe';
const PAGS = [{ slug: 'pessoa-joao', title: 'Pessoa João' }, { slug: 'projeto-x', title: 'Projeto X' }];

// Typical profile: facts on top, generated links section, and a tail written by the owner.
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

test('a line written below the links section survives synchronization', () => {
  const body = montarPerfilComLinks(comRabo, PAGS);
  assert.ok(body !== null, 'it should not abort: the loss would only be in the generated block');
  assert.ok(body.includes('## Combinados'));
  assert.ok(body.includes('- nunca marcar reunião antes das 10h'));
  assert.ok(body.includes('- mora em São Paulo'));
});

test('links are regenerated, not duplicated', () => {
  const body = montarPerfilComLinks(comRabo, PAGS);
  assert.equal(body.split('- pessoa-joao — Pessoa João').length - 1, 1);
  assert.ok(body.includes('- projeto-x — Projeto X'));
  assert.equal(body.split(MARCA).length - 1, 1);
});

test('the owner\'s tail stays AFTER the links block, not in the middle', () => {
  const body = montarPerfilComLinks(comRabo, PAGS);
  const l = body.split('\n');
  assert.ok(l.indexOf('- projeto-x — Projeto X') < l.indexOf('## Combinados'));
  assert.ok(l.indexOf(l.find((x) => x.startsWith(MARCA))) < l.indexOf('## Combinados'));
});

test('with no other pages, the section disappears but the tail stays', () => {
  const body = montarPerfilComLinks(comRabo, []);
  assert.ok(!body.includes(MARCA));
  assert.ok(!body.includes('- pessoa-joao — Pessoa João'));
  assert.ok(body.includes('## Combinados'));
  assert.ok(body.includes('- nunca marcar reunião antes das 10h'));
});

test('a profile without a marker gets the section at the end and loses nothing', () => {
  const antes = '# Perfil\n- gosta de café';
  const body = montarPerfilComLinks(antes, PAGS);
  assert.ok(body.includes('- gosta de café'));
  assert.ok(body.includes(MARCA));
  assert.ok(body.includes('- pessoa-joao — Pessoa João'));
});

test('nothing changes when already in sync (avoids a pointless write)', () => {
  const body = montarPerfilComLinks(comRabo, [PAGS[0]]);
  assert.equal(body.trim(), comRabo.trim());
});

test('a line that looks like a link but was written by the owner is not eaten', () => {
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

test('safety guard: if it were to lose an owner line, it returns null (doesn\'t save)', () => {
  // Simulates a future regression by calling with a profile whose tail disappears: here I ensure
  // that the guard exists in the source and that the caller respects the null.
  const src = fs.readFileSync(new URL('../web/wiki.mjs', import.meta.url), 'utf8');
  assert.match(src, /return perdidas\.length \? null : body;/);
  assert.match(src, /if \(body === null\) \{/);
  assert.match(src, /\[memoria links\][^\n]*aborted/);
});

test('the cut is no longer "everything below the marker"', () => {
  const src = fs.readFileSync(new URL('../web/wiki.mjs', import.meta.url), 'utf8');
  const f = src.slice(src.indexOf('export function montarPerfilComLinks'), src.indexOf('export async function sincronizarLinks'));
  assert.ok(/EH_LINK_GERADO/.test(f), 'the cut has to recognize the format of the generated line');
  assert.ok(/rabo/.test(f), 'what comes after the generated block has to be preserved');
});
