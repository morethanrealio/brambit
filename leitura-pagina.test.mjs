import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PAGE_CHARS, recortarPagina } from './web/websearch.mjs';

// O teto de leitura de página era 6.000 caracteres. A página da quaresma de São
// Miguel (de uma rotina real) tem ~15.000: chegava ao modelo cortada no meio
// da ladainha, e sem nenhum aviso de que tinha sido cortada. O teto agora é o
// mesmo do PDF (20.000) e o corte, quando acontece, é declarado.

test('teto de página é o mesmo do PDF', () => {
  assert.equal(MAX_PAGE_CHARS, 20000);
});

test('página comum passa inteira e sem aviso de corte', () => {
  const texto = 'a'.repeat(15000);
  const { corpo, corte } = recortarPagina(texto);
  assert.equal(corpo.length, 15000);
  assert.equal(corte, '');
});

test('página maior que o teto é cortada e o corte é declarado', () => {
  const { corpo, corte } = recortarPagina('b'.repeat(25000));
  assert.equal(corpo.length, MAX_PAGE_CHARS);
  assert.match(corte, /mostrando o começo/);
});

test('entrada vazia ou ausente não quebra', () => {
  assert.deepEqual(recortarPagina(''), { corpo: '', corte: '' });
  assert.deepEqual(recortarPagina(undefined), { corpo: '', corte: '' });
});
